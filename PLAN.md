# Collections follow-up development plan

## Goal
Implement an independently useful Mastra/OpenAI collections CLI over a strictly synthetic receivables/CRM/email outbox, with an exact final send recheck and reproducible evidence. Live semantic/billing review, new Firedrill qualification and publication/license stay parked.

## Reproduced baseline
Original9 checks pass at bac2c3b. A changed saved draft dispatched an arbitrary recipient/body, two drafts sent duplicate follow-ups for one invoice, and native Mastra/OpenAI Responses accepted an incomplete final response as finished. Private controlled proof: /tmp/firedrill-collections-baseline.json.

## Tasks and acceptance
1. Strict bounded state/date/currency/cents/revision/schema/duplicate/reference validation. Fixed draft authority bound to source snapshot, exact final current-source comparison, one invoice follow-up, correctly scoped multi-invoice idempotency and immutable historical messages. Preserve final payment/promise/contact/revision rechecks. Atomic private cross-process writes with stale instance/source fencing and no silent repair.
2. Explicit pinned native Mastra/OpenAI configuration and owned HTTP, original response completion/arguments and measurements before eager tool dispatch/release, zero retries and explicit request/tool/output/deadline budgets. Private prepared/partial/failure evidence, cleanup/cancel/source/recording faults; retain partial effects and unknown counters/cost honestly. Normal CLI over actual controlled HTTP, no global fetch/vendor cache patches in production.
3. Coherent hash-bound starter/busy/ambiguous/boundary case populations, imported payment/CRM history with truthful prior evidence limits, model-free exclusive private initialization/readback/reset preserving old work. Case/task/grading identity excluded from model context.
4. Fresh complete source archive outside checkout with npm ci, actual installed CLI/native HTTP, every case/reset and full tests. Exact source/Linux CI/artifact/catalog proof. No paid call or real email delivery.

## Current status
All four independent tasks implemented and locally qualified. 80 checks pass through the actual pinned Mastra/OpenAI native HTTP path, real CLI signals and twelve source-bound cases. Fresh locked complete-source distribution installs outside checkout and passes all80, every private case/reset, real installed four-turn native outbox, missing-key receipts and unchanged original-file/repeated-byte gates. Final source push/Linux CI/artifact comparison remains before recording independent completion. External gates stay parked.
