import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import {
  initializeCase,
  populations,
  workspaceInfo,
  resetCase,
} from "../src/datasets.js";
import { validatePopulation } from "../src/fixture-source.js";
import { Workspace, loadState } from "../src/workspace.js";
import { runCollections } from "../src/agent.js";
import { provider, response, tool, json, options } from "./provider.js";

for (const population of populations()) {
  test(`private ${population.id} init/read/reset preserves source authority and previous evidence`, () => {
    const root = mkdtempSync(join(tmpdir(), "collections-case-")),
      file = join(root, "state.json"),
      fresh = join(root, "reset.json");
    const init = initializeCase(file, population.id);
    const w = new Workspace(file);
    assert.equal(
      workspaceInfo(file, w.snapshot().state).originalSeedMatch,
      true,
    );
    assert.equal(
      w.list(population.asOf).length,
      population.state.receivables.length,
    );
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(`${file}.source.json`).mode & 0o777, 0o600);
    const bytes = readFileSync(file),
      metadata = readFileSync(`${file}.source.json`);
    assert.throws(() => initializeCase(file, population.id), /exists/);
    const reset = resetCase(file, fresh, loadState(file));
    assert.notEqual(reset.instanceId, init.instanceId);
    assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(readFileSync(`${file}.source.json`), metadata);
    assert.equal(
      workspaceInfo(fresh, loadState(fresh)).originalSeedMatch,
      true,
    );
  });
  test(`actual native tools qualify ${population.id} with fixture identity outside context`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "collections-case-native-")),
      file = join(root, "state.json");
    initializeCase(file, population.id);
    const w = new Workspace(file);
    const target = population.task.match(/AR-\d+/)?.[0] ?? "AR-201";
    const p = await provider(t, (n, body, res) => {
      let item: any;
      if (n === 1) item = tool("listReceivables", {}, n);
      if (n === 2) item = tool("prepareFollowup", { receivableId: target }, n);
      if (n === 3) {
        const result = JSON.parse(
          body.input
            .filter((x: any) => x.type === "function_call_output")
            .at(-1).output,
        );
        if (result.ok) {
          if (population.id === "payment-race") w.recordPayment(target, 25000);
          if (population.id === "crm-race")
            w.setInstructions(
              "C-101",
              "do_not_contact",
              null,
              "Dispute arrived; stop outreach.",
            );
          item = tool("sendFollowup", { draftId: result.data.id }, n);
        }
      }
      json(res, response(n, item ? [item] : undefined));
    });
    const r = await runCollections({
      ...options(file, p.baseURL),
      task: population.task,
      asOf: population.asOf,
    });
    const state = loadState(file);
    const expectedBlocked = [
      "payment-race",
      "crm-race",
      "conflicting-instructions",
      "promise-day",
      "due-day",
      "already-contacted",
    ].includes(population.id);
    assert.equal(
      state.outbox.length,
      population.state.outbox.length + (expectedBlocked ? 0 : 1),
    );
    assert.equal(r.executionStatus, "completed");
    assert.ok(!JSON.stringify(p.requests).includes('"dataset"'));
    assert.ok(
      !JSON.stringify(p.requests).includes(
        "fictional_imported_receivables_snapshot",
      ),
    );
    if (population.id === "one-cent")
      assert.match(state.outbox[0].body, /0\.01 CAD/);
    if (population.id === "maximum-safe-cents")
      assert.match(state.outbox[0].body, /90071992547409\.91 CAD/);
  });
}
test("dataset history reconciles exact balances and refuses false dates/payments", () => {
  const original = populations()[0];
  for (const field of ["amount", "date", "reference", "duplicate"]) {
    const p = structuredClone(original);
    if (field === "amount") p.history[0].originalCents++;
    if (field === "date") p.history[0].issuedOn = "2026-11-01";
    if (field === "reference") p.history[0].receivableId = "missing";
    if (field === "duplicate")
      p.history[1].receivableId = p.history[0].receivableId;
    assert.throws(() => validatePopulation(p));
  }
  const busy = populations().find((x) => x.profile === "busy")!;
  assert.equal(busy.state.customers.length, 16);
  assert.equal(busy.state.receivables.length, 64);
  assert.equal(busy.provenance.priorModelEvidence, null);
});
test("valid human edits differ from original seed and reset keeps current state; missing/corrupt authority is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "collections-edit-")),
    file = join(root, "state.json");
  initializeCase(file);
  const w = new Workspace(file);
  w.recordPayment("AR-201", 5000);
  const before = readFileSync(file);
  assert.equal(workspaceInfo(file, loadState(file)).originalSeedMatch, false);
  resetCase(file, join(root, "fresh.json"), loadState(file));
  assert.deepEqual(readFileSync(file), before);
  rmSync(`${file}.source.json`);
  assert.throws(() => w.list("2026-10-15"));
  assert.deepEqual(readFileSync(file), before);
  assert.throws(() => new Workspace(file));
});
test("source metadata cannot borrow another case or workspace identity", () => {
  const root = mkdtempSync(join(tmpdir(), "collections-bind-")),
    a = join(root, "a.json"),
    b = join(root, "b.json");
  initializeCase(a);
  initializeCase(b, "one-cent");
  copyFileSync(`${b}.source.json`, `${a}.source.json`);
  assert.throws(() => new Workspace(a), /identity differs/);
});
