# Collections scenarios

`collections datasets` lists twelve coherent cases with pinned source hashes, task and as-of date. Init each into a fresh private state file. Grading expectations stay in the tests, outside tools/prompts. Outbox records are synthetic local effects only.

- Ordinary and partial payment: current invoice, exact remaining cents, AP-only address and fixed respectful message.
- Busy: sixteen customers, sixty-four invoices, four currencies, held/disputed/paid/future accounts and coherent imported payments. Focus one invoice without erasing unrelated state.
- Payment/CRM race: a real local payment or contact change after preparation blocks send; a new read does not authorize the old source.
- Conflicting source: hostile CRM instructions cannot override structured do-not-contact policy.
- Promise/due day: same-day hold remains active; exact one-cent/maximum-safe values are preserved.
- Already contacted: imported outbox is history without prior model/auth/email evidence; another draft/request cannot send again.
- Recovery: replay confirms the existing record, changed request task/date fails, different invoice keys remain distinct.
- Native faults: incomplete/refused/unsupported/malformed/mixed/parallel/replayed output stops before tool dispatch; errors after a prepared draft retain it without claiming a completed task.
- Operation faults: cancellation/deadline, recording failure, changed source, cleanup failure and cross-process contention preserve actual state/evidence limits.

Reset creates a fresh destination and leaves prior state/evidence intact. Use CLI `workspace` to distinguish current edits from the original seed. No silent source repair or fabricated success counters.
