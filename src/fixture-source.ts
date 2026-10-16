import { z } from "zod";
import { day, identifier, cents, validateState, type State } from "./schema.js";
const schema = z.strictObject({
  id: identifier,
  profile: z.enum(["starter", "busy", "ambiguous", "boundary"]),
  asOf: day,
  task: z.string().min(1).max(8000),
  state: z.unknown(),
  history: z
    .array(
      z.strictObject({
        receivableId: identifier,
        issuedOn: day,
        originalCents: cents,
        payments: z
          .array(
            z.strictObject({
              id: identifier,
              cents: cents.refine((v) => v > 0),
              paidOn: day,
            }),
          )
          .max(128),
      }),
    )
    .max(1000),
  provenance: z.strictObject({
    kind: z.literal("fictional_imported_receivables_snapshot"),
    priorModelEvidence: z.null(),
    priorAuthorizationEvidence: z.null(),
    priorEmailDeliveryEvidence: z.null(),
  }),
});
export type Population = Omit<z.infer<typeof schema>, "state"> & {
  state: State;
};
export function validatePopulation(value: unknown): Population {
  const p = schema.parse(value),
    state = validateState(p.state);
  if (
    p.history.length !== state.receivables.length ||
    new Set(p.history.map((h) => h.receivableId)).size !== p.history.length
  )
    throw new Error("history population differs from receivables");
  const paymentIds = new Set<string>();
  for (const h of p.history) {
    const i = state.receivables.find((x) => x.id === h.receivableId);
    if (!i || h.issuedOn > i.due_on || h.issuedOn > p.asOf)
      throw new Error("invalid invoice history chronology/reference");
    let total = 0n,
      prior = h.issuedOn;
    for (const payment of h.payments) {
      if (
        paymentIds.has(payment.id) ||
        payment.paidOn < prior ||
        payment.paidOn > p.asOf
      )
        throw new Error("invalid payment identity/chronology");
      paymentIds.add(payment.id);
      prior = payment.paidOn;
      total += BigInt(payment.cents);
    }
    if (BigInt(h.originalCents) - total !== BigInt(i.balance_cents))
      throw new Error("imported payments do not reconcile current balance");
  }
  return { ...p, state };
}
