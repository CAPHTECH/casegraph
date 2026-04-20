# Event trail jq cookbook

Phase E patterns for `cg events export --case <id> --format json`. All snippets assume the export is saved at `/tmp/cg-review-events.json` and the case snapshot at `/tmp/cg-review-snapshot.json` (set by Phase A).

Events have shape:

```json
{ "kind": "...",
  "event_id": "ulid",
  "created_at": "2026-04-20T10:15:30Z",
  "actor": { "kind": "human|agent|worker|importer|sync", "name": "..." },
  "payload": { "..." : "..." } }
```

Common event kinds encountered:

- `patch.applied`
- `node.state_changed`
- `evidence.attached`
- `worker.dispatched` / `worker.finished`
- `projection.pushed` / `projection.pulled`
- `case.opened` / `case.closed`

---

## Since-revision / since-timestamp filter

Use these as a prefix inside any later `jq` pipeline. The variable `since` is supplied by the skill when `--since-revision` is set; otherwise 0.

```sh
# --since-revision
jq --argjson since 42 '.data | map(select(.revision > $since))' /tmp/cg-review-events.json

# --since-timestamp
jq --arg since "2026-04-20T00:00:00Z" '.data | map(select(.created_at >= $since))' /tmp/cg-review-events.json
```

Save the clipped result once:

```sh
jq --argjson since 42 '.data | map(select(.revision > $since))' /tmp/cg-review-events.json > /tmp/cg-review-events.clip.json
```

Everything below operates on the clipped array. Substitute `.data` if you skipped clipping.

---

## 1. Patches by generator.kind

```sh
jq '
  map(select(.kind == "patch.applied"))
  | group_by(.payload.generator.kind)
  | map({ actor: .[0].payload.generator.kind, count: length,
          summaries: map(.payload.summary) | .[0:3] })
' /tmp/cg-review-events.clip.json
```

Use the count breakdown for the "Actor distribution" 🟢 note. Sample up to 3 summaries per actor to paste into the report for context.

---

## 2. AI patches without an accompanying evidence attachment

An AI-authored patch (`generator.kind in {agent, worker}`) that claims task progress should be accompanied by an `evidence.attached` event on at least one of the patch's affected nodes, within the same clip window.

```sh
jq '
  (map(select(.kind == "evidence.attached")) | map(.payload.target_id // empty)) as $verified_targets
  | map(select(.kind == "patch.applied" and
               (.payload.generator.kind == "agent" or .payload.generator.kind == "worker")))
  | map({
      patch_id: .payload.patch_id,
      summary: .payload.summary,
      affected: (.payload.operations // [] | map(.node_id // .node.node_id // empty) | unique),
      at: .created_at
    })
  | map(. + { evidenced: (any(.affected[]; . as $n | $verified_targets | index($n))) })
  | map(select(.evidenced | not))
' /tmp/cg-review-events.clip.json
```

Each entry returned is a 🟡 `ai-patch-without-evidence` finding. The `affected` list and `summary` let the reviewer decide whether evidence was reasonable to expect.

False positives: patches that only change metadata / labels / descriptions, not state. Filter those out by restricting to operations whose `op` is `change_state` or `add_node` with a substantive `kind`:

```sh
# stricter: only patches that touched task/decision state
jq '
  map(select(.kind == "patch.applied"))
  | map(select(.payload.generator.kind == "agent" or .payload.generator.kind == "worker"))
  | map(select((.payload.operations // [])
      | any(.op == "change_state" and (.to_state == "done" or .state == "done"))))
' /tmp/cg-review-events.clip.json
```

Combine with the "no evidence" filter above to reduce noise.

---

## 3. Orphan workers

A `worker.dispatched` without a matching `worker.finished` indicates a worker started and never reported back. Always 🔴.

```sh
jq '
  (map(select(.kind == "worker.finished"))
   | map({ w: (.payload.worker_name // .payload.worker),
           n: .payload.node_id,
           d: .payload.dispatched_event_id })) as $done
  | map(select(.kind == "worker.dispatched"))
  | map({
      dispatched_id: .event_id,
      worker: (.payload.worker_name // .payload.worker),
      node: .payload.node_id,
      at: .created_at
    })
  | map(. + {
      matched: (. as $d | $done
                 | map(select((.d == $d.dispatched_id)
                         or (.w == $d.worker and .n == $d.node)))
                 | length > 0)
    })
  | map(select(.matched | not))
' /tmp/cg-review-events.clip.json
```

`worker.finished` payload schemas vary by worker. The query matches on either the explicit `dispatched_event_id` back-reference or the `(worker_name, node_id)` pair as fallback.

---

## 4. Cancel / fail history

Surface every transition to `cancelled` or `failed`, plus whether the node later became `done` (reversal pattern).

```sh
jq '
  map(select(.kind == "node.state_changed"))
  | group_by(.payload.node_id)
  | map({
      node: .[0].payload.node_id,
      transitions: map({ at: .created_at, to: .payload.to_state,
                         reason: .payload.reason }),
      final: (last.payload.to_state)
    })
  | map(select(.transitions | map(.to) | any(. == "cancelled" or . == "failed")))
' /tmp/cg-review-events.clip.json
```

Post-process: emit 🟢 `actor-distribution` / `cancel-history` notes for entries whose `final` is `cancelled` (legitimate dead-end) or `failed` (legitimate failure). Emit 🟡 `silent-reversal` for entries whose transitions include `failed` then later `done`; Rule 4 in [evidence-integrity-rules.md](evidence-integrity-rules.md) owns the intervening-evidence check.

---

## 5. Worker timing outliers (🟢 note)

Workers whose `finished` event arrives > 10 minutes after their `dispatched`. Not a failure, but worth surfacing: slow workers often indicate flaky tooling or timeouts that silently retried.

```sh
jq '
  (map(select(.kind == "worker.dispatched"))
   | map({ id: .event_id, at: .created_at,
           worker: (.payload.worker_name // .payload.worker),
           node: .payload.node_id })) as $dispatched
  | map(select(.kind == "worker.finished"))
  | map({
      worker: (.payload.worker_name // .payload.worker),
      node: .payload.node_id,
      finished_at: .created_at,
      dispatched_at: (. as $f | $dispatched
                        | map(select(.worker == $f.payload.worker_name
                                     and .node == $f.payload.node_id))
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

```sh
jq '{
  first_event: (.[0] | { revision, at: .created_at }),
  last_event:  (.[-1] | { revision, at: .created_at }),
  total: length
}' /tmp/cg-review-events.clip.json
```

Populates the Report "Health" block.

---

## 7. Event-kind histogram

```sh
jq '
  group_by(.kind) | map({ kind: .[0].kind, n: length })
  | sort_by(-.n)
' /tmp/cg-review-events.clip.json
```

Useful as a quick sanity check — an unusually large number of `node.state_changed` without a proportionate `evidence.attached` count hints at under-documentation.

---

## Notes on portability

- The jq patterns assume the CaseGraph event envelope shape as of spec 0.1-draft. If the envelope evolves, update the field paths in a single place and re-run against a recent export to confirm.
- When the skill runs `jq` inside a Bash command, quote single-quotes inside expressions by breaking into multiple `-f` files or using `jq -n --argjson ...` to pass data from flags. Inline multi-line scripts are fine for the report skill because the output is human-read, not programmatically consumed.
