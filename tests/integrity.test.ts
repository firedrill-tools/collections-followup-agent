import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  Workspace,
  loadState,
  parseJSON,
  validateState,
} from "../src/workspace.js";
import { amount } from "../src/schema.js";
const asOf = "2026-10-15";
function setup() {
  const file = join(
    mkdtempSync(join(tmpdir(), "collections-integrity-")),
    "workspace.json",
  );
  copyFileSync(
    resolve(import.meta.dirname, "../../fixtures/starter.json"),
    file,
  );
  return { file, w: new Workspace(file) };
}

test("tampered persisted draft is rejected without outbox write or repair", () => {
  for (const field of ["to", "subject", "body"] as const) {
    const { file, w } = setup();
    const d = w.prepare("AR-201", "p", asOf);
    assert.ok(d.ok);
    const s = loadState(file);
    s.drafts[0][field] =
      field === "to" ? "wrong@other.example" : "Altered demand";
    writeFileSync(file, JSON.stringify(s));
    const before = readFileSync(file);
    assert.throws(() => w.send(d.data.id, "s", asOf), /draft message differs/);
    assert.deepEqual(readFileSync(file), before);
  }
});
test("two prepared drafts cannot send two follow-ups for one invoice", () => {
  const { file, w } = setup();
  const a = w.prepare("AR-201", "a", asOf),
    b = w.prepare("AR-201", "b", asOf);
  assert.ok(a.ok && b.ok);
  assert.ok(w.send(a.data.id, "a", asOf).ok);
  assert.deepEqual(w.send(b.data.id, "b", asOf), {
    ok: false,
    error: "already_contacted",
  });
  assert.equal(loadState(file).outbox.length, 1);
  assert.equal(w.list(asOf)[0].eligibility, "already_contacted");
});
test("same-revision invoice and CRM changes cannot dispatch old source", () => {
  for (const field of [
    "balance",
    "address",
    "instruction",
    "customer",
    "due",
  ]) {
    const { file, w } = setup();
    const d = w.prepare("AR-201", "p", asOf);
    assert.ok(d.ok);
    const s = loadState(file);
    if (field === "balance") s.receivables[0].balance_cents -= 1;
    if (field === "address") s.customers[0].ap_email = "new@willow.example";
    if (field === "instruction")
      s.customers[0].instructions = "Use the new bank reference";
    if (field === "customer") s.receivables[0].customer_id = "C-102";
    if (field === "due") s.receivables[0].due_on = "2026-09-29";
    writeFileSync(file, JSON.stringify(s));
    assert.equal(w.send(d.data.id, "s", asOf).ok, false);
    assert.equal(loadState(file).outbox.length, 0);
  }
});
test("dates, cents, contact enums, duplicates, source references and unknown fields are strict", () => {
  const { file, w } = setup(),
    original = loadState(file);
  const mutations = [
    (s: any) => {
      s.receivables[0].balance_cents = 0.5;
    },
    (s: any) => {
      s.receivables[0].balance_cents = Number.MAX_SAFE_INTEGER + 1;
    },
    (s: any) => {
      s.receivables[0].revision = true;
    },
    (s: any) => {
      s.receivables[0].due_on = "2026-02-30";
    },
    (s: any) => {
      s.customers[0].contact_policy = "allow";
    },
    (s: any) => {
      s.customers[0].promise_until = "2026-13-01";
    },
    (s: any) => {
      s.customers[0].ap_email = "ap@real.invalid";
    },
    (s: any) => {
      s.customers.push(s.customers[0]);
    },
    (s: any) => {
      s.receivables[0].customer_id = "missing";
    },
    (s: any) => {
      s.extra = true;
    },
    (s: any) => {
      s.customers[0].ap_email = "ap@a.example\nBcc:x@b.example";
    },
    (s: any) => {
      s.receivables[0].currency = "JPY";
    },
  ];
  for (const mutate of mutations) {
    const s = structuredClone(original);
    mutate(s);
    assert.throws(() => validateState(s));
  }
  assert.throws(() => w.prepare("AR-201", "p", "2026-02-30"));
  assert.throws(() => w.list(""));
  assert.throws(
    () => parseJSON('{"balance":0,"balance":1}'),
    /duplicate JSON key/,
  );
  assert.throws(() => parseJSON('{"n":1e999}'), /nonfinite/);
});
test("promise/day and date-before-draft checks preserve boundaries", () => {
  const { w } = setup();
  assert.deepEqual(w.prepare("AR-202", "p", "2026-10-20"), {
    ok: false,
    error: "promise_to_pay_hold",
  });
  assert.ok(w.prepare("AR-202", "q", "2026-10-21").ok);
  const d = w.prepare("AR-201", "r", asOf);
  assert.ok(d.ok);
  assert.deepEqual(w.send(d.data.id, "s", "2026-10-14"), {
    ok: false,
    error: "date_before_draft",
  });
});
test("amount formatting retains exact maximum-safe and one-cent values", () => {
  assert.equal(amount(Number.MAX_SAFE_INTEGER, "CAD"), "90071992547409.91 CAD");
  assert.equal(amount(1, "EUR"), "0.01 EUR");
});
test("revision exhaustion, malformed customer edits and changed request bindings leave source intact", () => {
  const { file, w } = setup();
  assert.deepEqual(w.setInstructions("C-101", "allow" as never, null, "x"), {
    ok: false,
    error: "invalid_customer_instruction",
  });
  w.prepare("AR-201", "a", asOf);
  const before = readFileSync(file);
  assert.deepEqual(w.prepare("AR-202", "a", asOf), {
    ok: false,
    error: "request_id_conflict",
  });
  assert.deepEqual(readFileSync(file), before);
  const s = loadState(file);
  s.receivables[0].revision = Number.MAX_SAFE_INTEGER;
  s.customers[0].revision = Number.MAX_SAFE_INTEGER;
  writeFileSync(file, JSON.stringify(s));
  assert.equal(w.recordPayment("AR-201", 1).ok, false);
  assert.deepEqual(w.setInstructions("C-101", "do_not_contact", null, "Stop"), {
    ok: false,
    error: "revision_exhausted",
  });
});
test("new workspace instance fences stale owners and symlink input is refused", () => {
  const { file } = setup();
  const s = loadState(file);
  s.instance_id = randomUUID();
  writeFileSync(file, JSON.stringify(s));
  const w = new Workspace(file);
  s.instance_id = randomUUID();
  writeFileSync(file, JSON.stringify(s));
  assert.throws(() => w.prepare("AR-201", "p", asOf), /instance changed/);
  const link = `${file}.link`;
  symlinkSync(file, link);
  assert.throws(() => new Workspace(link), /regular file/);
});
async function concurrent(file: string, expr: string) {
  const url = new URL("../src/workspace.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {Workspace} from ${JSON.stringify(url)}; const w=new Workspace(${JSON.stringify(file)}); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{try{console.log(JSON.stringify(${expr}))}catch(e){console.error(e);process.exitCode=1}})`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let out = "",
    err = "";
  const ready = new Promise<void>((r) =>
    child.stdout.on("data", (b) => {
      out += b;
      if (out.includes("ready\n")) r();
    }),
  );
  child.stderr.on("data", (b) => (err += b));
  const done = new Promise<any>((r, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(err));
      else {
        try {
          r(JSON.parse(out.split("\n").filter(Boolean).at(-1)!));
        } catch (e) {
          reject(e);
        }
      }
    });
  });
  await ready;
  return { child, done };
}
test("independent processes preserve simultaneous payments and exclude duplicate invoice sends", async () => {
  const { file, w } = setup();
  const a = await concurrent(file, 'w.recordPayment("AR-201",1000)'),
    b = await concurrent(file, 'w.recordPayment("AR-201",1000)');
  a.child.stdin.end("go");
  b.child.stdin.end("go");
  assert.ok((await a.done).ok);
  assert.ok((await b.done).ok);
  assert.equal(loadState(file).receivables[0].balance_cents, 23000);
  const d1 = w.prepare("AR-201", "a", asOf),
    d2 = w.prepare("AR-201", "b", asOf);
  assert.ok(d1.ok && d2.ok);
  const x = await concurrent(
      file,
      `w.send(${JSON.stringify(d1.data.id)},"a",${JSON.stringify(asOf)})`,
    ),
    y = await concurrent(
      file,
      `w.send(${JSON.stringify(d2.data.id)},"b",${JSON.stringify(asOf)})`,
    );
  x.child.stdin.end("go");
  y.child.stdin.end("go");
  const results = await Promise.all([x.done, y.done]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(loadState(file).outbox.length, 1);
});
