#!/usr/bin/env node
import {
  openSync,
  closeSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runCollections } from "./agent.js";
import { loadState, Workspace } from "./workspace.js";
import { day, identifier, text, validateState } from "./schema.js";
import {
  initializeCase,
  listDatasets,
  workspaceInfo,
  resetCase,
} from "./datasets.js";
import { REQUEST_LIMIT } from "./native.js";

const help = () =>
  console.log(`Usage:
  collections datasets
  collections init --state run-output/workspace.json [--case original-overdue | --seed fixtures/starter.json]
  collections workspace --state run-output/workspace.json
  collections reset --state run-output/workspace.json --destination run-output/fresh.json
  collections list --state run-output/workspace.json --as-of 2026-10-15
  collections run --state run-output/workspace.json --task "Follow up AR-201" [--allow-writes]
  collections run --state run-output/workspace.json --task "Follow up AR-201" --live --max-provider-requests 8 [--allow-writes]
  collections payment --state run-output/workspace.json --receivable AR-201 --cents 25000
  collections crm --state run-output/workspace.json --customer C-101 --policy do_not_contact --instructions "Stop outreach"

Run without --live produces a key-free plan. Live uses an actual OpenAI model.
All effects are local synthetic drafts/outbox records, with no email delivery.
Options: --as-of YYYY-MM-DD --model openai/<model> --request-id ID
  --base-url https://api.openai.com/v1 --timeout-ms 120000 --output-root PATH`);
const valueFlags = new Set([
  "--state",
  "--seed",
  "--as-of",
  "--task",
  "--model",
  "--request-id",
  "--base-url",
  "--timeout-ms",
  "--output-root",
  "--max-provider-requests",
  "--receivable",
  "--cents",
  "--customer",
  "--policy",
  "--promise-until",
  "--instructions",
  "--case",
  "--destination",
]);
const boolFlags = new Set(["--live", "--allow-writes"]);
function parse(args: string[]) {
  const command = args.shift();
  const fields = new Map<string, string | true>();
  while (args.length) {
    const flag = args.shift()!;
    if (fields.has(flag)) throw new Error(`duplicate option ${flag}`);
    if (boolFlags.has(flag)) fields.set(flag, true);
    else if (valueFlags.has(flag)) {
      const v = args.shift();
      if (v === undefined || v.startsWith("--"))
        throw new Error(`${flag} needs a value`);
      fields.set(flag, v);
    } else throw new Error(`unknown option ${flag}`);
  }
  const get = (name: string) => fields.get(name) as string | undefined;
  const required = (name: string) => {
    const v = get(name);
    if (!v) throw new Error(`${name} required`);
    return v;
  };
  return { command, fields, get, required };
}
export function initialize(file: string, seed: string) {
  const state = loadState(seed);
  state.instance_id = randomUUID();
  validateState(state);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    file,
    instanceId: state.instance_id,
    receivables: state.receivables.length,
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h"))
    return help();
  const { command, fields, get, required } = parse(args);
  if (command === "datasets")
    return console.log(JSON.stringify(listDatasets(), null, 2));
  const file = resolve(required("--state"));
  if (command === "init") {
    if (get("--seed") && get("--case"))
      throw new Error("choose --seed or --case");
    return console.log(
      JSON.stringify(
        get("--seed")
          ? initialize(file, resolve(get("--seed")!))
          : initializeCase(file, get("--case")),
      ),
    );
  }
  const workspace = new Workspace(file);
  const asOf = get("--as-of") ?? new Date().toISOString().slice(0, 10);
  day.parse(asOf);
  if (command === "workspace")
    return console.log(
      JSON.stringify(workspaceInfo(file, workspace.snapshot().state), null, 2),
    );
  if (command === "reset")
    return console.log(
      JSON.stringify(
        resetCase(
          file,
          resolve(required("--destination")),
          workspace.snapshot().state,
        ),
        null,
        2,
      ),
    );
  if (command === "list")
    return console.log(JSON.stringify(workspace.list(asOf), null, 2));
  if (command === "payment") {
    const raw = required("--cents");
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error("--cents must be a positive safe integer");
    const result = workspace.recordPayment(
      required("--receivable"),
      Number(raw),
    );
    if (!result.ok) process.exitCode = 2;
    return console.log(JSON.stringify(result));
  }
  if (command === "crm") {
    const result = workspace.setInstructions(
      required("--customer"),
      required("--policy") as never,
      get("--promise-until") ?? null,
      required("--instructions"),
    );
    if (!result.ok) process.exitCode = 2;
    return console.log(JSON.stringify(result));
  }
  if (command !== "run") throw new Error(`unknown command: ${command}`);
  const task = required("--task"),
    model = get("--model") ?? process.env.COLLECTIONS_MODEL ?? "openai/gpt-4o",
    requestId = get("--request-id") ?? randomUUID();
  text(8000).parse(task);
  identifier.max(80).parse(requestId);
  if (!fields.has("--live"))
    return console.log(
      JSON.stringify(
        {
          executionStatus: "plan",
          model,
          asOf,
          allowWrites: fields.has("--allow-writes"),
          receivables: workspace.list(asOf).length,
          maximumPreparedProviderRequests: REQUEST_LIMIT,
          stateChanged: false,
          costUsd: null,
        },
        null,
        2,
      ),
    );
  const max = required("--max-provider-requests");
  if (
    !/^[1-9]\d*$/.test(max) ||
    !Number.isSafeInteger(Number(max)) ||
    Number(max) < REQUEST_LIMIT
  )
    throw new Error(
      `--max-provider-requests must cover the ${REQUEST_LIMIT} prepared-attempt bound`,
    );
  const timeoutMs =
    get("--timeout-ms") === undefined ? undefined : Number(get("--timeout-ms"));
  const controller = new AbortController();
  let signalCode: number | undefined;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const [name, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    const fn = () => {
      signalCode ??= code;
      controller.abort(new Error(`collections cancelled by ${name}`));
    };
    listeners.set(name, fn);
    process.on(name, fn);
  }
  try {
    console.log(
      JSON.stringify(
        await runCollections({
          statePath: file,
          task,
          requestId,
          asOf,
          model,
          allowWrites: fields.has("--allow-writes"),
          baseURL: get("--base-url"),
          timeoutMs,
          outputRoot: get("--output-root"),
          signal: controller.signal,
        }),
        null,
        2,
      ),
    );
  } catch (e: any) {
    console.log(
      JSON.stringify(
        {
          executionStatus: "failed",
          error: e.message,
          receiptPath: e.receiptPath ?? null,
          recordingFailed: !!e.recordingFailed,
          cleanupConfirmed: e.evidence?.cleanupConfirmed ?? false,
          reportedUsage: e.evidence?.reportedUsage ?? null,
        },
        null,
        2,
      ),
    );
    process.exitCode = signalCode ?? 1;
  } finally {
    for (const [name, fn] of listeners) process.removeListener(name, fn);
  }
}
main().catch((e: unknown) => {
  console.error(`collections: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
