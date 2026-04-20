# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and the project follows semantic versioning for published packages.

## [0.1.4] - 2026-04-20

Published: `@caphtech/casegraph-cli@0.1.4`. `kernel`, `core`, `importer-markdown`, `sink-markdown`, and `worker-*` packages are unchanged.

### Added

- **cli**: `cg --version` / `cg -V` now print the installed CLI version. `isCommanderDisplayExit` already whitelisted `commander.version` as a non-fatal exit, but `program.version(...)` was never registered, so the flag was unavailable. The version is loaded from the CLI `package.json` via `import.meta.url`, so both the TypeScript source (under the vitest alias) and the compiled `dist` entry resolve correctly.

### Docs

- Rewrote the top-level `README.md` demo, EN/JA quickstart guides, and EN/JA manual-acceptance guides so users who installed via `npm install -g @caphtech/casegraph-cli` can follow them without cloning the repo. Prerequisites now list Node 22+ and the npm global install; every command line uses `cg` instead of `pnpm run cg`. The contributor fallback (`pnpm run cg` from source) is preserved as a one-line note.

### Verification

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:install-smoke`

## [0.1.3] - 2026-04-19

Published: `@caphtech/casegraph-cli@0.1.3`. `kernel`, `core`, `importer-markdown`, `sink-markdown`, and `worker-*` packages are unchanged.

### Fixed

- **cli**: `cg sync push`, `cg sync pull`, `cg import markdown`, and `cg worker run` now resolve their built-in plugin entrypoints from installed npm packages. Previously the CLI used `createRequire(import.meta.url).resolve(<plugin>)`, which fails with `No "exports" main defined` on packages whose `exports` field only declares the `"import"` condition (all `@caphtech/casegraph-*` plugin packages). Every published CLI release from `0.1.0` through `0.1.2` was affected; installed CLIs could initialize workspaces and manipulate graphs, but any command that spawned a built-in plugin crashed. The fix uses `import.meta.resolve` so the ESM `"import"` condition is respected.

### Verification

- `pnpm build`
- `pnpm test` (130 tests)
- `pnpm test:e2e` (6 tests)
- Packed the CLI with `pnpm --filter @caphtech/casegraph-cli pack`, installed the tarball into a scratch project, and ran `cg sync push --sink markdown --case <c> --apply` end-to-end against published `sink-markdown@0.1.0` — the command now emits `Applied projection to markdown (upsert_item=1)` instead of the exports error.

## [0.1.2] - 2026-04-19

Published: `@caphtech/casegraph-kernel@0.1.2`, `@caphtech/casegraph-core@0.1.2`, `@caphtech/casegraph-cli@0.1.2`. `importer-markdown`, `sink-markdown`, and `worker-*` packages are unchanged.

### Fixed

- **kernel**: `validatePatchDocument` now rejects `update_node` operations whose `changes` is `{}` or contains only undefined fields with `patch_update_node_changes_empty`. Previously the branch was dead code and no-op patches advanced `case_revision` silently.
- **kernel**: `change_state` targeting a `kind: "evidence"` node is rejected with the new `patch_change_state_evidence` error code. Evidence is observation-of-record and must remain terminal; the reducer and review pipeline previously accepted regressions to `todo` / `doing`.
- **core**: `recordEventNode` / `cg event record` now validates the target node before appending `event.recorded`. Missing nodes exit `3 (not_found)` and nodes whose `kind !== "event"` exit `2 (validation_error)`. Previously any node id silently had its state forced to `done`.

### Added

- **cli**: `cg edge add` accepts `--source` / `--target` as aliases for `--from` / `--to`, matching the underlying `source_id` / `target_id` data model.
- **cli**: `cg node update` accepts `--state <state>`. When provided alongside field edits, the state change and field update are recorded as separate events in order.
- **cli**: `cg patch review` / `cg patch validate` text output now lists each error as `<code>: <message> @<ref>` instead of only a count.
- **cli**: `cg sync push` text output distinguishes "No projection changes needed for <sink>" from the applied / planned case (replaces the ambiguous `(no-op)` suffix).
- **cli**: `cg analyze critical-path` / `slack` / `bottlenecks` text output appends `warnings` with a `!` prefix so empty results like `depth=-` are contextualized.
- **cli**: the built entry suppresses the `node:sqlite` `ExperimentalWarning` so direct `node dist/index.js` invocations are as quiet as `pnpm run cg`.
- **tests**: new `tests/bug-hunt{,2,3}.test.ts` (28 targeted + PBT tests) and `tests/e2e/error-paths.e2e.ts` (4 CLI-level tests) pin the above fixes.

### Docs

- `docs/spec/04-graphpatch.md` documents the new `update_node` / `change_state` reject conditions and error codes.
- `docs/spec/05-cli.md` documents `--state` on `cg node update`, the `--source` / `--target` aliases, and the exit-code contract of `cg event record`.

### Verification

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- hands-on CLI walkthrough (workspace init → case → nodes → edges → evidence → patch review → sync push)

## [0.1.1] - 2026-04-18

### Fixed

- Fixed `@caphtech/casegraph-cli` so `cg --help` exits with code `0` instead of reporting `internal_error: (outputHelp)`.

### Verification

- `pnpm build`
- `pnpm lint`
- `pnpm test`
- public install verification with `npm install -g @caphtech/casegraph-cli@0.1.1`

## [0.1.0] - 2026-04-18

### Added

- Initial public npm publication under the `@caphtech` scope.
- Public packages for the deterministic core, CLI, markdown importer, markdown sink, and built-in workers.
- Package README files, npm metadata, and release guides for public installation and release operations.

### Changed

- Built-in plugin resolution now supports both monorepo development entrypoints and published package installs.

### Verification

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm pack:release`
- npm publish dry-run and published install-path verification
