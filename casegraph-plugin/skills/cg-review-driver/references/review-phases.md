# Review phases

Six ordered phases. Each has a goal, concrete commands, what to look for, finding classification, and (for Phase B) a hard-stop condition.

All commands are read-only. Never emit `cg node ...`, `cg edge ...`, `cg task ...`, `cg patch apply`, or any other mutating verb from inside these phases. The one exception — `cg evidence add` to record the review — lives outside the phases and runs only on explicit user request.

Inputs the skill accepts:
- `--case <id>` (required)
- `--since-revision <n>` (optional) — clip Phase E to events with `revision > n`
- `--since-timestamp <ISO8601>` (optional) — clip Phase E to events with `created_at >= <ts>`

Output shape is fixed by [report-template.md](report-template.md). Findings accumulate across phases and get rendered in one place at the end.

---

## Phase A — Orientation

**Goal.** Know what you are reviewing before judging anything.

**Commands.**

```sh
cg case show --case <id> --format json > /tmp/cg-review-snapshot.json
cat /tmp/cg-review-snapshot.json | jq '.data.revision.current, .data.caseRecord.state'
cat /tmp/cg-review-snapshot.json | jq '
  .data.nodes | [to_entries[].value]
  | group_by(.kind) | map({kind: .[0].kind, total: length,
      by_state: (group_by(.state) | map({state: .[0].state, n: length}))})
'
```

**What to look for.**

- Revision range covered by the review. If `--since-revision` was passed, the range is `[since+1, current]`; otherwise `[1, current]`.
- Composition of the case: how many `goal`, `task`, `decision`, `event`, `evidence` nodes, and their state distribution.
- Whether `caseRecord.state` is `open` or `closed`. A closed case under review means someone already pulled the trigger on `cg case close`; findings about missing evidence are more severe.

**Findings.**

- No findings emitted directly. This phase just populates the Health block in the report.

---

## Phase B — State Health

**Goal.** Prove the graph is internally consistent before trusting anything later.

**Commands (in order).**

```sh
cg validate --case <id> --format json
cg events verify --case <id> --format json
cg frontier --case <id> --format json
cg blockers --case <id> --format json
```

**What to look for.**

- `validate` returns `errors` and `warnings` counts. Errors > 0 → 🔴.
- `events verify` confirms each event envelope is well-formed and replayable. Failure → **HARD STOP**.
- `frontier` is empty if the case really is done. Non-empty frontier on a case the user claims is "finished" → 🟡.
- `blockers` lists active `depends_on` / `waits_for` / `state` / `cycle` reasons. Active blockers in a claimed-done case → 🟡 (or 🔴 if combined with a done-without-verifies finding in Phase C).

**Findings.**

- 🔴 `validation-error`: validation returned errors. Emit one finding per error with the node id and message.
- 🔴 `event-log-integrity-failure`: events verify failed. Report the first failing event and stop — the rest of the review is unreliable and must be surfaced as "REVIEW ABORTED" in the Verdict block.
- 🟡 `frontier-nonempty-at-review`: case is `open` with `frontier` ≠ ∅ and the user prompted for a completion review.
- 🟡 `blockers-active-at-review`: unresolved blockers exist at review time.

**Hard stop.** If events verify fails, do not run Phases C–F. Render the report with Verdict = 🔴 Red + Summary = "event log integrity failure — graph not trustworthy".

---

## Phase C — Evidence Integrity

**Goal.** Check that every self-declared completion is backed by a `verifies` edge from an `evidence` node, and that the evidence itself is not a token.

Full rules live in [evidence-integrity-rules.md](evidence-integrity-rules.md). This phase applies them against the snapshot.

**Commands.**

```sh
# Done task/decision without any incoming verifies edge
cat /tmp/cg-review-snapshot.json | jq '
  .data.nodes as $n
  | [.data.edges | to_entries[] | .value | select(.type=="verifies") | .target_id] as $verified
  | $n | [to_entries[].value]
  | map(select(.kind == "task" or .kind == "decision"))
  | map(select(.state == "done"))
  | map(select(.node_id as $id | $verified | index($id) | not))
  | map(.node_id)
'

# Empty or placeholder evidence
cat /tmp/cg-review-snapshot.json | jq '
  .data.nodes | [to_entries[].value]
  | map(select(.kind == "evidence"))
  | map({
      node_id,
      description_len: (.description // "" | length),
      title,
      suspicious: ((.description // "" | length) < 20
                   or (.description // "" | test("^(実施|完了|done|ok)$"; "i")))
    })
  | map(select(.suspicious))
'
```

For just-in-time detection, cross-reference the event log (see Phase E's jq cookbook for the full pattern). Per rule, flag evidence whose `evidence.attached` event's `created_at` is within 2 seconds of the verified node's `node.state_changed` → `done` event.

**Findings.**

- 🔴 `done-without-verifies`: a `task` or `decision` node is `done` but no `verifies` edge points at it. Name every such node.
- 🟡 `empty-evidence`: evidence description is <20 chars or matches a placeholder pattern.
- 🟡 `just-in-time-evidence`: evidence attached in the same second (or within 2s) as the target's state change to done. Demote to 🟢 note only when the evidence description references a pre-existing artifact (PR URL, commit hash) whose timestamp predates the evidence — see [evidence-integrity-rules.md](evidence-integrity-rules.md) for the acceptable-exception rule.

---

## Phase D — Decision Traceability

**Goal.** Every completed `decision` should explain itself.

**Commands.**

```sh
cat /tmp/cg-review-snapshot.json | jq '
  .data.nodes | [to_entries[].value]
  | map(select(.kind == "decision"))
  | map({
      node_id, title, state,
      result: (.metadata.result // null),
      has_desc: (((.description // "") | length) > 0)
    })
  | map(select(.state == "done"))
  | map(select(.result == null and (.has_desc | not)))
'

# Alternative-to edges captured
cat /tmp/cg-review-snapshot.json | jq '
  .data.edges | [to_entries[] | .value]
  | map(select(.type == "alternative_to"))
  | group_by(.source_id)
  | map({decision: .[0].source_id, alternatives: map(.target_id)})
'
```

**What to look for.**

- A done decision with neither `metadata.result` nor description is a **naked decision**: the choice is recorded but the reasoning is lost.
- Presence of `alternative_to` edges is a bonus signal that the agent considered alternatives. Missing alternatives is a 🟢 note only (common; not a finding on its own).

**Findings.**

- 🟡 `naked-decision`: decision done without `metadata.result` and with empty description.
- 🟢 `decision-without-alternatives` (informational only, not a blocker).

---

## Phase E — Event Trail Audit

**Goal.** Classify `patch.applied` events by actor, detect orphan workers, and list state transitions the agent may have quietly abandoned.

Detailed jq patterns in [event-trail-jq.md](event-trail-jq.md).

**Commands (pre-clip for `--since-revision` / `--since-timestamp` if set).**

```sh
cg events export --case <id> --format json > /tmp/cg-review-events.json
```

Then apply the cookbook jq patterns to produce:

1. **Patch applications by actor** — count of `patch.applied` events grouped by `payload.generator.kind` (`human` / `agent` / `worker` / `importer` / `sync` / `planner`).
2. **AI patches without evidence** — AI-authored `patch.applied` events (`generator.kind in {agent, worker}`) that do not have an `evidence.attached` event in the same revision range. Flag as 🟡.
3. **Orphan workers** — `worker.dispatched` events without a subsequent `worker.finished` for the same worker + target. Flag as 🔴.
4. **Failure history** — `node.state_changed` events that transitioned to `cancelled` or `failed`. List title, node id, reason, and whether the failure was later reversed. These are 🟢 notes unless a `failed` is immediately followed by a `done` on the same node without evidence — then 🟡.
5. **Worker timing outliers (optional)** — worker runs whose `dispatched`→`finished` delta is > 10 minutes. 🟢 note.

**Findings.**

- 🔴 `orphan-worker`: `worker.dispatched` without matching `worker.finished`.
- 🟡 `ai-patch-without-evidence`: any `patch.applied` with `generator.kind in {agent, worker}` in the review window whose summary claims task progress but has no accompanying `evidence.attached` on a target node in the same revision range.
- 🟡 `silent-reversal`: a node went `failed` → `done` without a new evidence attachment between the two transitions.
- 🟢 `actor-distribution` (informational): pie-of-text showing how much of the work was AI-authored.

---

## Phase F — Reality Cross-Check enumeration

**Goal.** Do not verify — enumerate. The skill collects external references from evidence nodes and renders them as a checklist. The human (or a later tool) runs the actual checks.

**Commands.**

```sh
cat /tmp/cg-review-snapshot.json | jq '
  .data.nodes | [to_entries[].value]
  | map(select(.kind == "evidence"))
  | map({
      evidence_id: .node_id,
      title,
      description,
      file: .metadata.file,
      url: .metadata.url,
      pr: .metadata.pr_url,
      commit: .metadata.commit_sha,
      test: .metadata.test
    })
  | map(select(.file or .url or .pr or .commit or .test or ((.description // "") | test("https?://|#[0-9]+|\\bpackages/|\\btests/"))))
'
```

**What to enumerate.**

- **Files**: values in `metadata.file`, or paths matched by regex in description. Render as `- git log -- <path>  # verify touched` in the report.
- **PRs / issues**: `metadata.pr_url`, or `#N` / `github.com` strings in description. Render as `- gh pr view <n> / gh issue view <n>  # confirm exists`.
- **Commits**: `metadata.commit_sha`. Render as `- git show <sha>  # confirm applies`.
- **Tests**: `metadata.test` or description substrings like `pnpm test <name>`. Render as `- pnpm test <name>  # rerun`.
- **URLs**: anything else. Render as a clickable link with no auto-action.

**Findings.**

- Always emitted as a dedicated "Manual cross-check required" section, not as 🔴/🟡/🟢 findings. The number of items gates the Verdict: a Green graph with 0 Phase F items is fully approved; with >0 items, the skill says "Green graph, N external checks pending — human owns final approval".

---

## Phase ordering rationale (why this order)

1. **A before B**: you need the snapshot before you can validate against it.
2. **B hard-stops before C–F**: no point auditing an unverified event log.
3. **C before D**: evidence integrity is a stronger failure mode than decision narrative thinness.
4. **D before E**: decision findings may be explained by patch events; read them in the right direction.
5. **E before F**: Phase E tells you *which* AI patches produced which evidence; Phase F then asks whether those evidence claims are real.
6. **F last**: nothing else depends on the human cross-check result; it can be deferred.

Do not rearrange. Phase B must be able to abort the pipeline before any later phase runs.
