---
name: casegraph
description: Use when reading, manually authoring, or analyzing a CaseGraph workspace through the `cg` CLI. Trigger on references to `.casegraph/`, `cg case`, `cg node`, `cg edge`, `cg task`, `cg frontier`, `cg blockers`, `cg analyze`, `cg case view`, or phrases like "show the case", "what's blocked", "analyze impact", "create a case", "show the frontier". Do NOT use for AI-proposed graph changes (use casegraph-patch) or for importer/sink/worker/storage recovery (use casegraph-integrate).
---

# CaseGraph workspace

## Overview

CaseGraph is an event-sourced, local-first case graph substrate. The `cg` CLI is the primary surface for reading a workspace, hand-editing cases (nodes, edges, tasks, decisions, events, evidence), and running structural analysis (`frontier`, `blockers`, `analyze *`, topology surfaces). This skill covers the read / manual-authoring / analysis path.

For AI-proposed changes use **casegraph-patch**. For importers, sinks, workers, and recovery use **casegraph-integrate**.

## Workspace resolution

The CLI finds the workspace (the nearest directory containing `.casegraph/`) in this order:

1. `--workspace <path>` flag
2. `CASEGRAPH_WORKSPACE` environment variable
3. Walk upward from the current working directory until `.casegraph/` is found

If unsure whether one exists, check `ls .casegraph/workspace.yaml`. If absent, initialize with `cg init --title "..."`.

## Output contract

Every frozen core command accepts `--format json`. The shape is:

- Success: `{ "ok": true, "data": ... }`
- Failure: `{ "ok": false, "error": { "code": "...", "message": "..." } }`

Always use `--format json` from scripts and check `ok` before using `data`.

## Exit codes (frozen)

| Code | Meaning |
|------|---------|
| 0 | success |
| 2 | validation error |
| 3 | not found |
| 4 | conflict (e.g. stale `base_revision`) |

Check exit code and `error.code` together for granularity.

## CLI surface

### Workspace / case
- `cg init --title <title>`
- `cg case new --id <case_id> --title <title> [--description <text>]`
- `cg case list`
- `cg case show --case <case_id>` — counts and frontier summary
- `cg case view --case <case_id>` — read-only ASCII dependency tree

### Graph editing (hand-authoring)
- `cg node add --case <id> --id <node_id> --kind <task|decision|event|evidence|goal> --title <t> [--state <todo|doing|waiting|done|cancelled|failed>]`
- `cg node update --case <id> <node_id> [--title ...] [--metadata key=value ...]`
- `cg edge add --case <id> --id <edge_id> --type <depends_on|waits_for|contributes_to|verifies|alternative_of> --from <from_id> --to <to_id>`
- `cg edge remove --case <id> <edge_id>`

### State transitions
- `cg task start|done|wait|resume|cancel|fail --case <id> <task_id> [...]`
  - `wait` accepts `--reason <text>` and `--for <event_id>`
- `cg decision decide --case <id> <decision_id> [--result <text>]`
- `cg event record --case <id> <event_id>`
- `cg evidence add --case <id> --id <id> --for <node_id> [--note <text>]`

### Frontier and blockers
- `cg frontier --case <id>` — actionable set (`state in {todo, doing}` and `is_ready = true`)
- `cg blockers --case <id>` — blocked nodes with blocker reasons (failed edge / unmet `waits_for` / unresolved dependency)

### Analysis (unfrozen surface — names may change)
- `cg analyze impact --case <id> --from <node_id>`
- `cg analyze critical-path --case <id>`
- `cg analyze slack --case <id> [--goal <node_id>]`
- `cg analyze bottlenecks --case <id> [--goal <node_id>]`
- `cg analyze unblock --case <id> --target <node_id>`
- `cg cycles --case <id>` / `cg components --case <id>`
- `cg bridges --case <id>` / `cg cutpoints --case <id>` / `cg fragility --case <id>`

Run `cg <command> --help` for the exact flag shape per release.

## Do and don't

Do:
- Go through the CLI for every mutation.
- Parse `--format json` output and check `ok` plus exit code.
- Switch to **casegraph-patch** when the change is AI-reasoned rather than a direct user instruction.

Don't:
- Edit `.casegraph/cases/<case_id>/events.jsonl` directly. It is the append-only source of truth; hand edits break reducer replay.
- Treat `case.yaml` or `.casegraph/cache/state.sqlite` as authoritative. Both are projections rebuilt from events. If they drift, run `cg cache rebuild` and `cg validate storage`.
- Remove `.casegraph/.lock` manually. Another `cg` process may be active.

## Gotchas

- `node:sqlite` requires Node 22+. Not guarded in code.
- `cg case view` is read-only by design.
- The analysis surface is outside the Phase 0 freeze. Expect renames.
- A PostToolUse hook (`.claude/hooks/biome-check.sh`) runs `biome check --write` on edited `.ts` / `.json` files inside `packages/**` and `tests/**`. Other paths are skipped.

## Related

- AI-authored graph changes → `casegraph-patch`
- Importers / sinks / workers / recovery → `casegraph-integrate`
- Normative spec: `docs/spec/01-domain-model.md`, `03-state-and-frontier.md`, `05-cli.md`, `11-schema-reference.md`
