---
name: casegraph-integrate
description: Use when integrating CaseGraph with external tools (markdown importer, optional sinks like Todoist / GitHub Issues, workers such as shell / local-llm / code-agent) or when verifying or recovering storage. Trigger on references to `cg import markdown`, `cg sync push|pull`, `cg worker run`, `cg validate`, `cg validate storage`, `cg cache rebuild`, `cg events verify|export`, `cg migrate`, `env_allowlist`, `approval_policy`, or phrases like "import markdown", "sync pull", "run a worker", "rebuild the cache", "verify events", "run migration". For day-to-day graph reading or editing use casegraph; for AI-authored graph changes use casegraph-patch.
---

# CaseGraph integrations and recovery

## Overview

External integrations — importers, sinks, workers — are out-of-process plugins speaking **JSON-RPC 2.0 over stdio** (ADR-0005). This skill covers launching them, configuring them, and verifying / recovering storage when something drifts.

## Workspace resolution

`--workspace` → `CASEGRAPH_WORKSPACE` → walk upward from cwd.

## Output contract and exit codes

`--format json` returns `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code": "...", "message": "..." } }`. Exit codes: `0` ok, `2` validation, `3` not found, `4` conflict. Plugin-specific codes such as `worker_patch_invalid`, `worker_timeout`, and `migration_unsupported_version` appear in `error.code`.

## Plugin handshake

Every plugin is invoked in this order:

```
initialize → capabilities.list → <role method> → shutdown
```

Role method is one of `importer.ingest`, `sink.planProjection` / `sink.applyProjection` / `sink.pullChanges`, or `worker.execute`. `health` is optional.

Environment variables are filtered through a fixed allowlist plus `config.yaml`'s per-plugin `env_allowlist`. The plugin never sees `process.env` directly. Anything a plugin needs (API tokens, hosts, CLI paths) must be listed in its `env_allowlist`.

## Importer: markdown

```
cg import markdown --case <case_id> --input <path.md> --output <patch.json>
```

- `importer.ingest` returns a `GraphPatch`.
- `cg import markdown` **never auto-applies**. The patch is written to disk.
- Feed the output through the **casegraph-patch** skill: `cg patch validate → review → apply`.
- The current importer supports `mode: "append"` only. Checkboxes and bullets become node candidates.
- Duplicate detection is done inside the importer; collisions are surfaced as warnings.
- In the repository, the built-in importer resolves `packages/importer-markdown/src/index.ts` and runs it via `node --experimental-strip-types`. In a published install, the CLI resolves the installed `@caphtech/casegraph-importer-markdown` package entrypoint instead. Keep both paths working when changing plugin resolution.

## Sink: markdown (built-in reference integration)

```
cg sync push --sink markdown --case <case_id>
cg sync pull --sink markdown --case <case_id>
```

- Three projection kinds: actionable (frontier tasks/decisions), waiting (`waits_for` unmet), summary (case overview).
- `sink.planProjection` → `sink.applyProjection` is split so you can preview before applying.
- `sink.pullChanges` returns a `GraphPatch` with `generator.kind = "sync"`. `cg sync pull` **first appends `projection.pulled`** and **then** rewrites the patch's `base_revision` to the post-append revision. Do not reorder; swapping makes the subsequent `cg patch apply` stale.
- Reverse sync is deliberately narrow: external item completed → internal `done` proposal, external reopen → `todo` proposal, external note → attachment suggestion. External dependency graphs are never reflected back (`docs/spec/08-projections.md §8.8`).

Todoist, GitHub Issues, and Taskwarrior are **optional** — not part of the core roadmap.

## Worker: shell / local-llm / code-agent

```
cg worker run --case <case_id> --worker <shell|local-llm|code-agent> \
  --task <task_id> [--output <patch.json>] [--approve|--deny] [--timeout <ms>]
```

### Audit order (invariant)

```
worker.dispatched event
  → worker.execute RPC
    → worker.finished event
      → if a patch was returned: rewrite base_revision, write --output,
        then apply via cg patch apply
```

`worker.dispatched` is appended **before** the RPC so a worker that never returns still leaves a trail. `worker.finished` is appended **before** any thrown error, so timeouts, plugin crashes, and normal completion all produce an audit record. Client-side timeout (`--timeout`) appends a failed `worker.finished` before throwing `worker_timeout`.

### Approval policy

`config.approval_policy.<worker_name>` values:
- `auto` — auto-approve (pure workers)
- `require` — human `--approve` required (effectful workers — default)
- `deny` — refuse to run

Defaults: `shell` and `code-agent` require approval; `local-llm` auto-approves.

### Built-in workers

- **shell** — runs a fixed command; records stdout and exit code in `worker.finished` metadata. Never modifies graph state.
- **local-llm** — POSTs to an Ollama-compatible `/api/generate` with `stream: true`. `OLLAMA_HOST` and `CASEGRAPH_LOCAL_LLM_MODEL` override defaults. Streams append live to `.casegraph/cases/<id>/worker-logs/<command_id>.log`.
- **code-agent** — spawns an external CLI (default `claude --print`) via `CASEGRAPH_CODE_AGENT_CMD`. Prompt on stdin, patch extracted from stdout using the fenced-block convention.

Both AI workers retry once on extraction failure using `buildRetryPrompt(...)`. The retry is contained inside the plugin, so `worker.execute` stays 1:1 with `worker.dispatched` / `worker.finished`.

### Fenced-block extraction (`docs/spec/07-worker-protocol.md §7.10a`)

A worker returns the patch as a fenced block labeled `casegraph-patch` containing `GraphPatch` JSON. Extraction prefers the last `casegraph-patch` fence, then the last `json` fence. No fence → `status: "failed"`, `patch: null` (no exception). Bad patch shape → `worker_patch_invalid`, exit 2.

### Minimal worker config

```yaml
# .casegraph/config.yaml
workers:
  code-agent:
    env_allowlist: ["CASEGRAPH_CODE_AGENT_CMD"]
  local-llm:
    env_allowlist: ["OLLAMA_HOST", "CASEGRAPH_LOCAL_LLM_MODEL"]
approval_policy:
  shell: require
  code-agent: require
  local-llm: auto
```

## Storage verification and recovery

Events are the source of truth. `case.yaml` and `.casegraph/cache/state.sqlite` are projections rebuilt on every mutation. If they drift, rebuild.

- `cg validate` — graph-level checks (node kind vs state, edge endpoints exist, no cycles where forbidden, `waits_for` well-formed).
- `cg validate storage` — replays `events.jsonl` and compares with `case.yaml` and the SQLite cache. Reports drift.
- `cg cache rebuild` — regenerates the SQLite cache from events and rewrites `case.yaml`.
- `cg events verify` — checks the event log's hash chain, monotonic revisions, and schema integrity.
- `cg events export --case <id> --format jsonl|json` — dumps events for backup, analysis, or conformance fixtures.
- `cg migrate check` and `cg migrate run [--dry-run]` — spec_version compatibility checks. `0.1-draft` is a no-op; unsupported versions produce `migration_unsupported_version` (exit 2).

## Anti-patterns

- Leaking `process.env` into a plugin by skipping the `env_allowlist`. The allowlist is the trust boundary.
- Auto-applying an importer's output in a single pipeline. Import writes a patch; a separate explicit step decides whether to apply.
- Applying `sink.pullChanges` output before the `projection.pulled` event is recorded. Order matters for `base_revision`.
- Reordering `worker.dispatched` / `worker.finished`. Even on timeout or crash, both events must appear.
- Editing `.casegraph/cache/state.sqlite` with raw SQL. The next mutation overwrites it.
- Introducing a new event kind without extending both `replayCaseEvents` and the SQLite `rebuildCaseCache` — the cache will silently diverge.

## Related

- Reading / authoring the graph → `casegraph`
- The `GraphPatch` pipeline and shape → `casegraph-patch`
- Spec: `docs/spec/06-adapter-protocol.md`, `07-worker-protocol.md`, `08-projections.md`, `09-security-and-trust.md`; `docs/adr/0005-jsonrpc-stdio-plugin-protocol.md`
