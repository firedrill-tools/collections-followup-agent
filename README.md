# Collections follow-up agent

A Mastra agent reviews overdue synthetic receivables, CRM contact instructions, and a local email outbox. It can prepare a fixed, respectful payment follow-up and place it in the synthetic outbox. A final send rechecks the current balance and customer instructions, so a payment or contact change between preparation and send blocks the message.

## Run

Node 22.13+ is required.

```sh
npm ci
npm run check
npm run collections -- init --state run-output/workspace.json
npm run collections -- list --state run-output/workspace.json --as-of 2026-10-15
```

For a real model run, set `OPENAI_API_KEY` and call:

```sh
npm run collections -- run --state run-output/workspace.json --as-of 2026-10-15 --task "Follow up overdue receivable AR-201 if allowed" --allow-writes
```

Without `--allow-writes`, the Mastra tools can inspect but cannot prepare or send. `--model openai/<model>` and `--request-id <id>` are available. Missing credentials fail explicitly; there is no fake model fallback. The CLI's `payment` command can simulate an intervening payment on local synthetic state:

```sh
npm run collections -- payment --state run-output/workspace.json --receivable AR-201 --cents 25000
```

`send-followup` writes only to `outbox` in the local JSON file; no customer email service or payment rail is connected. The fixed message uses the exact invoice number, current balance, AP contact, and due date. Idempotency keys prevent duplicate drafts and sends. A new payment changes the receivable revision; a changed contact instruction changes the CRM revision. Either invalidates a prepared draft. The state is designed for one local process, not concurrent production dispatch.

## Scenario coverage

The seed includes an overdue eligible receivable (`AR-201`), an account with a promised payment hold (`AR-202`), a do-not-contact account (`AR-203`), and a not-yet-due invoice (`AR-204`). Offline tests cover all four plus full/partial payment between preparation and send, instruction changes, duplicate requests, and the Mastra write boundary. See [scenarios/README.md](scenarios/README.md).

Live OpenAI model proof and the new Firedrill integration are pending external access/qualification. Offline tests verify the business rules and tool wiring, not model judgment. Dependency versions are pinned in `package-lock.json`. This private repository has no license pending the portfolio publication decision.

The scoped argparse override removes the inherited `sprintf-js` dependency; a guarded install-time repair preserves js-yaml's legacy version option. See [scripts/README.md](scripts/README.md). Fresh `npm ci`, all 9 checks and `npm audit` pass (zero findings at the 2026-10-15 snapshot).

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.
