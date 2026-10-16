import { z } from "zod";

export const identifier = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (v) => !!v.trim() && !/[\x00-\x1f\x7f]/.test(v),
    "invalid identifier",
  );
export const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !!v.trim(), "must not be blank");
export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  }, "invalid calendar date");
export const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const line = (max: number) =>
  text(max).refine((v) => !/[\x00-\x1f\x7f]/.test(v), "must be a single line");
export const customerSchema = z.strictObject({
  id: identifier,
  name: line(160),
  ap_email: z
    .string()
    .max(254)
    .regex(
      /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.example$/,
    ),
  contact_policy: z.enum(["email_ap_only", "do_not_contact"]),
  promise_until: day.nullable(),
  instructions: z.string().max(8000),
  revision,
});
export const receivableSchema = z.strictObject({
  id: identifier,
  customer_id: identifier,
  invoice_number: line(100),
  due_on: day,
  currency: z.enum(["CAD", "USD", "GBP", "EUR"]),
  balance_cents: cents,
  revision,
});
export const draftSchema = z.strictObject({
  id: identifier,
  request_id: identifier,
  receivable_id: identifier,
  customer_revision: revision,
  receivable_revision: revision,
  to: z.string(),
  subject: text(300),
  body: text(12000),
  prepared_on: day,
  source: z.strictObject({
    customer: customerSchema,
    receivable: receivableSchema,
  }),
});
export const sentSchema = z.strictObject({
  id: identifier,
  draft_id: identifier,
  request_id: identifier,
  to: z.string(),
  subject: text(300),
  body: text(12000),
});
export const stateSchema = z.strictObject({
  synthetic: z.literal(true),
  version: z.literal(1),
  instance_id: z.string().uuid().optional(),
  dataset: z
    .strictObject({
      id: z.literal("collections-populations"),
      version: z.literal("1.0.0"),
      case_id: identifier,
      source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  requests: z
    .array(
      z.strictObject({
        id: identifier,
        task_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        as_of: day,
      }),
    )
    .max(4000)
    .optional(),
  customers: z.array(customerSchema).min(1).max(128),
  receivables: z.array(receivableSchema).min(1).max(1000),
  drafts: z.array(draftSchema).max(4000),
  outbox: z.array(sentSchema).max(1000),
  audit: z
    .array(
      z.strictObject({
        action: z.enum(["prepare", "send", "payment", "crm_change"]),
        target: identifier,
        outcome: identifier,
      }),
    )
    .max(16000),
});
export type Customer = z.infer<typeof customerSchema>;
export type Receivable = z.infer<typeof receivableSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Sent = z.infer<typeof sentSchema>;
export type State = z.infer<typeof stateSchema>;
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function amount(value: number, currency: Receivable["currency"]) {
  const n = BigInt(value);
  return `${n / 100n}.${String(n % 100n).padStart(2, "0")} ${currency}`;
}
export function message(invoice: Receivable, customer: Customer) {
  return {
    to: customer.ap_email,
    subject: `Accounts payable follow-up: ${invoice.invoice_number}`,
    body: `Hello ${customer.name} accounts payable team,\n\nOur records show invoice ${invoice.invoice_number} has an outstanding balance of ${amount(invoice.balance_cents, invoice.currency)}, due ${invoice.due_on}. Please let us know if payment is already in progress or if our records need correction.\n\nThank you,\nAccounts Receivable`,
  };
}
export function eligible(
  invoice: Receivable,
  customer: Customer,
  asOf: string,
): string | null {
  if (invoice.balance_cents <= 0) return "already_paid";
  if (invoice.due_on >= asOf) return "not_overdue";
  if (customer.contact_policy === "do_not_contact") return "do_not_contact";
  if (customer.promise_until && customer.promise_until >= asOf)
    return "promise_to_pay_hold";
  return null;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function validateState(value: unknown): State {
  const state = stateSchema.parse(value);
  const unique = (values: string[], name: string) => {
    if (new Set(values).size !== values.length)
      throw new Error(`duplicate ${name}`);
  };
  for (const [name, rows] of [
    ["customer", state.customers],
    ["receivable", state.receivables],
    ["draft", state.drafts],
    ["outbox", state.outbox],
  ] as const)
    unique(
      rows.map((x) => x.id),
      name,
    );
  unique(
    (state.requests ?? []).map((x) => x.id),
    "run request",
  );
  unique(
    state.drafts.map((x) => x.request_id),
    "draft request",
  );
  unique(
    state.outbox.map((x) => x.request_id),
    "send request",
  );
  unique(
    state.outbox.map((x) => x.draft_id),
    "sent draft",
  );
  const customers = new Map(state.customers.map((x) => [x.id, x])),
    invoices = new Map(state.receivables.map((x) => [x.id, x])),
    drafts = new Map(state.drafts.map((x) => [x.id, x]));
  if (state.receivables.some((x) => !customers.has(x.customer_id)))
    throw new Error("orphan receivable customer");
  unique(
    state.receivables.map((x) =>
      JSON.stringify([x.customer_id, x.invoice_number]),
    ),
    "customer invoice number",
  );
  for (const d of state.drafts) {
    const { customer: c, receivable: i } = d.source;
    if (
      !invoices.has(d.receivable_id) ||
      c.id !== i.customer_id ||
      i.id !== d.receivable_id ||
      c.revision !== d.customer_revision ||
      i.revision !== d.receivable_revision ||
      eligible(i, c, d.prepared_on)
    )
      throw new Error("invalid draft source authority");
    if (!same(message(i, c), { to: d.to, subject: d.subject, body: d.body }))
      throw new Error("draft message differs from fixed source");
  }
  for (const s of state.outbox) {
    const d = drafts.get(s.draft_id);
    if (
      !d ||
      !same(
        { to: d.to, subject: d.subject, body: d.body },
        { to: s.to, subject: s.subject, body: s.body },
      )
    )
      throw new Error("outbox differs from its draft");
  }
  unique(
    state.outbox.map((x) => drafts.get(x.draft_id)!.receivable_id),
    "contacted receivable",
  );
  for (const a of state.audit) {
    if (
      !(a.action === "crm_change"
        ? customers.has(a.target)
        : a.action === "send"
          ? drafts.has(a.target)
          : invoices.has(a.target))
    )
      throw new Error("orphan audit target");
  }
  return state;
}
