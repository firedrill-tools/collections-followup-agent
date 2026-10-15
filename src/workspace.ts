import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

type Customer = { id: string; name: string; ap_email: string; contact_policy: "email_ap_only" | "do_not_contact"; promise_until: string | null; instructions: string; revision: number };
type Receivable = { id: string; customer_id: string; invoice_number: string; due_on: string; currency: string; balance_cents: number; revision: number };
type Draft = { id: string; request_id: string; receivable_id: string; customer_revision: number; receivable_revision: number; to: string; subject: string; body: string; prepared_on: string };
type Sent = { id: string; draft_id: string; request_id: string; to: string; subject: string; body: string };
export type State = { synthetic: true; version: 1; customers: Customer[]; receivables: Receivable[]; drafts: Draft[]; outbox: Sent[]; audit: { action: string; target: string; outcome: string }[] };
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function loadState(file: string): State {
  const state: State = JSON.parse(readFileSync(file, "utf8"));
  if (state.synthetic !== true || state.version !== 1 || !Array.isArray(state.customers) || !Array.isArray(state.receivables) || !Array.isArray(state.outbox)) throw new Error("Only version 1 synthetic collections state is supported");
  return state;
}
function saveState(file: string, state: State) {
  const temp = join(dirname(file), `.collections-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
}
function eligible(invoice: Receivable, customer: Customer, asOf: string): string | null {
  if (invoice.balance_cents <= 0) return "already_paid";
  if (invoice.due_on >= asOf) return "not_overdue";
  if (customer.contact_policy === "do_not_contact") return "do_not_contact";
  if (customer.promise_until && customer.promise_until >= asOf) return "promise_to_pay_hold";
  if (!customer.ap_email.endsWith(".example")) return "non_synthetic_address";
  return null;
}

export class Workspace {
  constructor(private readonly file: string) { loadState(file); }
  list(asOf: string) {
    const state = loadState(this.file);
    return state.receivables.map((invoice) => {
      const customer = state.customers.find((item) => item.id === invoice.customer_id)!;
      return { ...invoice, customer_name: customer.name, ap_email: customer.ap_email, instructions: customer.instructions,
        eligibility: eligible(invoice, customer, asOf) ?? "eligible" };
    });
  }
  prepare(receivableId: string, requestId: string, asOf: string): Result<Draft> {
    const state = loadState(this.file);
    const existing = state.drafts.find((draft) => draft.request_id === requestId);
    if (existing) return existing.receivable_id === receivableId ? { ok: true, data: existing } : { ok: false, error: "request_id_conflict" };
    const invoice = state.receivables.find((item) => item.id === receivableId);
    if (!invoice) return { ok: false, error: "receivable_not_found" };
    const customer = state.customers.find((item) => item.id === invoice.customer_id);
    if (!customer) return { ok: false, error: "customer_not_found" };
    const block = eligible(invoice, customer, asOf);
    if (block) return { ok: false, error: block };
    if (state.outbox.some((message) => state.drafts.find((draft) => draft.id === message.draft_id)?.receivable_id === receivableId)) return { ok: false, error: "already_contacted" };
    const amount = `${(invoice.balance_cents / 100).toFixed(2)} ${invoice.currency}`;
    const draft: Draft = { id: `D-${state.drafts.length + 1}`, request_id: requestId, receivable_id: receivableId,
      customer_revision: customer.revision, receivable_revision: invoice.revision, to: customer.ap_email,
      subject: `Accounts payable follow-up: ${invoice.invoice_number}`,
      body: `Hello ${customer.name} accounts payable team,\n\nOur records show invoice ${invoice.invoice_number} has an outstanding balance of ${amount}, due ${invoice.due_on}. Please let us know if payment is already in progress or if our records need correction.\n\nThank you,\nAccounts Receivable`,
      prepared_on: asOf };
    state.drafts.push(draft);
    state.audit.push({ action: "prepare", target: receivableId, outcome: "success" });
    saveState(this.file, state);
    return { ok: true, data: draft };
  }
  send(draftId: string, requestId: string, asOf: string): Result<Sent> {
    const state = loadState(this.file);
    const duplicate = state.outbox.find((message) => message.request_id === requestId);
    if (duplicate) return duplicate.draft_id === draftId ? { ok: true, data: duplicate } : { ok: false, error: "request_id_conflict" };
    const draft = state.drafts.find((item) => item.id === draftId);
    if (!draft) return { ok: false, error: "draft_not_found" };
    if (state.outbox.some((message) => message.draft_id === draftId)) return { ok: false, error: "already_sent" };
    const invoice = state.receivables.find((item) => item.id === draft.receivable_id)!;
    const customer = state.customers.find((item) => item.id === invoice.customer_id)!;
    const block = eligible(invoice, customer, asOf) || (invoice.revision !== draft.receivable_revision || customer.revision !== draft.customer_revision ? "stale_draft" : null);
    if (block) {
      state.audit.push({ action: "send", target: draftId, outcome: block }); saveState(this.file, state);
      return { ok: false, error: block };
    }
    const message: Sent = { id: `M-${state.outbox.length + 1}`, draft_id: draftId, request_id: requestId, to: draft.to, subject: draft.subject, body: draft.body };
    state.outbox.push(message);
    state.audit.push({ action: "send", target: draftId, outcome: "success" });
    saveState(this.file, state);
    return { ok: true, data: message };
  }
  recordPayment(receivableId: string, cents: number): Result<Receivable> {
    const state = loadState(this.file);
    const invoice = state.receivables.find((item) => item.id === receivableId);
    if (!invoice) return { ok: false, error: "receivable_not_found" };
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > invoice.balance_cents) return { ok: false, error: "invalid_payment" };
    invoice.balance_cents -= cents; invoice.revision++;
    state.audit.push({ action: "payment", target: receivableId, outcome: "success" });
    saveState(this.file, state);
    return { ok: true, data: invoice };
  }
  setInstructions(customerId: string, policy: Customer["contact_policy"], promiseUntil: string | null, instructions: string): Result<Customer> {
    const state = loadState(this.file);
    const customer = state.customers.find((item) => item.id === customerId);
    if (!customer) return { ok: false, error: "customer_not_found" };
    customer.contact_policy = policy; customer.promise_until = promiseUntil; customer.instructions = instructions; customer.revision++;
    state.audit.push({ action: "crm_change", target: customerId, outcome: "success" });
    saveState(this.file, state);
    return { ok: true, data: customer };
  }
}
