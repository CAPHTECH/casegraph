# Event trail jq cookbook

Phase E patterns for `cg events export --case <id> --format json`. All snippets assume the export is saved at `/tmp/cg-review-events.json` and the case view snapshot at `/tmp/cg-review-view.json` (set by Phase A via `cg case view --case <id> --format json`).

The full CLI result is shaped `{ ok, command, data: { case_id, events: [...] } }`, so unwrap with `.data.events` before any pipeline.

Events have shape (from `packages/kernel/src/types.ts::EventEnvelope`):

```json
{ "type": "...",
  "event_id": "ulid",
  "spec_version": "0.1-draft",
  "case_id": "...",
  "timestamp": "2026-04-20T10:15:30Z",
  "actor": { "kind": "human|agent|worker|importer|sync", "name": "..." },
  "source": "cli|patch|worker|sync",
  "payload": { "...": "..." },
  "command_id": "...",
  "correlation_id": "...",
  "causation_id": "...",
  "revision_hint": 42 }
```

Relevant payload shapes encountered below:

- `patch.applied`: `{ patch: GraphPatch }` — read `payload.patch.generator.kind`, `payload.patch.operations`, `payload.patch.summary`, `payload.patch.patch_id`.
- `evidence.attached`: `{ node: NodeRecord, verifies_edge?: EdgeRecord, attachment?: AttachmentRecord }` — read `payload.node.node_id` for the evidence id and `payload.verifies_edge.target_id` for the verified target.
- `node.state_changed`: `{ node_id, state, metadata? }` — note `state`, not `to_state`.
- `worker.dispatched` / `worker.finished`: `{ worker_name, node_id, command_id, ... }` — match the pair by `command_id`.

Common event kinds encountered:

- `patch.applied`
- `node.state_changed`
- `evidence.attached`
- `worker.dispatched` / `worker.finished`
- `projection.pushed` / `projection.pulled`
- `case.created` / `case.updated`

---

## Since-revision / since-timestamp filter

Use these as a prefix inside any later `jq` pipeline. The variable `since` is supplied by the skill when `--since-revision` is set; otherwise 0.

`revision_hint` is optional, so the filter must guard against `null`.

```sh
# --since-revision
jq --argjson since 42 '.data.events | map(select((.revision_hint // 0) > $since))' /tmp/cg-review-events.json

# --since-timestamp
jq --arg since "2026-04-20T00:00:00Z" '.data.events | map(select(.timestamp >= $since))' /tmp/cg-review-events.json
```

Save the clipped result once:

```sh
jq --argjson since 42 '.data.events | map(select((.revision_hint // 0) > $since))' /tmp/cg-review-events.json > /tmp/cg-review-events.clip.json
```

Everything below operates on the clipped array. Substitute `.data.events` if you skipped clipping.

---

## 1. Patches by generator.kind

`generator` is optional on `GraphPatch`; fall back to `"unknown"` so grouping still yields a bucket for patches that omit it.

```sh
jq '
  map(select(.type == "patch.applied"))
  | group_by(.payload.patch.generator.kind // "unknown")
  | map({ actor: (.[0].payload.patch.generator.kind // "unknown"),
          count: length,
          summaries: map(.payload.patch.summary) | .[0:3] })
' /tmp/cg-review-events.clip.json
```

Use the count breakdown for the "Actor distribution" 🟢 note. Sample up to 3 summaries per actor to paste into the report for context.

---

## 2. AI patches without an accompanying evidence attachment

An AI-authored patch (`generator.kind in {agent, worker}`) that claims task progress should be accompanied by an `evidence.attached` event whose `verifies_edge.target_id` matches at least one of the patch's affected nodes, within the same clip window.

```sh
jq '
  (map(select(.type == "evidence.attached"))
   | map(.payload.verifies_edge.target_id // empty)) as $verified_targets
  | map(select(.type == "patch.applied" and
               ((.payload.patch.generator.kind // "") == "agent"
                or (.payload.patch.generator.kind // "") == "worker")))
  | map({
      patch_id: .payload.patch.patch_id,
      summary: .payload.patch.summary,
      affected: (.payload.patch.operations // []
                 | map(.node_id // .node.node_id // empty)
                 | unique),
      at: .timestamp
    })
  | map(. + { evidenced: (any(.affected[]; . as $n | $verified_targets | index($n))) })
  | map(select(.evidenced | not))
' /tmp/cg-review-events.clip.json
```

Each entry returned is a 🟡 `ai-patch-without-evidence` finding. The `affected` list and `summary` let the reviewer decide whether evidence was reasonable to expect.

False positives: patches that only change metadata / labels / descriptions, not state. Filter those out by restricting to operations whose `op` is `change_node_state` setting `state == "done"`, or `add_node` with a substantive `kind`:

```sh
# stricter: only patches that touched task/decision state
jq '
  map(select(.type == "patch.applied"))
  | map(select((.payload.patch.generator.kind // "") == "agent"
               or (.payload.patch.generator.kind // "") == "worker"))
  | map(select((.payload.patch.operations // [])
      | any(.op == "change_node_state" and .state == "done")))
' /tmp/cg-review-events.clip.json
```

Combine with the "no evidence" filter above to reduce noise.

---

## 3. Orphan workers

A `worker.dispatched` without a matching `worker.finished` indicates a worker started and never reported back. Always 🔴. Match the pair by `command_id` (issued once per dispatch; echoed on `finished`).

```sh
jq '
  (map(select(.type == "worker.finished"))
   | map({ cid: .payload.command_id,
           w: .payload.worker_name,
           n: .payload.node_id })) as $done
  | map(select(.type == "worker.dispatched"))
  | map({
      dispatched_id: .event_id,
      command_id: .payload.command_id,
      worker: .payload.worker_name,
      node: .payload.node_id,
      at: .timestamp
    })
  | map(. + {
      matched: (. as $d | $done
                 | map(select(.cid == $d.command_id
                         or (.w == $d.worker and .n == $d.node)))
                 | length > 0)
    })
  | map(select(.matched | not))
' /tmp/cg-review-events.clip.json
```

The query matches primarily by `command_id`, falling back to the `(worker_name, node_id)` pair for robustness across worker implementations.

---

## 4. Cancel / fail history

Surface every transition to `cancelled` or `failed`, plus whether the node later became `done` (reversal pattern). Note that `node.state_changed` uses `payload.state` (not `to_state`).

```sh
jq '
  map(select(.type == "node.state_changed"))
  | group_by(.payload.node_id)
  | map({
      node: .[0].payload.node_id,
      transitions: map({ at: .timestamp,
                         to: .payload.state,
                         reason: (.payload.metadata.last_wait_reason // null) }),
      final: (last.payload.state)
    })
  | map(select(.transitions | map(.to) | any(. == "cancelled" or . == "failed")))
' /tmp/cg-review-events.clip.json
```

Post-process: emit 🟢 `cancel-history` notes for entries whose `final` is `cancelled` (legitimate dead-end) or `failed` (legitimate failure). Emit 🟡 `silent-reversal` for entries whose transitions include `failed` then later `done`; Rule 4 in [evidence-integrity-rules.md](evidence-integrity-rules.md) owns the intervening-evidence check.

---

## 5. Worker timing outliers (🟢 note)

Workers whose `finished` event arrives > 10 minutes after their `dispatched`. Not a failure, but worth surfacing: slow workers often indicate flaky tooling or timeouts that silently retried. Pair by `command_id`.

```sh
jq '
  (map(select(.type == "worker.dispatched"))
   | map({ cid: .payload.command_id,
           at: .timestamp,
           worker: .payload.worker_name,
           node: .payload.node_id })) as $dispatched
  | map(select(.type == "worker.finished"))
  | map({
      worker: .payload.worker_name,
      node: .payload.node_id,
      command_id: .payload.command_id,
      finished_at: .timestamp,
      dispatched_at: (. as $f | $dispatched
                        | map(select(.cid == $f.payload.command_id))
                        | first | .at)
    })
  | map(select(.dispatched_at))
  | map(. + { delta_s: (((.finished_at | fromdateiso8601)
                        - (.dispatched_at | fromdateiso8601))) })
  | map(select(.delta_s > 600))
' /tmp/cg-review-events.clip.json
```

---

## 6. Revision range covered

`revision_hint` is optional on each event envelope; fall back to `null` when absent.

```sh
jq '{
  first_event: (.[0] | { revision_hint: (.revision_hint // null), at: .timestamp }),
  last_event:  (.[-1] | { revision_hint: (.revision_hint // null), at: .timestamp }),
  total: length
}' /tmp/cg-review-events.clip.json
```

Populates the Report "Health" block. The authoritative current revision lives on `cg case show`'s `data.revision.current` — use that for the report's "Revision" header, and this query only to describe the clipped window.

---

## 7. Event-type histogram

```sh
jq '
  group_by(.type) | map({ type: .[0].type, n: length })
  | sort_by(-.n)
' /tmp/cg-review-events.clip.json
```

Useful as a quick sanity check — an unusually large number of `node.state_changed` without a proportionate `evidence.attached` count hints at under-documentation.

---

## Notes on portability

- The jq patterns track the CaseGraph event envelope shape as of spec 0.1-draft (`packages/kernel/src/types.ts`). If the envelope evolves, update the field paths in a single place and re-run against a recent export to confirm.
- When the skill runs `jq` inside a Bash command, quote single-quotes inside expressions by breaking into multiple `-f` files or using `jq -n --argjson ...` to pass data from flags. Inline multi-line scripts are fine for the report skill because the output is human-read, not programmatically consumed.
