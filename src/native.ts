import { createOpenAI } from "@ai-sdk/openai";
import { Agent as HTTPAgent, fetch as httpFetch } from "undici";
import { z } from "zod";
import { identifier } from "./schema.js";
import { parseJSON, type Workspace } from "./workspace.js";
import { Receipt, sha256, usageOf, errorInfo } from "./evidence.js";

export const REQUEST_LIMIT = 8;
export const OUTPUT_LIMIT = 2048;
const toolArguments = {
  listReceivables: z.strictObject({}),
  prepareFollowup: z.strictObject({ receivableId: identifier }),
  sendFollowup: z.strictObject({ draftId: identifier }),
};
export type NativeOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export function config(options: NativeOptions) {
  if (!/^openai\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.model))
    throw new Error("model must use openai/<model> format");
  const key = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key || !/^[\x21-\x7e]{1,4096}$/.test(key))
    throw new Error("OPENAI_API_KEY required; no model fallback");
  const url = new URL(options.baseURL ?? "https://api.openai.com/v1");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "endpoint requires HTTPS or owned loopback HTTP, without credentials/query/fragment",
    );
  return {
    key,
    baseURL: url.href.replace(/\/$/, ""),
    modelId: options.model.slice(7),
  };
}
function object(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function nonblank(v: unknown): v is string {
  return typeof v === "string" && !!v.trim() && v.length <= 240;
}
export class Native {
  readonly dispatcher = new HTTPAgent({
    connect: { timeout: 30_000 },
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
    connections: 1,
    pipelining: 1,
  });
  readonly calls = new Set<string>();
  closed = false;
  constructor(
    readonly options: NativeOptions,
    readonly receipt: Receipt,
    readonly workspace: Workspace,
    readonly signal: AbortSignal,
    readonly deadline: number,
  ) {}
  guard() {
    if (this.receipt.recordingError) throw this.receipt.recordingError;
    this.signal.throwIfAborted();
    if (performance.now() >= this.deadline)
      throw new Error("collections operation deadline exceeded");
    this.workspace.snapshot();
    this.signal.throwIfAborted();
    if (performance.now() >= this.deadline)
      throw new Error("collections operation deadline exceeded");
  }
  model() {
    const c = config(this.options);
    const ownedFetch: typeof globalThis.fetch = async (input, init) => {
      this.guard();
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.href !== `${c.baseURL}/responses` || init?.method !== "POST")
        throw new Error("unqualified provider request");
      if (this.receipt.data.calls.length >= REQUEST_LIMIT)
        throw new Error("prepared provider request budget exhausted");
      const requestBody = String(init?.body ?? "");
      if (Buffer.byteLength(requestBody) > 2_097_152)
        throw new Error("provider request exceeds decoded size limit");
      const request: any = parseJSON(requestBody);
      if (
        request.stream ||
        request.model !== c.modelId ||
        request.max_output_tokens !== OUTPUT_LIMIT
      )
        throw new Error("unqualified native request settings");
      const call: Record<string, any> = {
        number: this.receipt.data.calls.length + 1,
        status: "prepared",
        preparedAt: new Date().toISOString(),
        method: "POST",
        endpointOrigin: url.origin,
        path: url.pathname,
        requestSha256: sha256(requestBody),
        requestBytes: Buffer.byteLength(requestBody),
        requestedModel: c.modelId,
        reportedUsage: usageOf(null),
      };
      this.receipt.data.calls.push(call);
      this.receipt.save();
      this.guard();
      const phase = AbortSignal.timeout(
        Math.min(
          30_000,
          Math.max(1, Math.ceil(this.deadline - performance.now())),
        ),
      );
      const signal = AbortSignal.any([
        this.signal,
        phase,
        ...(init?.signal ? [init.signal] : []),
      ]);
      try {
        call.dispatchedAt = new Date().toISOString();
        call.status = "dispatched";
        this.receipt.save();
        this.guard();
        const response = await httpFetch(url, {
          method: "POST",
          body: requestBody,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${c.key}`,
          },
          dispatcher: this.dispatcher,
          signal,
          redirect: "manual",
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let count = 0;
        try {
          if (reader)
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              count += next.value.length;
              if (count > 1_048_576) {
                await reader.cancel();
                throw new Error(
                  "provider decoded response exceeds retained limit",
                );
              }
              chunks.push(next.value);
            }
        } finally {
          reader?.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        call.response = {
          status: response.status,
          contentType: response.headers.get("content-type"),
          requestId: response.headers.get("x-request-id"),
          bytes: bytes.length,
          bodyBase64: bytes.toString("base64"),
          bodySha256: sha256(bytes),
          body: null,
        };
        let body: unknown;
        try {
          body = parseJSON(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch (e) {
          call.parseError = errorInfo(e);
          this.receipt.save();
          throw e;
        }
        call.response.body = body;
        call.reportedUsage = usageOf(body);
        call.status = "received";
        this.receipt.save();
        this.guard();
        if (response.status !== 200)
          throw new Error(`provider HTTP ${response.status}`);
        call.accepted = this.validate(body);
        call.status = "accepted";
        call.finishedAt = new Date().toISOString();
        this.receipt.save();
        this.guard();
        return new Response(bytes, {
          status: response.status,
          headers: {
            "content-type": "application/json",
            ...(response.headers.get("x-request-id")
              ? { "x-request-id": response.headers.get("x-request-id")! }
              : {}),
          },
        });
      } catch (e) {
        call.status = "failed";
        call.error = errorInfo(e);
        call.finishedAt = new Date().toISOString();
        try {
          this.receipt.save();
        } catch {}
        throw e;
      }
    };
    return createOpenAI({
      apiKey: c.key,
      baseURL: c.baseURL,
      fetch: ownedFetch,
    }).responses(c.modelId);
  }
  validate(body: unknown) {
    if (
      !object(body) ||
      !nonblank(body.id) ||
      !nonblank(body.model) ||
      body.status !== "completed" ||
      body.error ||
      body.incomplete_details ||
      !Array.isArray(body.output) ||
      !body.output.length ||
      body.output.length > 16
    )
      throw new Error(
        "provider response is not a coherent completed Responses result",
      );
    const calls: Record<string, any>[] = [];
    let answer = "";
    for (const item of body.output) {
      if (!object(item)) throw new Error("invalid provider output item");
      if (item.type === "function_call") {
        if (
          item.status !== "completed" ||
          !nonblank(item.id) ||
          !nonblank(item.call_id) ||
          !nonblank(item.name) ||
          !Object.hasOwn(toolArguments, item.name) ||
          typeof item.arguments !== "string"
        )
          throw new Error("invalid provider function call");
        calls.push(item);
      } else if (item.type === "message") {
        if (
          item.status !== "completed" ||
          item.role !== "assistant" ||
          !Array.isArray(item.content) ||
          !item.content.length
        )
          throw new Error("unfinished assistant message");
        for (const part of item.content) {
          if (
            !object(part) ||
            part.type !== "output_text" ||
            typeof part.text !== "string"
          )
            throw new Error("unsupported/refused provider content");
          answer += part.text;
        }
      } else if (item.type === "reasoning") {
        if (item.status && item.status !== "completed")
          throw new Error("unfinished reasoning");
      } else throw new Error("unsupported provider output item");
    }
    if (calls.length) {
      if (
        calls.length !== 1 ||
        answer.trim() ||
        this.receipt.data.calls.length >= REQUEST_LIMIT
      )
        throw new Error("parallel/mixed or budget-exhausted tool response");
      const call = calls[0];
      if (this.calls.has(call.call_id))
        throw new Error("replayed provider call ID");
      const args = toolArguments[call.name as keyof typeof toolArguments].parse(
        parseJSON(call.arguments),
      );
      this.calls.add(call.call_id);
      return { kind: "tool", id: call.call_id, name: call.name, args };
    }
    if (!answer.trim())
      throw new Error("provider response has no completed answer");
    return { kind: "answer", text: answer };
  }
  async close() {
    if (this.closed) throw new Error("native transport already closed");
    this.closed = true;
    await this.dispatcher.destroy();
  }
}
