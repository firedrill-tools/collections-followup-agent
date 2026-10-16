import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { copyFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { Workspace } from "../src/workspace.js";
export function tool(name: string, args: unknown, n: number) {
  return {
    id: `fc-${n}`,
    type: "function_call",
    status: "completed",
    call_id: `call-${n}`,
    name,
    arguments: JSON.stringify(args),
  };
}
export function response(n: number, output?: any[]) {
  return {
    id: `resp-${n}`,
    object: "response",
    created_at: 1700000000,
    model: "controlled-openai",
    status: "completed",
    output: output ?? [
      {
        id: `msg-${n}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Reviewed the local synthetic outbox.",
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    unknown_original: { observed: true },
  };
}
export async function provider(
  t: TestContext,
  handler: (n: number, body: any, res: ServerResponse) => void,
) {
  const requests: any[] = [],
    headers: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let b = "";
      for await (const part of req) b += part;
      const body = JSON.parse(b);
      requests.push(body);
      headers.push(req.headers);
      handler(requests.length, body, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests, headers };
}
export function setup() {
  const root = mkdtempSync(join(tmpdir(), "collections-native-")),
    file = join(root, "state.json");
  copyFileSync(
    resolve(import.meta.dirname, "../../fixtures/starter.json"),
    file,
  );
  return { root, file, w: new Workspace(file) };
}
export const options = (file: string, baseURL: string) => ({
  statePath: file,
  task: "Follow up overdue AR-201 if allowed",
  requestId: "native-owned",
  asOf: "2026-10-15",
  allowWrites: true,
  model: "openai/controlled",
  apiKey: "synthetic-controlled-key",
  baseURL,
});
export function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-request-id": "controlled-request",
  });
  res.end(JSON.stringify(body));
}
