import {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
export const sha256 = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export const errorInfo = (v: unknown) => {
  const chain: { name: string; message: string }[] = [];
  const seen = new Set<unknown>();
  let current = v;
  while (current && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push({
      name: current instanceof Error ? current.name : "Error",
      message: current instanceof Error ? current.message : String(current),
    });
    current = current instanceof Error ? current.cause : null;
  }
  return chain;
};
export type Measurement =
  | { status: "observed"; value: number }
  | { status: "unknown" | "invalid"; value: null };
export function counter(usage: unknown, name: string): Measurement {
  if (!usage || typeof usage !== "object" || !Object.hasOwn(usage, name))
    return { status: "unknown", value: null };
  const v: unknown = Reflect.get(usage, name);
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? { status: "observed", value: v }
    : { status: "invalid", value: null };
}
export function usageOf(body: unknown) {
  const usage =
    body && typeof body === "object" ? Reflect.get(body, "usage") : null;
  return {
    input: counter(usage, "input_tokens"),
    output: counter(usage, "output_tokens"),
    total: counter(usage, "total_tokens"),
    cachedInput: counter(
      usage && typeof usage === "object"
        ? Reflect.get(usage, "input_tokens_details")
        : null,
      "cached_tokens",
    ),
    reasoningOutput: counter(
      usage && typeof usage === "object"
        ? Reflect.get(usage, "output_tokens_details")
        : null,
      "reasoning_tokens",
    ),
  };
}
export function summarize(
  calls: { reportedUsage?: ReturnType<typeof usageOf> }[],
) {
  const result: Record<string, unknown> = {};
  for (const key of [
    "input",
    "output",
    "total",
    "cachedInput",
    "reasoningOutput",
  ] as const) {
    const rows = calls.map(
      (c) => c.reportedUsage?.[key] ?? { status: "unknown", value: null },
    );
    const values = rows
      .filter((x) => x.status === "observed")
      .map((x) => x.value!);
    const subtotal = values.reduce((a, b) => a + BigInt(b), 0n);
    const safe = subtotal <= BigInt(Number.MAX_SAFE_INTEGER);
    result[key] = {
      value:
        rows.length && values.length === rows.length && safe
          ? Number(subtotal)
          : null,
      knownSubtotal: safe ? Number(subtotal) : null,
      observed: values.length,
      unknown: rows.filter((x) => x.status === "unknown").length,
      invalid: rows.filter((x) => x.status === "invalid").length,
      complete: rows.length > 0 && values.length === rows.length && safe,
    };
  }
  return {
    source: "original Responses JSON counters; no estimation or billing proof",
    preparedAttempts: calls.length,
    ...result,
    costUsd: null,
  };
}

export class Receipt {
  readonly path: string;
  readonly data: Record<string, any>;
  recordingError: unknown;
  constructor(outputRoot: string, initial: Record<string, unknown>) {
    const root = resolve(outputRoot);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      throw new Error("invalid receipt root");
    const runId = randomUUID(),
      dir = join(root, runId);
    mkdirSync(dir, { mode: 0o700 });
    this.path = join(dir, "receipt.json");
    this.data = {
      schemaVersion: 1,
      runId,
      receiptPath: this.path,
      status: "prepared",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      calls: [],
      actions: [],
      result: null,
      error: null,
      cleanupConfirmed: false,
      ...initial,
    };
    this.save();
  }
  save() {
    if (this.recordingError) throw this.recordingError;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(this.data, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      const fd2 = openSync(resolve(this.path, ".."), "r");
      try {
        fsyncSync(fd2);
      } finally {
        closeSync(fd2);
      }
    } catch (e) {
      this.recordingError = e;
      this.data.recordingFailed = true;
      throw e;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
