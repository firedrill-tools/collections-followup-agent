import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { runCollections, makeTools } from "../src/agent.js";
import { Workspace, loadState } from "../src/workspace.js";
import { Receipt } from "../src/evidence.js";
import { Native } from "../src/native.js";

import { tool, response, provider, setup, options, json } from "./provider.js";

const failure = async (f: Promise<any>) => {
  try {
    await f;
    assert.fail("expected native failure");
  } catch (e) {
    assert.ok(e instanceof Error);
    return e as Error & {
      evidence: any;
      receiptPath: string;
      recordingFailed: boolean;
    };
  }
};

test("actual Mastra/OpenAI Responses performs list, prepare, send and completed final over owned HTTP", async (t) => {
  const { file } = setup();
  const p = await provider(t, (n, body, res) => {
    let item: any;
    if (n === 1) item = tool("listReceivables", {}, n);
    if (n === 2) item = tool("prepareFollowup", { receivableId: "AR-201" }, n);
    if (n === 3) {
      const prior = body.input
        .filter((x: any) => x.type === "function_call_output")
        .at(-1);
      const output = JSON.parse(prior.output);
      item = tool("sendFollowup", { draftId: output.data.id }, n);
    }
    json(res, response(n, item ? [item] : undefined));
  });
  const result = await runCollections(options(file, p.baseURL));
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.outboxCount, 1);
  assert.equal(p.requests.length, 4);
  assert.ok(p.requests.every((x) => x.max_output_tokens === 2048 && !x.stream));
  assert.ok(
    p.headers.every(
      (h) =>
        h.authorization === "Bearer synthetic-controlled-key" &&
        !h["openai-organization"] &&
        !h["openai-project"],
    ),
  );
  const saved = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(saved.cleanupConfirmed, true);
  assert.equal(saved.calls[0].response.body.unknown_original.observed, true);
  assert.equal(saved.reportedUsage.input.value, 40);
  assert.equal(saved.reportedUsage.costUsd, null);
  assert.equal(statSync(result.receiptPath).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).includes("synthetic-controlled-key"));
  assert.ok(!JSON.stringify(p.requests).includes("native-owned"));
});
for (const kind of [
  "incomplete",
  "absent-status",
  "failed",
  "refused",
  "unfinished-tool",
  "wrong-tool",
  "unknown-args",
  "duplicate-args",
  "parallel",
  "mixed",
  "blank",
  "bad-json",
] as const)
  test(`raw ${kind} is retained and rejected before tool effects`, async (t) => {
    const { file } = setup();
    const p = await provider(t, (n, _body, res) => {
      const b: any = response(n, [
        tool("prepareFollowup", { receivableId: "AR-201" }, n),
      ]);
      if (kind === "incomplete") {
        b.status = "incomplete";
        b.incomplete_details = { reason: "max_output_tokens" };
      }
      if (kind === "absent-status") delete b.status;
      if (kind === "failed") b.error = { message: "controlled failure" };
      if (kind === "refused")
        b.output = [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "refusal", refusal: "No" }],
          },
        ];
      if (kind === "unfinished-tool") b.output[0].status = "in_progress";
      if (kind === "wrong-tool") b.output[0].name = "wirePayment";
      if (kind === "unknown-args")
        b.output[0].arguments = JSON.stringify({
          receivableId: "AR-201",
          to: "wrong@a.example",
        });
      if (kind === "duplicate-args")
        b.output[0].arguments =
          '{"receivableId":"AR-201","receivableId":"AR-202"}';
      if (kind === "parallel") b.output.push(tool("listReceivables", {}, 2));
      if (kind === "mixed") b.output.push(response(n).output[0]);
      if (kind === "blank") b.output = [];
      if (kind === "bad-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":');
        return;
      }
      json(res, b);
    });
    const e = await failure(runCollections(options(file, p.baseURL)));
    assert.equal(p.requests.length, 1);
    assert.equal(loadState(file).drafts.length, 0);
    assert.equal(loadState(file).outbox.length, 0);
    assert.equal(e.evidence.cleanupConfirmed, true);
    assert.ok(e.evidence.calls[0].response.bodyBase64);
    assert.equal(e.evidence.status, "failed");
  });
for (const usage of [
  undefined,
  { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  { input_tokens: 10, output_tokens: 2 },
  { input_tokens: -1, output_tokens: 2, total_tokens: 1 },
  { input_tokens: "10", output_tokens: 2, total_tokens: 12 },
])
  test(`raw usage distinction survives SDK normalization or rejection: ${JSON.stringify(usage)}`, async (t) => {
    const { file } = setup();
    const p = await provider(t, (n, _body, res) => {
      const b: any = response(n);
      if (usage === undefined) delete b.usage;
      else b.usage = usage;
      json(res, b);
    });
    let evidence: any;
    try {
      const r = await runCollections({
        ...options(file, p.baseURL),
        allowWrites: false,
      });
      evidence = JSON.parse(readFileSync(r.receiptPath, "utf8"));
    } catch (e: any) {
      evidence = e.evidence;
    }
    assert.equal(p.requests.length, 1);
    const m = evidence.calls[0].reportedUsage;
    assert.equal(
      m.input.status,
      usage === undefined
        ? "unknown"
        : typeof usage.input_tokens !== "number" || usage.input_tokens < 0
          ? "invalid"
          : "observed",
    );
    assert.equal(
      m.total.status,
      usage?.total_tokens === undefined ? "unknown" : "observed",
    );
    assert.equal(evidence.reportedUsage.costUsd, null);
    if (usage?.input_tokens === 0)
      assert.equal(evidence.reportedUsage.input.value, 0);
  });
test("provider failure after preparation keeps partial effects and original failed usage without retry", async (t) => {
  const { file } = setup();
  const p = await provider(t, (n, _body, res) =>
    json(
      res,
      n === 1
        ? response(n, [tool("listReceivables", {}, n)])
        : n === 2
          ? response(n, [
              tool("prepareFollowup", { receivableId: "AR-201" }, n),
            ])
          : {
              error: { message: "controlled unavailable" },
              usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
            },
      n === 3 ? 503 : 200,
    ),
  );
  const e = await failure(runCollections(options(file, p.baseURL)));
  assert.equal(p.requests.length, 3);
  assert.equal(loadState(file).drafts.length, 1);
  assert.equal(loadState(file).outbox.length, 0);
  assert.equal(e.evidence.reportedUsage.input.value, 23);
  assert.equal(e.evidence.calls[2].response.status, 503);
});
test("a payment between native prepare and send blocks outbox at final recheck", async (t) => {
  const { file, w } = setup();
  const p = await provider(t, (n, body, res) => {
    let item: any;
    if (n === 1) item = tool("listReceivables", {}, n);
    if (n === 2) item = tool("prepareFollowup", { receivableId: "AR-201" }, n);
    if (n === 3) {
      w.recordPayment("AR-201", 25000);
      const d = JSON.parse(
        body.input.filter((x: any) => x.type === "function_call_output").at(-1)
          .output,
      );
      item = tool("sendFollowup", { draftId: d.data.id }, n);
    }
    json(res, response(n, item ? [item] : undefined));
  });
  const r = await runCollections(options(file, p.baseURL));
  assert.equal(r.outboxCount, 0);
  const saved = JSON.parse(readFileSync(r.receiptPath, "utf8"));
  assert.equal(saved.actions[2].result.error, "already_paid");
});
for (const kind of ["cancel", "deadline"])
  test(`owned ${kind} aborts pending HTTP and leaves no outbox`, async (t) => {
    const { file } = setup(),
      control = new AbortController();
    let seen = false;
    const p = await provider(t, () => {
      seen = true;
      if (kind === "cancel")
        control.abort(new Error("controlled cancellation"));
    });
    const e = await failure(
      runCollections({
        ...options(file, p.baseURL),
        signal: control.signal,
        timeoutMs: kind === "deadline" ? 120 : 2000,
      }),
    );
    assert.equal(seen, true);
    assert.equal(e.evidence.cleanupConfirmed, true);
    assert.equal(p.requests.length, 1);
    assert.equal(loadState(file).outbox.length, 0);
  });
test("replayed provider call ID and per-run request exhaustion stop before further tool dispatch", async (t) => {
  for (const replay of [true, false]) {
    const { file } = setup();
    const p = await provider(t, (n, _body, res) =>
      json(res, response(n, [tool("listReceivables", {}, replay ? 1 : n)])),
    );
    const e = await failure(runCollections(options(file, p.baseURL)));
    assert.equal(p.requests.length, replay ? 2 : 8);
    assert.equal(e.evidence.actions.length, replay ? 1 : 7);
  }
});
test("source corruption during HTTP refuses tools and never repairs the changed file", async (t) => {
  const { file } = setup();
  const p = await provider(t, (n, _body, res) => {
    writeFileSync(file, '{"synthetic":false}');
    json(res, response(n, [tool("listReceivables", {}, n)]));
  });
  const e = await failure(runCollections(options(file, p.baseURL)));
  assert.equal(e.evidence.actions.length, 0);
  assert.equal(readFileSync(file, "utf8"), '{"synthetic":false}');
});
test("missing credential prepares a private failed receipt before any provider request", async (t) => {
  const { file } = setup();
  const p = await provider(t, () => assert.fail("no request"));
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const e = await failure(
      runCollections({ ...options(file, p.baseURL), apiKey: "" }),
    );
    assert.equal(e.evidence.calls.length, 0);
    assert.equal(e.evidence.reportedUsage.input.value, null);
    assert.equal(e.evidence.cleanupConfirmed, true);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
test("recording failure after a tool commit retains partial state and stops later calls", async (t) => {
  const { file } = setup();
  const p = await provider(t, (n, _body, res) =>
    json(
      res,
      response(n, [
        tool(
          n === 1 ? "listReceivables" : "prepareFollowup",
          n === 1 ? {} : { receivableId: "AR-201" },
          n,
        ),
      ]),
    ),
  );
  const original = Receipt.prototype.save;
  Receipt.prototype.save = function () {
    if (
      this.data.actions.some(
        (a: any) => a.name === "prepareFollowup" && a.status === "finished",
      )
    ) {
      this.recordingError = new Error("controlled recording failure");
      throw this.recordingError;
    }
    return original.call(this);
  };
  try {
    const e = await failure(runCollections(options(file, p.baseURL)));
    assert.equal(e.recordingFailed, true);
    assert.equal(e.evidence.status, "failed");
    assert.equal(e.evidence.cleanupConfirmed, true);
    assert.equal(p.requests.length, 2);
    assert.equal(loadState(file).drafts.length, 1);
  } finally {
    Receipt.prototype.save = original;
  }
});
test("failed cleanup cannot release a completed answer or turn true after second close", async (t) => {
  const { file } = setup();
  const p = await provider(t, (n, _body, res) => json(res, response(n)));
  const original = Native.prototype.close;
  Native.prototype.close = async function () {
    await original.call(this);
    throw new Error("controlled close failure");
  };
  try {
    const e = await failure(runCollections(options(file, p.baseURL)));
    assert.equal(e.evidence.cleanupConfirmed, false);
    assert.equal(e.evidence.status, "failed");
    assert.equal(e.evidence.result, null);
  } finally {
    Native.prototype.close = original;
  }
});
test("one request can prepare separate invoices and cannot send another request's draft", async () => {
  const { file, w } = setup();
  const s = loadState(file);
  s.receivables[3].due_on = "2026-09-30";
  writeFileSync(file, JSON.stringify(s));
  const tools = makeTools(w, "many", "2026-10-15", true);
  const a: any = await tools.prepareFollowup.execute!(
      { receivableId: "AR-201" },
      {} as never,
    ),
    b: any = await tools.prepareFollowup.execute!(
      { receivableId: "AR-204" },
      {} as never,
    );
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.data.id, b.data.id);
  const other = makeTools(w, "other", "2026-10-15", true);
  assert.deepEqual(
    await other.sendFollowup.execute!({ draftId: a.data.id }, {} as never),
    { ok: false, error: "draft_not_owned_by_request" },
  );
});
