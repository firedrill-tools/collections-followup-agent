import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { provider, response, setup, json, tool } from "./provider.js";
import { loadState } from "../src/workspace.js";
const cli = resolve(import.meta.dirname, "../src/cli.js");
function start(args: string[], env = process.env) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: tmpdir(),
    env: {
      ...env,
      OPENAI_API_KEY: "synthetic-cli-key",
      COLLECTIONS_MODEL: "openai/controlled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((r, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => r({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
const runArgs = (file: string, baseURL: string) => [
  "run",
  "--state",
  file,
  "--task",
  "Review receivables",
  "--as-of",
  "2026-10-15",
  "--live",
  "--max-provider-requests",
  "8",
  "--base-url",
  baseURL,
];
test("CLI initializes privately outside checkout, refuses overwrite and dry-plans without a key or state edit", async () => {
  const file = join(
    mkdtempSync(join(tmpdir(), "collections-cli-")),
    "state.json",
  );
  const init = await start(["init", "--state", file]).done;
  assert.equal(init.code, 0, init.stderr);
  const original = readFileSync(file);
  assert.ok(loadState(file).instance_id);
  const again = await start(["init", "--state", file]).done;
  assert.equal(again.code, 1);
  assert.deepEqual(readFileSync(file), original);
  const plan = await start([
    "run",
    "--state",
    file,
    "--task",
    "Review receivables",
  ]).done;
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).executionStatus, "plan");
  assert.deepEqual(readFileSync(file), original);
});
test("normal CLI runs actual native HTTP and prints one clean completed JSON document", async (t) => {
  const { file } = setup();
  const p = await provider(t, (n, _body, res) =>
    json(
      res,
      response(n, n === 1 ? [tool("listReceivables", {}, n)] : undefined),
    ),
  );
  const result = await start(runArgs(file, p.baseURL)).done;
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.executionStatus, "completed");
  assert.equal(p.requests.length, 2);
  assert.equal(
    JSON.parse(readFileSync(output.receiptPath, "utf8")).cleanupConfirmed,
    true,
  );
});
test("CLI missing credentials retains zero-attempt failed receipt and unknown usage", async (t) => {
  const { file } = setup();
  const p = await provider(t, () => assert.fail("must not call"));
  const child = spawn(process.execPath, [cli, ...runArgs(file, p.baseURL)], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      COLLECTIONS_MODEL: "openai/controlled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.executionStatus, "failed");
  assert.equal(parsed.reportedUsage.preparedAttempts, 0);
  assert.equal(parsed.reportedUsage.input.value, null);
  assert.equal(p.requests.length, 0);
});
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)
  test(`CLI ${signal} drains its pending HTTP and records partial failure`, async (t) => {
    const { file } = setup();
    let seen!: () => void;
    const pending = new Promise<void>((r) => (seen = r));
    const p = await provider(t, () => seen());
    const run = start(runArgs(file, p.baseURL));
    await pending;
    run.child.kill(signal);
    const result = await run.done;
    assert.equal(result.code, code, result.stderr);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout);
    assert.equal(output.executionStatus, "failed");
    assert.equal(output.cleanupConfirmed, true);
    assert.equal(p.requests.length, 1);
    assert.equal(loadState(file).outbox.length, 0);
  });
test("CLI refuses duplicate flags and inadequate request budgets before provider access", async (t) => {
  const { file } = setup();
  const p = await provider(t, () => assert.fail("no calls"));
  for (const args of [
    [...runArgs(file, p.baseURL), "--state", file],
    [
      "run",
      "--state",
      file,
      "--task",
      "x",
      "--live",
      "--max-provider-requests",
      "1",
    ],
    ["list", "--state", file, "--unknown"],
  ]) {
    const r = await start(args).done;
    assert.equal(r.code, 1);
  }
  assert.equal(p.requests.length, 0);
});
