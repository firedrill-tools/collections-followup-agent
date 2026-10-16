import {
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  fsyncSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  customerSchema,
  day,
  identifier,
  eligible,
  message,
  validateState,
  type Customer,
  type Draft,
  type Receivable,
  type Result,
  type Sent,
  type State,
} from "./schema.js";
import { authority } from "./datasets.js";
export { validateState } from "./schema.js";
export type { State, Result } from "./schema.js";

const MAX_BYTES = 8 * 1024 * 1024;
const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
function read(file: string) {
  const initial = lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_BYTES)
    throw new Error("state must be a bounded regular file");
  const fd = openSync(file, "r");
  try {
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd),
      current = lstatSync(file);
    if (
      bytes.length > MAX_BYTES ||
      before.dev !== initial.dev ||
      before.ino !== initial.ino ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size
    )
      throw new Error("state changed while reading");
    // Duplicate keys can change authority depending on parser; refuse them.
    const value = parseJSON(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return {
      state: validateState(value),
      digest: hash(bytes),
      identity: `${before.dev}:${before.ino}`,
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}
export function parseJSON(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (/[ \t\r\n]/.test(text[i] ?? "") && i < text.length) i++;
  };
  const str = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new Error("unterminated JSON string");
  };
  const value = (): unknown => {
    ws();
    if (text[i] === '"') return str();
    if (text[i] === "{") {
      i++;
      ws();
      const result: Record<string, unknown> = Object.create(null);
      if (text[i] === "}") {
        i++;
        return result;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error("invalid JSON key");
        const key = str();
        if (Object.hasOwn(result, key))
          throw new Error(`duplicate JSON key: ${key}`);
        ws();
        if (text[i++] !== ":") throw new Error("invalid JSON object");
        result[key] = value();
        ws();
        const sep = text[i++];
        if (sep === "}") return result;
        if (sep !== ",") throw new Error("invalid JSON object");
      }
    }
    if (text[i] === "[") {
      i++;
      ws();
      const result: unknown[] = [];
      if (text[i] === "]") {
        i++;
        return result;
      }
      for (;;) {
        result.push(value());
        ws();
        const sep = text[i++];
        if (sep === "]") return result;
        if (sep !== ",") throw new Error("invalid JSON array");
      }
    }
    const match =
      /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
    if (!match) throw new Error("invalid JSON value");
    i += match[0].length;
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed === "number" && !Number.isFinite(parsed))
      throw new Error("nonfinite JSON number");
    return parsed;
  };
  const parsed = value();
  ws();
  if (i !== text.length) throw new Error("trailing JSON data");
  return parsed;
}
export function loadState(file: string): State {
  return read(file).state;
}
function save(file: string, state: State, prior: ReturnType<typeof read>) {
  validateState(state);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (bytes.length > MAX_BYTES) throw new Error("state limit exceeded");
  const temp = join(dirname(file), `.collections-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const current = read(file);
    if (current.identity !== prior.identity || current.digest !== prior.digest)
      throw new Error("state changed before commit");
    renameSync(temp, file);
    const parent = openSync(dirname(file), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
const validRequest = (v: string) => identifier.safeParse(v).success;
const nextId = (prefix: string, rows: { id: string }[]) =>
  `${prefix}${randomUUID()}`;

/** Cooperating processes serialize each synchronous read/recheck/replace. The
 * persistent SQLite mutex is never unlinked/reaped and crash-releases its lock.
 * Uncooperative filesystem writers remain outside an OS security boundary. */
export class Workspace {
  private readonly file: string;
  private readonly instance: string | null;
  private readonly lock: string;
  constructor(file: string) {
    // Reject symlinks before resolving; no source repair or implicit migration.
    const source = read(file);
    authority(file, source.state);
    this.file = realpathSync(file);
    this.instance = source.state.instance_id ?? null;
    this.lock = join(
      dirname(this.file),
      `.${basename(this.file)}.collections-lock.sqlite`,
    );
  }
  private transaction<T>(
    fn: (state: State) => { result: T; dirty: boolean },
  ): T {
    const created = !existsSync(this.lock);
    if (
      !created &&
      (!lstatSync(this.lock).isFile() || lstatSync(this.lock).isSymbolicLink())
    )
      throw new Error("invalid workspace mutex");
    // Secure mode before SQLite opens, including the initial file.
    if (created) {
      try {
        closeSync(openSync(this.lock, "wx", 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const db = new DatabaseSync(this.lock);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const source = read(this.file);
      authority(this.file, source.state);
      if ((source.state.instance_id ?? null) !== this.instance)
        throw new Error("workspace instance changed");
      const { result, dirty } = fn(source.state);
      if (dirty) save(this.file, source.state, source);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      db.close();
    }
  }
  snapshot() {
    const s = read(this.file);
    authority(this.file, s.state);
    if ((s.state.instance_id ?? null) !== this.instance)
      throw new Error("workspace instance changed");
    return s;
  }
  beginRequest(
    id: string,
    task: string,
    asOf: string,
  ): Result<{ id: string; task_sha256: string; as_of: string }> {
    day.parse(asOf);
    if (
      !validRequest(id) ||
      typeof task !== "string" ||
      !task.trim() ||
      task.length > 8000
    )
      return { ok: false, error: "invalid_request" };
    return this.transaction((state) => {
      const expected = { id, task_sha256: hash(task), as_of: asOf },
        prior = state.requests?.find((x) => x.id === id);
      if (prior)
        return {
          result:
            JSON.stringify(expected) === JSON.stringify(prior)
              ? { ok: true as const, data: prior }
              : { ok: false as const, error: "request_id_conflict" },
          dirty: false,
        };
      (state.requests ??= []).push(expected);
      return { result: { ok: true as const, data: expected }, dirty: true };
    });
  }
  list(asOf: string) {
    day.parse(asOf);
    const state = this.snapshot().state;
    return state.receivables.map((invoice) => {
      const customer = state.customers.find(
        (c) => c.id === invoice.customer_id,
      )!;
      const sent = state.outbox.some(
        (s) =>
          state.drafts.find((d) => d.id === s.draft_id)!.receivable_id ===
          invoice.id,
      );
      return {
        ...invoice,
        customer_name: customer.name,
        ap_email: customer.ap_email,
        instructions: customer.instructions,
        eligibility:
          eligible(invoice, customer, asOf) ??
          (sent ? "already_contacted" : "eligible"),
      };
    });
  }
  prepare(
    receivableId: string,
    requestId: string,
    asOf: string,
  ): Result<Draft> {
    day.parse(asOf);
    if (!validRequest(requestId) || !validRequest(receivableId))
      return { ok: false, error: "invalid_request" };
    return this.transaction<Result<Draft>>((state) => {
      const finish = (result: Result<Draft>, dirty = false) => ({
        result,
        dirty,
      });
      const existing = state.drafts.find((d) => d.request_id === requestId);
      if (existing)
        return finish(
          existing.receivable_id === receivableId &&
            existing.prepared_on === asOf
            ? { ok: true, data: existing }
            : { ok: false, error: "request_id_conflict" },
        );
      const invoice = state.receivables.find((i) => i.id === receivableId);
      if (!invoice) return finish({ ok: false, error: "receivable_not_found" });
      const customer = state.customers.find(
        (c) => c.id === invoice.customer_id,
      )!;
      const block = eligible(invoice, customer, asOf);
      if (block) return finish({ ok: false, error: block });
      if (
        state.outbox.some(
          (s) =>
            state.drafts.find((d) => d.id === s.draft_id)!.receivable_id ===
            receivableId,
        )
      )
        return finish({ ok: false, error: "already_contacted" });
      const draft: Draft = {
        id: nextId("D-", state.drafts),
        request_id: requestId,
        receivable_id: receivableId,
        customer_revision: customer.revision,
        receivable_revision: invoice.revision,
        ...message(invoice, customer),
        prepared_on: asOf,
        source: {
          customer: structuredClone(customer),
          receivable: structuredClone(invoice),
        },
      };
      state.drafts.push(draft);
      state.audit.push({
        action: "prepare",
        target: receivableId,
        outcome: "success",
      });
      return finish({ ok: true, data: draft }, true);
    });
  }
  send(draftId: string, requestId: string, asOf: string): Result<Sent> {
    day.parse(asOf);
    if (!validRequest(requestId) || !validRequest(draftId))
      return { ok: false, error: "invalid_request" };
    return this.transaction<Result<Sent>>((state) => {
      const finish = (result: Result<Sent>, dirty = false) => ({
        result,
        dirty,
      });
      const duplicate = state.outbox.find((s) => s.request_id === requestId);
      if (duplicate)
        return finish(
          duplicate.draft_id === draftId
            ? { ok: true, data: duplicate }
            : { ok: false, error: "request_id_conflict" },
        );
      const draft = state.drafts.find((d) => d.id === draftId);
      if (!draft) return finish({ ok: false, error: "draft_not_found" });
      if (state.outbox.some((s) => s.draft_id === draftId))
        return finish({ ok: false, error: "already_sent" });
      if (
        state.outbox.some(
          (s) =>
            state.drafts.find((d) => d.id === s.draft_id)!.receivable_id ===
            draft.receivable_id,
        )
      )
        return finish({ ok: false, error: "already_contacted" });
      const invoice = state.receivables.find(
          (i) => i.id === draft.receivable_id,
        )!,
        customer = state.customers.find((c) => c.id === invoice.customer_id)!;
      const block =
        eligible(invoice, customer, asOf) ||
        (asOf < draft.prepared_on ? "date_before_draft" : null) ||
        (JSON.stringify(draft.source) !==
        JSON.stringify({ customer, receivable: invoice })
          ? "stale_draft"
          : null);
      if (block) {
        state.audit.push({ action: "send", target: draftId, outcome: block });
        return finish({ ok: false, error: block }, true);
      }
      const sent: Sent = {
        id: nextId("M-", state.outbox),
        draft_id: draftId,
        request_id: requestId,
        ...message(invoice, customer),
      };
      state.outbox.push(sent);
      state.audit.push({ action: "send", target: draftId, outcome: "success" });
      return finish({ ok: true, data: sent }, true);
    });
  }
  recordPayment(receivableId: string, value: number): Result<Receivable> {
    return this.transaction<Result<Receivable>>((state) => {
      const invoice = state.receivables.find((i) => i.id === receivableId);
      if (!invoice)
        return {
          result: { ok: false, error: "receivable_not_found" },
          dirty: false,
        };
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > invoice.balance_cents ||
        invoice.revision === Number.MAX_SAFE_INTEGER
      )
        return {
          result: { ok: false, error: "invalid_payment" },
          dirty: false,
        };
      invoice.balance_cents -= value;
      invoice.revision++;
      state.audit.push({
        action: "payment",
        target: receivableId,
        outcome: "success",
      });
      return { result: { ok: true, data: invoice }, dirty: true };
    });
  }
  setInstructions(
    customerId: string,
    policy: Customer["contact_policy"],
    promiseUntil: string | null,
    instructions: string,
  ): Result<Customer> {
    return this.transaction<Result<Customer>>((state) => {
      const customer = state.customers.find((c) => c.id === customerId);
      if (!customer)
        return {
          result: { ok: false, error: "customer_not_found" },
          dirty: false,
        };
      if (customer.revision === Number.MAX_SAFE_INTEGER)
        return {
          result: { ok: false, error: "revision_exhausted" },
          dirty: false,
        };
      const next = customerSchema.safeParse({
        ...customer,
        contact_policy: policy,
        promise_until: promiseUntil,
        instructions,
        revision: customer.revision + 1,
      });
      if (!next.success)
        return {
          result: { ok: false, error: "invalid_customer_instruction" },
          dirty: false,
        };
      Object.assign(customer, next.data);
      state.audit.push({
        action: "crm_change",
        target: customerId,
        outcome: "success",
      });
      return { result: { ok: true, data: customer }, dirty: true };
    });
  }
}
