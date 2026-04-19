# `cg` CLI cheatsheet

A compact reference of the verbs and flags the skill uses. Read this **first** when a command you need is not in the SKILL.md skeleton — it covers more than the skeleton and avoids round-trips to `cg <verb> --help`.

Authoritative sources, in order: (1) `docs/spec/05-cli.md` inside the CaseGraph repo, (2) `cg <verb> --help`, (3) this cheatsheet. If they disagree, the earlier wins and this file should be updated.

## Global conventions

- **Global flags** (accepted on any subcommand): `--workspace <path>`, `--format <text|json>` (default `text`), `--quiet`, `--verbose`.
- **Workspace resolution**: `--workspace` → `$CASEGRAPH_WORKSPACE` → nearest `.casegraph/` ancestor of cwd.
- **JSON output shape**: `{ok, command, data, revision?: {current, last_event_id}}`. Read `.data...` in jq.
- **Exit codes**: `0` ok · `2` validation · `3` not found · `4` conflict (e.g. stale `base_revision`).
- **Revision**: almost every read command returns `.revision.current` (an integer). Used as `base_revision` in patches.

## Workspace / Case

| Verb | Required | Optional | Notes |
|---|---|---|---|
| `cg init` | — | `--title <str>` | Creates `.casegraph/` in cwd |
| `cg case new` | `--id <caseId>` `--title <str>` | `--description <str>` | |
| `cg case list` | — | — | JSON: `data.cases[]` |
| `cg case show` | `--case <caseId>` | — | Returns `CaseStateView` (nodes/edges/derived/validation) |
| `cg case view` | `--case <caseId>` | — | ASCII dependency tree (`data.tree_lines`) + structured data |
| `cg case close` | `--case <caseId>` | `--force` | `--force` needed if validation warnings remain |

Close gates: `frontier == []`, every goal terminal, zero validation errors.

## Graph editing

| Verb | Required | Optional | Notes |
|---|---|---|---|
| `cg node add` | `--case` `--kind <k>` `--title` | `--id` `--description` `--state` `--labels` `--acceptance` `--metadata <json>` | `--state` default `todo` |
| `cg node update` | `--case` `--id <nodeId>` | `--title` `--description` `--state` `--labels` `--acceptance` `--metadata` | Passing `--state` emits `node.state_changed` event |
| `cg edge add` | `--case` `--type <t>` | `--from`/`--source` `--to`/`--target` `--id` | `--from` and `--source` are aliases; same for `--to` / `--target` |
| `cg edge remove` | `--case` `--id <edgeId>` | — | |

### `--metadata` JSON shape

Pass a JSON string. Example:
```sh
cg node update --case c1 --id task_x \
  --metadata '{"assignees":["alice"],"priority":"high","due_at":"2026-05-31"}'
```

Standard keys consumed by this skill's GitHub projection: `assignees: string[]`, `priority: "high"|"medium"|"low"|number` (see `packages/kernel/src/helpers.ts:123`), `due_at: ISO8601`.

### `--labels` / `--acceptance`

Comma-separated strings: `--labels "security,p1"` → `["security","p1"]`. Empty string clears to `[]`.

## State transitions

All task-family verbs take positional `<nodeIds...>` (space-separated) and `--case`. State transitions are event-sourced; each call appends one event.

| Verb | Target state | Extra flags |
|---|---|---|
| `cg task start <id...>` | `doing` | — |
| `cg task done <id...>` | `done` | — |
| `cg task wait <id...>` | `waiting` | `--reason <str>` `--for <eventNodeId>` |
| `cg task resume <id...>` | `todo` | — |
| `cg task cancel <id...>` | `cancelled` | — |
| `cg task fail <id...>` | `failed` | — |
| `cg decision decide <id...>` | `done` | `--result <str>` |
| `cg event record <id...>` | `done` | — (must pre-exist as `kind:event`, else exit 2/3) |
| `cg evidence add` | creates evidence node | `--case` `--title` required; `--id` `--target <verifyTarget>` `--description` `--file` `--url` optional |

Note: `cg task done` is today the generic "mark a node as `done`"; it also works on `kind:goal` (there is no dedicated `goal done` yet).

## Analysis

| Verb | Required | Optional |
|---|---|---|
| `cg frontier` | `--case` | — |
| `cg blockers` | `--case` | — |
| `cg validate [storage]` | (`--case` when not `storage`) | — |
| `cg analyze impact` | `--case` `--node` | — |
| `cg analyze critical-path` | `--case` | `--goal` |
| `cg analyze slack` | `--case` | `--goal` |
| `cg analyze bottlenecks` | `--case` | `--goal` |
| `cg analyze unblock` | `--case` `--node` | — |
| `cg analyze cycles` | `--case` | `--goal` |
| `cg analyze components` | `--case` | `--goal` |
| `cg analyze bridges` | `--case` | `--goal` |
| `cg analyze cutpoints` | `--case` | `--goal` |
| `cg analyze fragility` | `--case` | `--goal` |

`--goal <goalNodeId>` narrows analysis to the subgraph that contributes to a specific goal.

## Patches

All three take `--file <path>` (JSON or YAML, extension-detected). No stdin support.

| Verb | Effect |
|---|---|
| `cg patch validate --file <p>` | schema only |
| `cg patch review --file <p>` | schema + `base_revision` check + op dry-run |
| `cg patch apply --file <p>` | above + append `patch.applied` event |

Exit 4 on stale `base_revision`. Rewrite `base_revision` from `cg case show` output before retrying.

## Sync / Workers

| Verb | Required | Optional |
|---|---|---|
| `cg sync push` | `--sink <name>` `--case` | `--apply` |
| `cg sync pull` | `--sink <name>` `--case` `--output <path>` | — |
| `cg worker run` | `--worker <name>` `--case` `--node` | `--approve` `--output <path>` `--timeout <seconds>` |
| `cg import markdown` | `--case` `--file <path>` | `--output <path>` |

`cg sync pull` writes a `GraphPatch` to `--output`; then apply via `cg patch apply`.

## Storage / Admin

| Verb | Effect |
|---|---|
| `cg validate storage` | workspace + case metadata + event log + cache integrity |
| `cg cache rebuild` | rebuild SQLite cache from event log |
| `cg events verify --case <id>` | event envelope + replay integrity |
| `cg events export --case <id>` | raw event stream |
| `cg migrate check [--patch-file <p>]*` | scan spec_version, report pending steps |
| `cg migrate run [--dry-run] [--patch-file <p>]*` | apply known migrations |

`--patch-file` is repeatable to scan explicit patch files.

## Enum reference

| NodeKind | NodeState | EdgeType |
|---|---|---|
| `goal` | `proposed` | `depends_on` |
| `task` | `todo` | `waits_for` |
| `decision` | `doing` | `alternative_to` |
| `event` | `waiting` | `verifies` |
| `evidence` | `done` | `contributes_to` |
| | `cancelled` | |
| | `failed` | |

## JSON extraction cookbook

Common jq patterns the skill relies on. Pipe `cg ... --format json | jq ...`.

- Current revision: `.revision.current`
- Frontier node ids: `.data.nodes[].node_id`
- Frontier by state: `.data.nodes | group_by(.state)`
- Blocker reasons: `.data.items[] | {node: .node.node_id, reasons: .reasons}`
- Projection mappings (code-sink only): `.data.projection_mappings`
- Events of a kind: `.data.events[] | select(.kind == "patch.applied")`

## When to prefer `--help` over this file

- You see a flag in `--help` that is not here (flag drift — please patch this file in the same PR).
- A command exits 2 and the message references an option this file does not cover.
- You need the exact wording of an option's help text for an error-path message.

Otherwise this file should be enough to write the command correctly on the first try.
