import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runCollections } from "./agent.js";
import { loadState, Workspace } from "./workspace.js";

const arg = (args: string[], name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const required = (args: string[], name: string) => { const value = arg(args, name); if (!value || value.startsWith("--")) throw new Error(`${name} required`); return value; };
const help = () => console.log(`Usage:
  npm run collections -- init --state run-output/workspace.json
  npm run collections -- list --state run-output/workspace.json --as-of 2026-10-15
  npm run collections -- run --state run-output/workspace.json --task "Follow up AR-201" --allow-writes
  npm run collections -- payment --state run-output/workspace.json --receivable AR-201 --cents 25000

The run command calls a real OpenAI model. All tools use only local synthetic state; send writes to a local outbox.`);

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) return help();
  const command = args[0];
  const file = resolve(required(args, "--state"));
  if (command === "init") {
    const seed = resolve(arg(args, "--seed") || "fixtures/starter.json");
    loadState(seed);
    if (existsSync(file)) throw new Error(`state already exists: ${file}`);
    mkdirSync(dirname(file), { recursive: true }); copyFileSync(seed, file);
    console.log(JSON.stringify({ file, receivables: loadState(file).receivables.length })); return;
  }
  const workspace = new Workspace(file);
  const asOf = arg(args, "--as-of") || new Date().toISOString().slice(0, 10);
  if (command === "list") { console.log(JSON.stringify(workspace.list(asOf), null, 2)); return; }
  if (command === "payment") { console.log(JSON.stringify(workspace.recordPayment(required(args, "--receivable"), Number(required(args, "--cents"))))); return; }
  if (command === "run") {
    console.log(JSON.stringify(await runCollections({ statePath: file, task: required(args, "--task"), requestId: arg(args, "--request-id") || randomUUID(),
      asOf, model: arg(args, "--model") || process.env.COLLECTIONS_MODEL || "openai/gpt-6.1-sol", allowWrites: args.includes("--allow-writes") }), null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}
main().catch((error: unknown) => { console.error(`collections: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
