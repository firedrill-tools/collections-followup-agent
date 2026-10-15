import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace, loadState } from "../src/workspace.js";
import { makeTools } from "../src/agent.js";

const asOf = "2026-10-15";
function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "collections-")), "workspace.json");
  copyFileSync(resolve(import.meta.dirname, "../../fixtures/starter.json"), file);
  return { file, workspace: new Workspace(file) };
}

test("eligibility combines overdue balance and CRM instructions", () => {
  const { workspace } = setup();
  assert.deepEqual(workspace.list(asOf).map((item) => item.eligibility), ["eligible", "promise_to_pay_hold", "do_not_contact", "not_overdue"]);
});

test("prepared draft delivers only once to the AP contact", () => {
  const { file, workspace } = setup();
  const draft = workspace.prepare("AR-201", "req:draft", asOf);
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  assert.equal(draft.data.to, "ap@willow.example");
  assert.match(draft.data.body, /250\.00 CAD/);
  assert.deepEqual(workspace.prepare("AR-201", "req:draft", asOf), draft);
  const sent = workspace.send(draft.data.id, "req:send", asOf);
  assert.equal(sent.ok, true);
  assert.deepEqual(workspace.send(draft.data.id, "req:send", asOf), sent);
  assert.equal(workspace.prepare("AR-201", "different:draft", asOf).ok, false);
  assert.equal(loadState(file).outbox.length, 1);
});

test("payment between prepare and send blocks stale balance", () => {
  const { file, workspace } = setup();
  const draft = workspace.prepare("AR-201", "pay:draft", asOf);
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  assert.equal(workspace.recordPayment("AR-201", 25000).ok, true);
  assert.deepEqual(workspace.send(draft.data.id, "pay:send", asOf), { ok: false, error: "already_paid" });
  assert.equal(loadState(file).outbox.length, 0);
});

test("partial payment and new do-not-contact instruction each block a draft", () => {
  const { file, workspace } = setup();
  const draft = workspace.prepare("AR-201", "partial:draft", asOf);
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  assert.equal(workspace.recordPayment("AR-201", 5000).ok, true);
  assert.deepEqual(workspace.send(draft.data.id, "partial:send", asOf), { ok: false, error: "stale_draft" });
  const second = workspace.prepare("AR-201", "policy:draft", asOf);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  workspace.setInstructions("C-101", "do_not_contact", null, "Stop outreach");
  assert.deepEqual(workspace.send(second.data.id, "policy:send", asOf), { ok: false, error: "do_not_contact" });
  assert.equal(loadState(file).outbox.length, 0);
});

test("promise holds, non-overdue items and invalid payments reject", () => {
  const { workspace } = setup();
  assert.deepEqual(workspace.prepare("AR-202", "promise", asOf), { ok: false, error: "promise_to_pay_hold" });
  assert.deepEqual(workspace.prepare("AR-204", "future", asOf), { ok: false, error: "not_overdue" });
  assert.deepEqual(workspace.recordPayment("AR-201", 999999), { ok: false, error: "invalid_payment" });
  assert.deepEqual(workspace.recordPayment("AR-201", 0), { ok: false, error: "invalid_payment" });
});

test("Mastra tools expose explicit write boundary", async () => {
  const { workspace } = setup();
  const readOnly = makeTools(workspace, "req", asOf, false);
  const result = await readOnly.prepareFollowup.execute!({ receivableId: "AR-201" }, {} as never);
  assert.deepEqual(result, { ok: false, error: "writes_not_authorized" });
});
