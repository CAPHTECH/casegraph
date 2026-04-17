# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo at a Glance

CaseGraph is a local-first, CLI-first **case graph** substrate (spec version `0.1-draft`). `docs/` is the normative source of truth (spec, ADRs, examples). `packages/` contains a pnpm workspace with a TypeScript reference implementation. `AGENTS.md` is the human contributor guide and `docs/README.md` is the design index — read both before proposing structural changes.

## Commands

Package manager is pnpm 10 (declared in `package.json`). Node must support `node:sqlite` (Node 22+).

- `pnpm install` — install workspace dependencies.
- `pnpm build` / `pnpm typecheck` — TypeScript project references build (`tsc -b`). `typecheck` uses `--pretty false`.
- `pnpm test` — run the full Vitest suite (`tests/**/*.test.ts`, Node env, vitest 3).
- `pnpm test:watch` — watch mode.
- Run a single test file: `pnpm exec vitest run tests/cli.test.ts`.
- Filter by name: `pnpm exec vitest run -t "creates a release case"`.
- `pnpm lint` / `pnpm lint:fix` — Biome check (lint + format + import sort + complexity) over `packages/` and `tests/`. A PostToolUse hook at `.claude/hooks/biome-check.sh` automatically runs `biome check --write` against every file Claude edits via Edit/Write/MultiEdit; unfixable errors come back as hook feedback (exit 2), so manual `pnpm lint` is mainly a pre-commit sanity check.
- CLI entry during development: `node packages/cli/dist/index.js <args>` after building (the published `bin` is `cg`). The importer plugin is launched via `node --experimental-strip-types packages/importer-markdown/src/index.ts`.

## Architecture

### Layering

```
@casegraph/core  ← pure domain + storage + validation + JSON-RPC client
      ↑
@casegraph/cli   ← commander-based `cg` CLI, thin wrappers over core
@casegraph/importer-markdown ← out-of-process JSON-RPC over stdio plugin (importer)
@casegraph/sink-markdown     ← out-of-process JSON-RPC over stdio plugin (sink)
@casegraph/worker-shell      ← out-of-process JSON-RPC over stdio plugin (worker)
```

Aliases in `vitest.config.ts` resolve `@casegraph/core` to `packages/core/src/index.ts` and `@casegraph/cli/app` to the CLI's `app.ts` so tests run against TypeScript sources without a build step. `tsconfig.base.json` mirrors this for `tsc`.

### Event-sourced core

Per case, the source of truth is `.casegraph/cases/<case_id>/events.jsonl` (append-only). `packages/core/src/reducer.ts` replays events into a `CaseStateView` (nodes, edges, attachments, validation issues, derived node states). The YAML `case.yaml` snapshot and the workspace-wide SQLite cache (`.casegraph/cache/state.sqlite`, opened via Node's built-in `node:sqlite` in `packages/core/src/sqlite.ts`) are **projections** that must be regenerated from events — never treat them as authoritative. `cg cache rebuild` and `cg validate storage` enforce that contract.

When you add a mutation path: go through `appendPreparedCaseEvents` in `packages/core/src/workspace.ts`. It (1) takes the workspace lock (`lock.ts`), (2) re-reads existing events, (3) replays with the new events appended, (4) aborts on any `severity: "error"` validation issue, (5) appends to `events.jsonl`, (6) rewrites `case.yaml`, (7) rebuilds the SQLite cache for that case. Skipping any step breaks the invariant.

### Patches, not direct mutation by AI

`GraphPatch` (`packages/core/src/patch.ts`, spec `docs/spec/04-graphpatch.md`) is the contract for external agents. Apply path: `validateGraphPatchDocument` → `reviewGraphPatch` (checks `base_revision` staleness and dry-runs operations) → `applyPatch` emits a single `patch.applied` event. Do not add code paths that mutate state from an AI/importer response without going through this pipeline.

### CLI shape

`packages/cli/src/app.ts` wires commander; the runtime glue is in `runtime.ts` (workspace resolution, global flags, text/JSON rendering, exit-code mapping). Frozen Phase 0 surface: `init`, `case {new,list,show}`, `node`, `edge`, `task`, `decision`, `event`, `evidence`, `frontier`, `blockers`, `validate [storage]`, `cache rebuild`, `events {verify,export}`. `cg patch …` and `cg import markdown` are Phase 2 working surfaces; `cg sync {push,pull}` is the Phase 3 working surface for projection sinks; `cg worker run` is the Phase 4 working surface for worker execution; `cg case view` is the Phase 5 working surface (ASCII dependency tree; pure `CaseStateView` renderer in `packages/cli/src/case-view.ts`). Per spec these are **not yet UX-frozen**, so rename/shape changes are allowed but should be called out.

Exit codes are frozen: `0` ok, `2` validation, `3` not found, `4` conflict. Propagate by throwing `CaseGraphError` with the right `exitCode` rather than calling `process.exit` from deep code.

### Workspace layout on disk

`.casegraph/` (name lives in `constants.ts`): `workspace.yaml`, `config.yaml`, `.lock`, `cache/state.sqlite`, and `cases/<case_id>/{case.yaml, events.jsonl, attachments/, projections/}`. Workspace is resolved by `--workspace` → `CASEGRAPH_WORKSPACE` → walking up from cwd looking for `.casegraph/`.

### Plugin protocol

Out-of-process plugins (markdown importer, markdown sink, shell worker, code-agent worker, local-llm worker) speak JSON-RPC over stdio via `createJsonRpcStdioClient` (`packages/core/src/jsonrpc.ts`). Handshake is `initialize` → `capabilities.list` → domain method (e.g. `importer.ingest`, `sink.planProjection` / `sink.applyProjection` / `sink.pullChanges`, `worker.execute`) → `shutdown`. The shared spawn + handshake + env-filtering helper lives in `packages/cli/src/plugin-client.ts`; the role-specific wrappers are `packages/cli/src/importer-host.ts`, `packages/cli/src/sink-host.ts`, and `packages/cli/src/worker-host.ts`. Env is filtered through a fixed allowlist plus per-plugin `env_allowlist` from `config.yaml` — do not pass `process.env` through raw. Sinks read `config.sinks.<name>`, workers read `config.workers.<name>` (same shape as `config.importers.<name>`) and fall back to the bundled markdown sink / shell worker. Reverse sync: `sink.pullChanges` returns a `GraphPatch` with `generator.kind = "sync"`; `cg sync pull` persists a `projection.pulled` audit event and writes the patch to disk for `cg patch review` / `cg patch apply`. Worker execution: `cg worker run` appends `worker.dispatched` before calling the plugin and `worker.finished` after; both are audit-only (no graph state change). If `worker.execute` returns a `GraphPatch`, the patch is written to `--output` with `base_revision` rewritten to the post-`worker.finished` revision, and it is applied via the regular `cg patch apply` pipeline (ADR-0003 "AI does not own state"). `config.approval_policy.<worker_name>` accepts `auto` / `require` / `deny`; the default is `require` for effectful workers and `auto` for pure workers. See ADR-0005.

## Project Conventions

- **Docs are the spec.** If behavior changes, update the corresponding `docs/spec/*.md` and, for user-visible behavior, `docs/examples/{release-case,move-case}.md` (both are normative acceptance fixtures — `tests/fixtures/*.fixture.json` mirror them).
- **Determinism.** Reducer, frontier/blockers, validation, and sync diffs must be deterministic. Don't introduce `Date.now()` / `Math.random()` into these paths; use `MutationContext.now` and ULIDs via `generateId()` (`helpers.ts`). Tests rely on this.
- **Minimal CLI surface.** Don't extend Phase 0 frozen commands without a spec update. New capabilities land behind new verbs (see roadmap in `docs/roadmap.md`).
- **TypeScript strictness.** `noUncheckedIndexedAccess` is on, ESM (`"type": "module"`) with `NodeNext` resolution and `.js` import specifiers in `.ts` files — keep that style.
- **Biome is the single source of truth for lint/format.** Don't introduce ESLint, Prettier, or stylistic-only checks alongside it. Complexity thresholds and formatter rules live in `biome.json`; tune there rather than by per-file disables.
- **Commit style.** Conventional Commits (e.g. `feat:`, `refactor:`, `docs:`, `spec:`) matching recent history.

## Gotchas

- `node:sqlite` requires Node 22+ — this is not guarded in code.
- The importer package's `bin` and self-test both use `node --experimental-strip-types` to run `.ts` directly; don't "fix" this by compiling unless you also change the spawn command in `importer-host.ts`.
- `rebuildCaseCacheForState` runs on every mutation; if you add a new event type, extend `replayCaseEvents` and the SQLite `rebuildCaseCache` together or the cache will silently drift.
- `projection_mappings` is a projection of `projection.pushed` / `projection.pulled` events (via `deriveProjectionMappings`), not a separately maintained table. Never mutate it outside `rebuildCaseCache`.
- `cg sync pull` appends `projection.pulled` before returning its patch, so the emitted patch's `base_revision` is rewritten to the post-append revision; don't reorder this or the subsequent `cg patch apply` will be stale.
- `cg worker run` applies the same invariant: `worker.finished` is appended *before* the returned patch's `base_revision` is rewritten. `worker.dispatched` is appended *before* `worker.execute` is dispatched so a worker that never returns still leaves an audit trail. Client-side `--timeout` enforcement in `packages/cli/src/worker-host.ts` also appends a failed `worker.finished` before throwing `worker_timeout`, so the audit trail is preserved even when the plugin hangs.
- Plugin conformance: `tests/helpers/conformance.ts::runPluginConformance({ command, cwd, role })` exercises the shared handshake (`initialize` / `health` / `capabilities.list` / unknown-method JSON-RPC error / `shutdown`) plus the role-required methods. Reuse it from new plugin packages — don't reimplement the handshake assertions.
- AI worker patch extraction: `packages/core/src/worker-prompt.ts::buildAgentPrompt` + `extractPatchFromText` are the shared helpers for the `code-agent` and `local-llm` workers. Agents are expected to emit a single ```` ```casegraph-patch ```` fenced block (spec §7.10a) — worker-code-agent spawns a configured CLI and reads its stdout; worker-local-llm POSTs to Ollama `/api/generate` and reads `response.response`. Both use the same extractor; if it fails the worker returns `status: "failed"` with no patch (never `worker_patch_invalid`).
- `applyPatch` canonicalizes attachments (copies workspace files, assigns ids) *after* review but before emitting the event — preserve that order to keep event payloads self-contained.
