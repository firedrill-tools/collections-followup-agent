import {
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  existsSync,
  rmSync,
} from "node:fs";
import { basename, join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validatePopulation } from "./fixture-source.js";
import { validateState, type State } from "./schema.js";
import { sha256 } from "./evidence.js";
export const DATASET_SHA256 =
  "8a2899a69026eacc87ac21ad6d0b0d2a0f63874b96c95cb7496c98665c300829";
function regular(file: string, limit = 1_048_576) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > limit)
    throw new Error("invalid bounded dataset source");
  const b = readFileSync(file);
  if (b.length > limit) throw new Error("dataset source too large");
  return b;
}
export function populations() {
  const bytes = regular(
    fileURLToPath(new URL("../../datasets/index.json", import.meta.url)),
  );
  if (sha256(bytes) !== DATASET_SHA256)
    throw new Error("dataset authority hash differs");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    value.id !== "collections-populations" ||
    value.version !== "1.0.0" ||
    !Array.isArray(value.cases) ||
    value.cases.length !== 12
  )
    throw new Error("invalid dataset index");
  const cases = value.cases.map(validatePopulation);
  if (new Set(cases.map((p: any) => p.id)).size !== 12)
    throw new Error("duplicate dataset case");
  return cases as ReturnType<typeof validatePopulation>[];
}
export function listDatasets() {
  return populations().map((p) => ({
    id: p.id,
    profile: p.profile,
    asOf: p.asOf,
    task: p.task,
    customers: p.state.customers.length,
    receivables: p.state.receivables.length,
  }));
}
const metadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: z.string().uuid(),
  datasetSha256: z.literal(DATASET_SHA256),
  caseId: z.string(),
  seedStateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceScope: z.literal("original_imported_seed_snapshot"),
  priorModelEvidence: z.null(),
  priorAuthorizationEvidence: z.null(),
  priorEmailDeliveryEvidence: z.null(),
});
export function authority(file: string, state: State) {
  if (!state.dataset) return null;
  if (!state.instance_id)
    throw new Error("dataset workspace has no instance identity");
  const metadata = metadataSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        regular(`${file}.source.json`, 32_768),
      ),
    ),
  );
  const p = populations().find((x) => x.id === metadata.caseId);
  if (
    !p ||
    metadata.instanceId !== state.instance_id ||
    state.dataset.source_sha256 !== DATASET_SHA256 ||
    state.dataset.case_id !== metadata.caseId ||
    metadata.seedStateSha256 !== sha256(JSON.stringify(p.state))
  )
    throw new Error("workspace source identity differs");
  return { metadata, population: p };
}
function writeExclusive(file: string, value: unknown) {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function initializeCase(file: string, caseId = "original-overdue") {
  file = resolve(file);
  const p = populations().find((x) => x.id === caseId);
  if (!p) throw new Error("unknown dataset case");
  if (
    existsSync(file) ||
    existsSync(`${file}.source.json`) ||
    existsSync(
      join(dirname(file), `.${basename(file)}.collections-lock.sqlite`),
    )
  )
    throw new Error("workspace destination already exists");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const state = structuredClone(p.state);
  state.instance_id = randomUUID();
  state.dataset = {
    id: "collections-populations",
    version: "1.0.0",
    case_id: p.id,
    source_sha256: DATASET_SHA256,
  };
  validateState(state);
  const metadata = {
    schemaVersion: 1,
    instanceId: state.instance_id,
    datasetSha256: DATASET_SHA256,
    caseId: p.id,
    seedStateSha256: sha256(JSON.stringify(p.state)),
    sourceScope: "original_imported_seed_snapshot",
    priorModelEvidence: null,
    priorAuthorizationEvidence: null,
    priorEmailDeliveryEvidence: null,
  };
  let createdMetadata = false;
  try {
    writeExclusive(`${file}.source.json`, metadata);
    createdMetadata = true;
    writeExclusive(file, state);
  } catch (e) {
    if (createdMetadata) rmSync(`${file}.source.json`, { force: true });
    throw e;
  }
  const fd = openSync(dirname(file), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    file,
    caseId,
    instanceId: state.instance_id,
    asOf: p.asOf,
    task: p.task,
    customers: state.customers.length,
    receivables: state.receivables.length,
    sourceScope: metadata.sourceScope,
  };
}
export function workspaceInfo(file: string, state: State) {
  const a = authority(file, state);
  const current = structuredClone(state);
  delete current.instance_id;
  delete current.dataset;
  return {
    file: resolve(file),
    instanceId: state.instance_id ?? null,
    caseId: a?.population.id ?? null,
    sourceScope: a?.metadata.sourceScope ?? "caller_supplied_legacy_state",
    originalSeedMatch: a
      ? sha256(JSON.stringify(current)) === a.metadata.seedStateSha256
      : null,
    currentStateSha256: sha256(JSON.stringify(state)),
    importedHistory: a?.population.history ?? null,
    priorModelEvidence: null,
    priorAuthorizationEvidence: null,
    priorEmailDeliveryEvidence: null,
  };
}
export function resetCase(file: string, destination: string, state: State) {
  const a = authority(file, state);
  if (!a) throw new Error("reset requires a hash-bound dataset workspace");
  if (resolve(file) === resolve(destination))
    throw new Error("reset needs a fresh destination");
  return initializeCase(destination, a.population.id);
}
