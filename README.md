# Collections follow-up agent with Mastra and OpenAI

A Mastra/OpenAI CLI reviews fictional receivables and CRM contact instructions, prepares a fixed respectful payment follow-up, and records it in a local synthetic outbox. It rechecks current payment balance, customer policy, promise date, recipient, complete source snapshot and both revisions immediately before committing a message. One invoice can have one follow-up, including when different processes prepared separate drafts.

This example repository is publicly viewable. A project license has not been selected.

## Simulate with Firedrill

[Firedrill](https://firedrill.run/) is a simulation platform for AI agents.
Start from this repository’s root:

```sh
npx firedrill-run init
```

Sign in and choose your project, then follow the [simulation run guide](firedrill/README.md)
for application dependencies, a preview and the reviewed scenarios. Your agent runs
locally or in your CI; model credentials stay separate from Firedrill sign-in.
The included recipes record outcomes without an automatic quality score or CI gate.

## Start without a model key

Node 22.13+ and npm are required. Dependencies and the parser compatibility repair are pinned in `package-lock.json`.

```sh
npm ci
npm run check
npm run collections -- datasets
npm run collections -- init --state run-output/ordinary.json --case original-overdue
npm run collections -- list --state run-output/ordinary.json --as-of 2026-10-15
npm run collections -- run --state run-output/ordinary.json --as-of 2026-10-15 --task "Follow up AR-201 if allowed" --allow-writes
```

The last command prints a key-free plan and changes no state. Installed complete source works outside the checkout directory. `--seed /absolute/path/starter.json` accepts a caller-supplied validated legacy source instead of a dataset case.

## Actual model run

Set `OPENAI_API_KEY` in your environment, then explicitly enable one bounded run:

```sh
npm run collections -- run --state run-output/ordinary.json --as-of 2026-10-15 --task "Follow up AR-201 if allowed" --model openai/gpt-4o --allow-writes --live --max-provider-requests 8
```

Choose an enabled model with `--model openai/<model>` or `COLLECTIONS_MODEL`. No fallback model or key is supplied. The default identifier is a configuration choice, without an availability or quality claim. Without `--allow-writes`, tools can inspect but cannot prepare/send. `--base-url` explicitly selects HTTPS or owned loopback HTTP; ambient endpoint/proxy/organization/project settings are not borrowed. Synthetic test credentials are used only with owned local test servers.

One run permits eight prepared Responses requests, at most seven single-tool turns, 2,048 requested output tokens per request, zero SDK/framework/processor retries, 30-second HTTP phases and a 120-second operation budget (`--timeout-ms`, maximum 300 seconds). These are application/requested budgets. Synchronous source work and filesystem operations can delay cancellation; decoded response/request caps are not hard heap, wire or process containment limits. Only nonstreaming Responses JSON is qualified. SIGINT/SIGTERM/SIGHUP cancel pending HTTP, await transport destruction, retain partial evidence and exit 130/143/129.

## Synthetic operations and recovery

```sh
npm run collections -- payment --state run-output/ordinary.json --receivable AR-201 --cents 5000
npm run collections -- crm --state run-output/ordinary.json --customer C-101 --policy do_not_contact --instructions "Account disputed; stop outreach"
npm run collections -- workspace --state run-output/ordinary.json
npm run collections -- reset --state run-output/ordinary.json --destination run-output/fresh.json
```

Initialization exclusively creates private state and source metadata; it refuses collisions. Reset creates a fresh instance and preserves the old state and receipts. Readback distinguishes valid human changes from the original imported snapshot. Missing/corrupt source or metadata is rejected without repair. The twelve SHA256-bound `collections-populations` 1.0.0 cases cover starter, busy (16 customers/64 invoices), ambiguous and boundary conditions. Imported invoice/payment chronology reconciles exact integer balances; history states that earlier model execution, authorization and real email delivery are unavailable. Case labels, source history, fixture identity and application request keys are excluded from model context. Scoring expectations live in tests.

Drafts retain their original source snapshot. Changing the fixed saved message is rejected; changing current facts without incrementing a revision still blocks dispatch. Due dates and promise holds are inclusive: an invoice is overdue only after its due date, and contact waits until after a promise date. Only CAD/USD/GBP/EUR two-decimal currencies and safe integer cents are supported; maximum-safe amounts use integer formatting. A repeated request can recover its draft/send; reusing its ID with a changed task/date fails. Separate invoice tools derive separate application-owned keys. A send replay confirms the existing local outbox record, without re-sending or asserting current payment eligibility.

Cooperating processes serialize each synchronous final read/recheck/atomic replacement using a persistent SQLite mutex; a crash releases the database lock. The mutex is never unlinked or age-reaped. New dataset instances fence stale owners. Caller-supplied legacy state without an instance ID has no cross-reset identity guarantee. Uncooperative filesystem replacement, symlink ancestors and same-user hostile processes are outside an OS security boundary. Previously saved unverified drafts without source snapshots are rejected; recreate them from an unchanged original source in a new workspace.

## Evidence and qualification

Each run creates a private UUID receipt under the state's `runs/` directory (`--output-root` overrides). It records the original source bytes/hash, prepared attempts, original decoded provider bytes/JSON/unknown fields, IDs/model/arguments, tool authority/effects and awaited cleanup. Raw input/output/total/cache/reasoning counters distinguish observed zero, missing and invalid values. Normalized SDK usage remains separate; cost is unknown. Failed provider turns retain available counters and partial effects. Persistent recording failure stops later work and exposes failed in-memory evidence with unknown durable final state. A transport close failure cannot become confirmed cleanup through a second empty close.

80 local checks qualify actual pinned Mastra 1.77.0 and `@ai-sdk/openai` 3.0.88 over owned Undici 7.30.1 HTTP. Controlled provider responses exercise all twelve cases, original unfinished-response regression, argument/completion guards, payment/CRM races, duplicate dispatch, real process concurrency, cancellation/deadlines, missing keys, storage/source faults and normal CLI signals. They do not establish live model judgment, semantic accuracy, upstream billing or real email delivery. No customer email service or payment rail is connected.

```sh
npm run datasets:check
npm run package
npm run check:package
```

The complete deterministic source archive includes code, data, original fixtures, tests, scripts, docs, CI and lockfiles with exact per-file manifest; private state, dependencies and builds are excluded. Its qualification script installs from the extracted archive outside checkout with `npm ci`, initializes/reads/resets every case, exercises the installed actual native CLI over local HTTP, runs all tests and verifies every original delivered file is unchanged. CI retains the source archive and qualification record.

Live OpenAI semantic/billing proof, authenticated persisted Firedrill runs and license remain parked external gates. This repository is publicly viewable; no project license has been selected. The guarded argparse compatibility repair and its removal criteria are in [scripts/README.md](scripts/README.md).

References: [Mastra Agent](https://mastra.ai/reference/agents/agent), [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog), [Firedrill](https://firedrill.run/), [Firedrill documentation](https://docs.firedrill.run/). The pinned installed source governs this qualification; current online documentation can describe a newer interface.

## Current Firedrill integration

Released CLI/SDK 2.2.2, current command invocation, remote operator MCP and recovery are documented in [firedrill/README.md](firedrill/README.md). Offline checks preserve real CLI plan/native-key behavior and independent write permission; authenticated persisted runs and live quality/cost remain separate gates.
