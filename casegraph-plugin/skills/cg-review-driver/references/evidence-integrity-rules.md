# Evidence integrity rules

Formal rules applied in Phase C of the review loop. The ordering is important: each rule has a severity, and a severity downgrade path when specific conditions are met.

All rules operate on:
- `snapshot` = `cg case view --case <id> --format json | .data` — the view command exposes the full `nodes[]` / `edges[]` arrays. `cg case show` only carries a summary.
- `events` = `cg events export --case <id> --format json | .data.events` — the full CLI result is `{ ok, data: { case_id, events: [...] } }`.

Per `packages/kernel/src/types.ts`, the event envelope uses `type` / `timestamp` / optional `revision_hint`. Payload shapes cited below:
- `evidence.attached`: `{ node, verifies_edge?, attachment? }` — the evidence node id is `payload.node.node_id`; the verified target is `payload.verifies_edge.target_id`.
- `node.state_changed`: `{ node_id, state, metadata? }` — note `state`, not `to_state`.
- `patch.applied`: `{ patch }` — generator lives at `payload.patch.generator`, operations at `payload.patch.operations`.

---

## Rule 1 — `done-without-verifies` (🔴)

**Statement.** For every node with `kind in {task, decision}` and `state == "done"`, there must be at least one edge with `type == "verifies"` whose `target_id` equals that node's `node_id` and whose `source_id` points to a node with `kind == "evidence"`.

**Detection.**

```
let verified := { e.target_id | e in snapshot.edges, e.type == "verifies" }
let evidence_sources := { e.source_id | e in snapshot.edges, e.type == "verifies" } ∩ { n.node_id | n in snapshot.nodes, n.kind == "evidence" }
for n in snapshot.nodes:
  if n.kind in {task, decision} and n.state == "done":
    if n.node_id not in verified:
      emit RED done-without-verifies { node_id: n.node_id, kind: n.kind, title: n.title }
```

**No downgrade.** Self-declared completion without evidence is the central failure mode this skill guards against. Always 🔴.

**Acceptable narrow exception.** `kind == "goal"` done without verifies is currently tolerated because CaseGraph has no dedicated `goal done` verb and goals are often "done" as a consequence of child task completion. This exception applies to `goal` only; `task` and `decision` remain strict.

---

## Rule 2 — `empty-evidence` (🟡)

**Statement.** An `evidence` node's `description` field must carry substantive content. "Substantive" is defined operationally by the single shared placeholder regex:

```
placeholder_regex := /^(実施|完了|done|ok|yes|finished)[.。]?$/i
```

A description fails Rule 2 when any of the following holds:

- length < 20 characters, OR
- trimmed description matches `placeholder_regex`, OR
- trimmed description is empty (purely whitespace plus punctuation).

Detection uses the exact same `placeholder_regex` — do not inline a second pattern.

**Detection.**

```
placeholder_regex := /^(実施|完了|done|ok|yes|finished)[.。]?$/i
for n in snapshot.nodes where n.kind == "evidence":
  desc := n.description or ""
  trimmed := desc.strip()
  if len(desc) < 20 or trimmed.matches(placeholder_regex) or trimmed == "":
    emit YELLOW empty-evidence { node_id: n.node_id, description_len: len(desc) }
```

**Downgrade to 🟢 note.** When the evidence node has substantive metadata instead — at least one of `metadata.file`, `metadata.url`, `metadata.pr_url`, `metadata.commit_sha`, `metadata.test` — the empty description is acceptable. The artifact reference itself carries the signal.

---

## Rule 3 — `just-in-time-evidence` (🟡)

**Statement.** The `evidence.attached` event for an evidence node and the `node.state_changed` → `done` event for its verified target must not be suspiciously adjacent in time.

**Definition.** Let:
- `t_evidence` = `timestamp` of the `evidence.attached` event whose payload references the evidence node
- `t_done` = `timestamp` of the `node.state_changed` event with `payload.state == "done"` for the target node

If `|t_done - t_evidence| ≤ 2 seconds`, the evidence is just-in-time. Severity:

- 0 s delta (same second): strong suspicion. Emit 🟡 with `severity_hint: near-certain`.
- 1–2 s delta: weak suspicion. Emit 🟡 with `severity_hint: plausible-batch`.
- \> 2 s delta: no finding.

**Detection.** When a target node transitions through `done` more than once (e.g. `done → failed → done`), pick the `done` event nearest to the evidence in time — prefer the first `done` at or after the evidence, otherwise the nearest done by absolute timestamp delta. Fixing on `first(done)` would misjudge late-reopened tasks.

```
for ev in events where ev.type == "evidence.attached":
  evidence_id := ev.payload.node.node_id
  target_id := ev.payload.verifies_edge.target_id    # directly on the event
  if target_id is None: continue
  done_candidates := [ ev2 for ev2 in events where
                        ev2.type == "node.state_changed" and
                        ev2.payload.node_id == target_id and
                        ev2.payload.state == "done" ]
  if done_candidates is empty: continue
  t_ev := parse_iso(ev.timestamp)
  done_ev := first(d in done_candidates where parse_iso(d.timestamp) >= t_ev)
             or min_by(abs(parse_iso(d.timestamp) - t_ev) for d in done_candidates)
  delta := abs(parse_iso(done_ev.timestamp) - t_ev)
  if delta <= 2.0:
    emit YELLOW just-in-time-evidence {
      evidence_id, target_id,
      delta_seconds: delta,
      severity_hint: (delta == 0 ? "near-certain" : "plausible-batch")
    }
```

**Downgrade to 🟢 note.** When the evidence description contains a verifiable artifact reference whose native timestamp is materially older than the evidence event — PR URL with a known `created_at`, commit SHA resolvable via `git show`, test run log with an earlier execution timestamp — the timing finding is downgraded. The artifact existed before the evidence, so the "just-in-time" appearance is a documentation delay rather than fabrication.

Downgrade requires *verifiable* reference, not a claim. `description: "see PR #42"` is not enough unless `metadata.pr_url` is populated or `#42` appears with a `github.com` URL that the report can emit as a Phase F cross-check item.

---

## Rule 4 — `silent-reversal` (🟡)

**Statement.** A node that transitioned through `failed` and later reached `done` should have an evidence attachment dated **between** the two events. The pattern otherwise implies "I tried, it failed, then I quietly declared done without re-proving anything."

**Detection.**

```
for n in snapshot.nodes where n.state == "done":
  transitions := [ ev for ev in events where
                    ev.type == "node.state_changed" and
                    ev.payload.node_id == n.node_id ]
  if any(ev.payload.state == "failed" for ev in transitions):
    last_failed := last such event
    final_done := last event with payload.state == "done"
    intervening_evidence := any(ev for ev in events where
      ev.type == "evidence.attached" and
      ev.payload.verifies_edge.target_id == n.node_id and
      last_failed.timestamp < ev.timestamp < final_done.timestamp)
    if not intervening_evidence:
      emit YELLOW silent-reversal { node_id: n.node_id, failed_at, done_at }
```

**No downgrade.** The whole point of the pattern is that the fix was not documented.

---

## Rule 5 — `verifies-to-non-evidence` (🔴)

**Statement.** A `verifies` edge whose `source_id` points to a node of kind other than `evidence` is a schema-level abuse that this skill should not silently accept.

**Detection.**

```
for e in snapshot.edges where e.type == "verifies":
  src := lookup_node(e.source_id)
  if src is None or src.kind != "evidence":
    emit RED verifies-to-non-evidence { edge_id: e.edge_id, source_kind: src?.kind }
```

**No downgrade.** Schema integrity; validator should have caught this, but the skill re-checks because Phase B's `cg validate` does not enforce edge-endpoint-kind rules universally across future schema changes.

---

## Rule 6 — `verifies-across-cases` (🔴, defensive)

**Statement.** Both endpoints of a `verifies` edge must live in the current case. Trivially true in v0.1 (CaseGraph edges are single-case only), but the rule exists as a forward-looking assertion; if cross-case edges are introduced later, evidence from another case pointed at this case's task is not acceptable without a separate integrity review.

**Detection.** v0.1: no-op (CaseGraph enforces this). Keep the rule entry as a placeholder.

---

## Finding-writing conventions

When emitting a finding, always include:

- `rule_id`: stable name (e.g. `done-without-verifies`)
- `severity`: 🔴 / 🟡 / 🟢
- `node_id` or `edge_id`: the precise target
- a one-line `message`: what a reviewer needs to act on

Do not soften the message based on AI tone. "Task `task_foo` was marked done without a `verifies` edge" is better than "Task `task_foo` appears to be missing verification, which may indicate...". The report is meant to be scanned, not read.

---

## Exception list (project-specific overrides)

Empty in v0.1. If the project adopts conventions that legitimately break a rule (e.g. evidence routinely comes from CI logs and is attached seconds after task completion by a trusted pipeline), add an override section here listing the exact rule, the condition, and the justification. Until that happens, every flag stands.
