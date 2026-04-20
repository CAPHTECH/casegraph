# Evidence integrity rules

Formal rules applied in Phase C of the review loop. The ordering is important: each rule has a severity, and a severity downgrade path when specific conditions are met.

All rules operate on:
- `snapshot` = `cg case show --case <id> --format json | .data`
- `events` = `cg events export --case <id> --format json | .data`

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

**Statement.** An `evidence` node's `description` field must carry substantive content. "Substantive" is defined operationally:

- length ≥ 20 characters, AND
- does not match (case-insensitive) the regex `^(実施|完了|done|ok|yes|finished)[.。]?$`, AND
- is not purely whitespace plus punctuation.

**Detection.**

```
for n in snapshot.nodes where n.kind == "evidence":
  desc := n.description or ""
  if len(desc) < 20 or desc.matches(placeholder_regex):
    emit YELLOW empty-evidence { node_id: n.node_id, description_len: len(desc) }
```

**Downgrade to 🟢 note.** When the evidence node has substantive metadata instead — at least one of `metadata.file`, `metadata.url`, `metadata.pr_url`, `metadata.commit_sha`, `metadata.test` — the empty description is acceptable. The artifact reference itself carries the signal.

---

## Rule 3 — `just-in-time-evidence` (🟡)

**Statement.** The `evidence.attached` event for an evidence node and the `node.state_changed` → `done` event for its verified target must not be suspiciously adjacent in time.

**Definition.** Let:
- `t_evidence` = `created_at` of the `evidence.attached` event whose payload references the evidence node
- `t_done` = `created_at` of the `node.state_changed` event with `payload.to_state == "done"` for the target node

If `|t_done - t_evidence| ≤ 2 seconds`, the evidence is just-in-time. Severity:

- 0 s delta (same second): strong suspicion. Emit 🟡 with `severity_hint: near-certain`.
- 1–2 s delta: weak suspicion. Emit 🟡 with `severity_hint: plausible-batch`.
- \> 2 s delta: no finding.

**Detection.**

```
for ev in events where ev.kind == "evidence.attached":
  evidence_id := ev.payload.node_id
  target_id := verifies_edge_source(evidence_id)   # via snapshot.edges
  if target_id is None: continue
  done_ev := first(events where
    ev2.kind == "node.state_changed" and
    ev2.payload.node_id == target_id and
    ev2.payload.to_state == "done")
  if done_ev is None: continue
  delta := abs(parse_iso(ev.created_at) - parse_iso(done_ev.created_at))
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
                    ev.kind == "node.state_changed" and
                    ev.payload.node_id == n.node_id ]
  if any(ev.payload.to_state == "failed" for ev in transitions):
    last_failed := last such event
    final_done := last event with to_state == "done"
    intervening_evidence := any(ev for ev in events where
      ev.kind == "evidence.attached" and
      verifies_edge_source(ev.payload.node_id) == n.node_id and
      last_failed.created_at < ev.created_at < final_done.created_at)
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
