# Firedrill agent-first integration

The optional execution toolchain exact-pins released CLI and TypeScript SDK **2.2.2**, verified October 19, 2026. Node 22+ is required. The application retains its separately locked Mastra/OpenAI runtime and existing guarded parser repair.

## Prepare and select scope

From the repository root:

```sh
npm ci
npm run build
npm ci --prefix firedrill --ignore-scripts --no-audit --no-fund
npm test --prefix firedrill
firedrill_cli=firedrill/node_modules/@firedrill-run/cli/bin/firedrill.mjs
node "$firedrill_cli" validate firedrill/scenario.json --json --non-interactive
```

Validation is offline and allocates no batch. Authorize and select the actual project/environment with `node "$firedrill_cli" init` in a human terminal. Automation uses `FIREDRILL_TOKEN`, `FIREDRILL_PROJECT_ID` and `FIREDRILL_ENVIRONMENT_ID` from its secret store. The application independently requires `OPENAI_API_KEY` and an enabled `COLLECTIONS_MODEL` or recipe `configuration.parameters.model`. Keep credentials out of recipes and source.

## Execute the actual coordinator

With an authorized provider budget:

```sh
node firedrill/simulate.mjs --preview
node "$firedrill_cli" simulate firedrill/scenario.json --scenario original-overdue-run --json --non-interactive
```

The target initializes the selected hash-bound workspace and invokes the actual compiled collections CLI and native Mastra/OpenAI agent. Explicit `action: "run"` adds the existing `--live --max-provider-requests 8` boundary; explicit `action: "plan"` returns the real key-free CLI plan, not model execution. `asOf` is a caller-selected calendar date. The sequential bounded recipe includes an authorized synthetic outbox task, a read-only policy check and a busy-state plan. Models use the application's `openai/<model>` format.

`input.allowWrites` is a required literal caller boolean independent of task/case identity. Only true adds `--allow-writes`. The native final-send recheck of balance, customer policy, promise dates and revisions remains authoritative. Only fictional JSON drafts/outbox rows change; nothing is delivered as real email. The model cannot alter its grant, operator identity, source commands or current revision checks.

Every invocation owns a fresh private `.runs/firedrill/attempt-*` workspace and receipt directory, retained after success or failure. Earlier state is never reset by a new attempt. Outputs contain the actual CLI result under `application` and local state paths under `localState`; paths are not uploaded artifacts. Failed partial stdout/stderr retains its run directory. Completion and final prose do not establish correct business effects; inspect actual state and receipts. Local cleanup does not guarantee remote billing stopped or committed effects rolled back.

The adapter accepts current invocation `2026-10-17-target-invocation.1`, explicit task input and ID-only scenario context. It rejects controller/evaluation data and unsupported Tool bindings. Operator/CI credentials are removed before child dispatch. No Firedrill synthetic Tool is required for this local dependency seam. Existing application request/output/deadline bounds remain in effect, not billing guarantees.

## MCP, recovery and CI

Configure remote OAuth operator MCP **https://mcp.firedrill.run/mcp** using the [host-specific setup](https://docs.firedrill.run/guides/coding-agents); no local MCP package is required. Host OAuth and local CLI/SDK login are separate. MCP prepares/queues/inspects; the local execution client runs the actual application. Attach an existing batch with `node firedrill/simulate.mjs --run BATCH_ID`.

Preserve operation IDs and private journals after uncertainty. Recover with `--resume OPERATION_ID` or read retained results with `--result BATCH_ID`. A fresh simulation is new work, and a new adapter invocation gets a fresh synthetic workspace. Runner exit codes preserve pending execution/assessment, errors and optional gates. This observation-only recipe requests no grading or gate.

Ordinary CI and the source-package gate run offline checks, including the actual missing-key boundary and model-free busy plan and fresh archived integration. Use the [live CI generator](https://docs.firedrill.run/guides/ci) only after actual scope, protected credentials and budgets are configured. Authenticated persisted runs, live model quality/cost, publication and licensing remain separate gates.

References: [SDK](https://docs.firedrill.run/sdk/typescript), [command targets](https://docs.firedrill.run/guides/callbacks), [operator MCP](https://docs.firedrill.run/guides/control-mcp).

Before application dispatch, each private workspace saves the validated outer run/attempt/scenario IDs in `invocation.json`. This maps interrupted runs to local state; it is separate from the SDK recovery journal and grants no application authority.
