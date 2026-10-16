# Legacy parser compatibility

Mastra 1.77.0 uses gray-matter 4, which uses js-yaml 3 and argparse 1. The latter depends on sprintf-js, whose published versions are affected by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

The package override selects argparse **2.0.1 only under gray-matter 4 / js-yaml 3**. Argparse 2 removes sprintf-js and retains the older argument-parser API. The YAML library keeps its existing `safeLoad`/`safeDump` contract. Argparse 3 removed that legacy API, so changing to its newest major would require a separate migration.

Argparse 2's legacy `version` constructor option registers a version action without assigning `parser.version`. `patch-argparse.cjs` restores that one assignment so the existing js-yaml `--version` behavior still works. It runs after ordinary `npm install` / `npm ci`, modifies only the installed dependency, checks the exact version and unique source marker, and is idempotent. Its original license remains in `node_modules/argparse/LICENSE`; no upstream source is republished here. Running with `--ignore-scripts` requires `npm run postinstall` before verification.

`tests/dependency.test.ts` exercises YAML front-matter parsing/serialization, CLI help/version, both stdin conversion modes and invalid-input errors. The application suite also exercises the local tool/state boundaries. Run `npm audit --omit=dev` to inspect the resolved runtime tree. Remove this override/repair together when a future dependency chain has been qualified against these contracts.

Upstream reference: [Argparse changelog and legacy API removal](https://github.com/nodeca/argparse/blob/master/CHANGELOG.md).

## Dataset and complete-source qualification

`build-datasets.mjs` deterministically generates twelve fictional invoice/CRM populations. The compiled loader pins the exact index hash; regeneration verifies original payment sums/dates and current source. `--check` refuses drift. Case/task/history metadata is outside model-facing tools.

`package.mjs` emits a complete source USTAR/gzip with fixed metadata and portable uncompressed DEFLATE blocks, exact per-file SHA256/size/mode manifest, and no dependency on Git, checkout timestamps or compressor version. Installed caches, private state and built output are excluded. `check-package.mjs` extracts outside checkout, runs fresh `npm ci`, checks all private cases/readback/reset, missing-key and default key-free plan, actual installed Mastra/OpenAI HTTP CLI with synthetic outbox, the full suite and unchanged original delivered bytes. `npm ci` runs the existing guarded argparse repair. Qualification requires Node/npm and the system `tar` utility; runtime needs Node only after build/install. CI retains the source/qualification record.
