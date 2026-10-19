import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "firedrill-collections-distribution-"),
  );
const env = { ...process.env };
for (const k of Object.keys(env))
  if (
    [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "NODE_TEST_CONTEXT",
      "COLLECTIONS_MODEL",
    ].includes(k) ||
    k.toLowerCase() === "npm_config_allow_scripts"
  )
    delete env[k];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const run = (cmd, args, cwd = temporary) =>
  execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const childRun = (args, extra = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: temporary,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out, err }));
  });
let server;
try {
  const source = JSON.parse(
    run(process.execPath, ["scripts/package.mjs"], root),
  );
  const archive = source.path,
    repeated = path.join(temporary, "repeat.tar.gz");
  run(process.execPath, ["scripts/package.mjs", repeated], root);
  if (!fs.readFileSync(archive).equals(fs.readFileSync(repeated)))
    throw Error("source bytes are not repeatable");
  run("tar", ["-xzf", archive, "-C", temporary]);
  const directory = path.join(temporary, "package");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "MANIFEST.json")),
  );
  const verify = () => {
    for (const f of manifest.files) {
      const bytes = fs.readFileSync(path.join(directory, f.path));
      if (
        hash(bytes) !== f.sha256 ||
        bytes.length !== f.size ||
        (fs.statSync(path.join(directory, f.path)).mode & 0o777) !== f.mode
      )
        throw Error(`delivered source changed: ${f.path}`);
    }
  };
  verify();
  run("npm", ["ci", "--no-audit", "--no-fund"], directory);
  run("npm", ["run", "build"], directory);
  run(process.execPath, ["scripts/build-datasets.mjs", "--check"], directory);
  if (!fs.existsSync(path.join(directory, "firedrill/scenario.json")) || fs.existsSync(path.join(directory, "firedrill/node_modules"))) throw Error("archive integration boundary differs");
  run("npm", ["ci", "--prefix", "firedrill", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  run("npm", ["test", "--prefix", "firedrill"], directory);
  const cli = path.join(directory, "dist/src/cli.js");
  run(process.execPath, [cli, "--help"]);
  const cases = JSON.parse(run(process.execPath, [cli, "datasets"]));
  if (cases.length !== 12) throw Error("installed populations differ");
  for (const p of cases) {
    const file = path.join(temporary, `${p.id}.json`);
    const initialized = JSON.parse(
      run(process.execPath, [cli, "init", "--state", file, "--case", p.id]),
    );
    const state = fs.readFileSync(file);
    const info = JSON.parse(
      run(process.execPath, [cli, "workspace", "--state", file]),
    );
    if (
      info.originalSeedMatch !== true ||
      (fs.statSync(file).mode & 0o777) !== 0o600
    )
      throw Error("installed private source differs");
    const fresh = JSON.parse(
      run(process.execPath, [
        cli,
        "reset",
        "--state",
        file,
        "--destination",
        `${file}.reset.json`,
      ]),
    );
    if (
      fresh.instanceId === initialized.instanceId ||
      !fs.readFileSync(file).equals(state)
    )
      throw Error("reset changed original");
    const list = JSON.parse(
      run(process.execPath, [cli, "list", "--state", file, "--as-of", p.asOf]),
    );
    if (list.length !== p.receivables)
      throw Error("installed list population differs");
  }
  const file = path.join(temporary, "original-overdue.json");
  const before = fs.readFileSync(file);
  const dry = JSON.parse(
    run(process.execPath, [
      cli,
      "run",
      "--state",
      file,
      "--task",
      "Review AR-201",
    ]),
  );
  if (dry.executionStatus !== "plan" || !fs.readFileSync(file).equals(before))
    throw Error("installed dry plan changed source");
  const missing = await childRun([
    cli,
    "run",
    "--state",
    file,
    "--task",
    "Review AR-201",
    "--live",
    "--max-provider-requests",
    "8",
  ]);
  const noKey = JSON.parse(missing.out);
  if (
    missing.code !== 1 ||
    noKey.reportedUsage.preparedAttempts !== 0 ||
    noKey.reportedUsage.input.value !== null
  )
    throw Error("installed missing-key evidence differs");
  let requests = 0;
  server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const b = JSON.parse(body);
    requests++;
    if (
      req.url !== "/v1/responses" ||
      req.headers.authorization !== "Bearer synthetic-installed-key" ||
      b.max_output_tokens !== 2048
    )
      throw Error("installed native request differs");
    const n = requests;
    let item;
    if (n === 1)
      item = {
        id: `fc-${n}`,
        type: "function_call",
        status: "completed",
        call_id: `call-${n}`,
        name: "listReceivables",
        arguments: "{}",
      };
    if (n === 2)
      item = {
        id: `fc-${n}`,
        type: "function_call",
        status: "completed",
        call_id: `call-${n}`,
        name: "prepareFollowup",
        arguments: JSON.stringify({ receivableId: "AR-201" }),
      };
    if (n === 3) {
      const d = JSON.parse(
        b.input.filter((x) => x.type === "function_call_output").at(-1).output,
      );
      item = {
        id: `fc-${n}`,
        type: "function_call",
        status: "completed",
        call_id: `call-${n}`,
        name: "sendFollowup",
        arguments: JSON.stringify({ draftId: d.data.id }),
      };
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": "controlled-installed",
    });
    res.end(
      JSON.stringify({
        id: `resp-${n}`,
        object: "response",
        created_at: 1700000000,
        model: "controlled-installed",
        status: "completed",
        output: item
          ? [item]
          : [
              {
                id: `msg-${n}`,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Recorded one local synthetic follow-up.",
                    annotations: [],
                  },
                ],
              },
            ],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const native = await childRun(
    [
      cli,
      "run",
      "--state",
      file,
      "--task",
      "Follow up AR-201 if allowed",
      "--as-of",
      "2026-10-15",
      "--allow-writes",
      "--live",
      "--max-provider-requests",
      "8",
      "--model",
      "openai/controlled",
      "--base-url",
      `http://127.0.0.1:${port}/v1`,
    ],
    { OPENAI_API_KEY: "synthetic-installed-key" },
  );
  if (native.code !== 0) throw Error(native.err || native.out);
  const result = JSON.parse(native.out);
  if (
    requests !== 4 ||
    result.outboxCount !== 1 ||
    result.reportedUsage.input.value !== 40
  )
    throw Error("installed native execution differs");
  const tests = run("npm", ["test"], directory);
  if (!/tests 80/.test(tests) || !/fail 0/.test(tests))
    throw Error("fresh complete suite differs");
  verify();
  run(
    process.execPath,
    ["scripts/package.mjs", path.join(temporary, "extracted.tar.gz")],
    directory,
  );
  if (
    !fs
      .readFileSync(archive)
      .equals(fs.readFileSync(path.join(temporary, "extracted.tar.gz")))
  )
    throw Error("extracted source bytes differ");
  const qualification = {
    ...source,
    checks:
      "fresh npm-ci complete source outside checkout, all twelve private populations/readback/reset, dry plan/missing-key receipts, actual installed native CLI four-turn outbox, complete80 suite, unchanged delivered source and repeated portable bytes",
  };
  fs.writeFileSync(
    path.join(root, "dist/qualification.json"),
    JSON.stringify(qualification, null, 2) + "\n",
  );
  console.log(JSON.stringify(qualification));
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
