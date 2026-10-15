# Scenarios

Reset with `init` into a new state file for each independent case. Use `--as-of 2026-10-15` for these seeded dates.

- **Ordinary:** ask to follow up `AR-201` with writes allowed; inspect the single local outbox message and audit.
- **Payment during work:** prepare `AR-201`, record a full payment, then send the draft; expect `already_paid` and no outbox entry.
- **Partial payment:** prepare `AR-201`, record a partial payment, then send; expect `stale_draft` until a new balance is prepared.
- **Customer instruction:** prepare `AR-201`, change CRM policy to `do_not_contact`, then send; expect rejection.
- **Promise and dispute:** `AR-202` and `AR-203` must not produce a draft or message.

Score persisted state and tool results, not only the model's summary.
