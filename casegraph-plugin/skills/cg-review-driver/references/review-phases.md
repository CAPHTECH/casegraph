# Review phases

Six ordered phases. Each has a goal, concrete commands, what to look for, finding classification, and (for Phase B) a hard-stop condition.

All commands are read-only. Never emit `cg node ...`, `cg edge ...`, `cg task ...`, `cg patch apply`, or any other mutating verb from inside these phases. The one exception — `cg evidence add` to record the review — lives outside the phases and runs only on explicit user request.

Inputs the skill accepts:
- `--case <id>` (required)
- `--since-revision <n>` (optional) — clip Phase E to events with `revision_hint > n`
- `--since-timestamp <ISO8601>` (optional) — clip Phase E to events with `timestamp >= <ts>`

Output shape is fixed by [report-template.md](report-template.md). Findings accumulate across phases and get rendered in one place at the end.

All CLI results use the shape `{ ok, command, data, revision? }`, so every jq expression below unwraps with `.data...`.

---

## Phase A — Orientation

**Goal.** Know what you are reviewing before judging anything.

**Commands.** Use `cg case view` (not `cg case show`) because only `view` exposes the full `nodes[]` / `edges[]` / `derived[]` / `validation[]` arrays used by later phases.

```sh
cg case show --case <id> --format json > /tmp/cg-review-show.json
cg case view --case <id> --format json > /tmp/cg-review-view.json

jq '.data.revision.current, .data.case.state' /tmp/cg-review-show.json
jq '
  .data.nodes
  | group_by(.kind)
  | map({ kind: .[0].kind, total: length,
          by_state: (group_by(.state) | map({ state: .[0].state, n: length })) })
' /tmp/cg-review-view.json
```

**What to look for.**

- Revision range covered by the review. If `--since-revision` was passed, the range is `[since+1, current]`; otherwise `[1, current]`.
- Composition of the case: how many `goal`, `task`, `decision`, `event`, `evidence` nodes, and their state distribution.
- Whether the case is `open` or `closed` (from `cg case show`'s `data.case.state`). A closed case under review means someone already pulled the trigger on `cg case close`; findings about missing evidence are more severe.

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

- `cg validate` returns graph-level `errors` and `warnings` counts. Errors > 0 → 🔴.
- `cg events verify` replays the event log (via `replayCaseEvents`). A structural failure (unknown event type, missing `case.created`, patch replay mismatch) throws and the command exits non-zero → **HARD STOP**. Graph-level validation is *not* surfaced here — rely on `cg validate` above for that.
- `frontier` is empty if the case really is done. Non-empty frontier on a case the user claims is "finished" → 🟡.
- `blockers` lists active `depends_on` / `waits_for` / `state` / `cycle` reasons. Active blockers in a claimed-done case → 🟡 (or 🔴 if combined with a done-without-verifies finding in Phase C).

**Findings.**

- 🔴 `validation-error`: `cg validate` returned errors. Emit one finding per error with the node id and message.
- 🔴 `event-log-integrity-failure`: `cg events verify` exited non-zero. Report the exit output and stop — the rest of the review is unreliable and must be surfaced as "REVIEW ABORTED" in the Verdict block.
- 🟡 `frontier-nonempty-at-review`: case is `open` with `frontier` ≠ ∅ and the user prompted for a completion review.
- 🟡 `blockers-active-at-review`: unresolved blockers exist at review time.

**Hard stop.** If `cg events verify` fails, do not run Phases C–F. Render the report with Verdict = 🔴 Red + Summary = "event log integrity failure — graph not trustworthy".

---

## Phase C — Evidence Integrity

**Goal.** Check that every self-declared completion is backed by a `verifies` edge from an `evidence` node, and that the evidence itself is not a token.

Full rules live in [evidence-integrity-rules.md](evidence-integrity-rules.md). This phase applies them against the view snapshot (`/tmp/cg-review-view.json`).

**Commands.**

```sh
# Done task/decision without any incoming verifies edge
jq '
  ([.data.edges[] | select(.type == "verifies") | .target_id]) as $verified
  | .data.nodes
  | map(select(.kind == "task" or .kind == "decision"))
  | map(select(.state == "done"))
  | map(select(.node_id as $id | $verified | index($id) | not))
  | map(.node_id)
' /tmp/cg-review-view.json

# Empty or placeholder evidence
jq '
  .data.nodes
  | map(select(.kind == "evidence"))
  | map({
      node_id,
      description_len: (.description // "" | length),
      title,
      suspicious: ((.description // "" | length) < 20
                   or (.description // "" | test("^(実施|完了|done|ok)$"; "i")))
    })
  | map(select(.suspicious))
' /tmp/cg-review-view.json
```

For just-in-time detection, cross-reference the event log (see Phase E's jq cookbook for the full pattern). Per rule, flag evidence whose `evidence.attached` event's `timestamp` is within 2 seconds of the verified node's `node.state_changed` → `done` event.

**Findings.**

- 🔴 `done-without-verifies`: a `task` or `decision` node is `done` but no `verifies` edge points at it. Name every such node.
- 🟡 `empty-evidence`: evidence description is <20 chars or matches a placeholder pattern.
- 🟡 `just-in-time-evidence`: evidence attached in the same second (or within 2s) as the target's state change to done. Demote to 🟢 note only when the evidence description references a pre-existing artifact (PR URL, commit hash) whose timestamp predates the evidence — see [evidence-integrity-rules.md](evidence-integrity-rules.md) for the acceptable-exception rule.

---

## Phase D — Decision Traceability

**Goal.** Every completed `decision` should explain itself.

**Commands.**

```sh
jq '
  .data.nodes
  | map(select(.kind == "decision"))
  | map({
      node_id, title, state,
      result: (.metadata.decision_result // .metadata.result // null),
      has_desc: (((.description // "") | length) > 0)
    })
  | map(select(.state == "done"))
  | map(select(.result == null and (.has_desc | not)))
' /tmp/cg-review-view.json

# Alternative-to edges captured
jq '
  .data.edges
  | map(select(.type == "alternative_to"))
  | group_by(.source_id)
  | map({decision: .[0].source_id, alternatives: map(.target_id)})
' /tmp/cg-review-view.json
```

**What to look for.**

- A done decision with neither `metadata.decision_result` nor description is a **naked decision**: the choice is recorded but the reasoning is lost. (`decision_result` is what `cg decision decide --result <text>` writes; older graphs may have `metadata.result`.)
- Presence of `alternative_to` edges is a bonus signal that the agent considered alternatives. Missing alternatives is a 🟢 note only (common; not a finding on its own).

**Findings.**

- 🟡 `naked-decision`: decision done without a decision result in metadata and with empty description.
- 🟢 `decision-without-alternatives` (informational only, not a blocker).

---

## Phase E — Event Trail Audit

**Goal.** Classify `patch.applied` events by actor, detect orphan workers, and list state transitions the agent may have quietly abandoned.

Detailed jq patterns — including the exact payload paths, since payload shapes vary per event type — live in [event-trail-jq.md](event-trail-jq.md).

**Commands (pre-clip for `--since-revision` / `--since-timestamp` if set).**

```sh
cg events export --case <id> --format json > /tmp/cg-review-events.json
```

Then apply the cookbook jq patterns to produce:

1. **Patch applications by actor** — count of `patch.applied` events grouped by `payload.patch.generator.kind` (`human` / `agent` / `worker` / `importer` / `sync` / `planner`).
2. **AI patches without evidence** — AI-authored `patch.applied` events (`generator.kind in {agent, worker}`) with no `evidence.attached` whose `verifies_edge.target_id` is in the patch's affected node set, within the clip window. Flag as 🟡.
3. **Orphan workers** — `worker.dispatched` events without a subsequent `worker.finished` with the same `command_id`. Flag as 🔴.
4. **Failure history** — `node.state_changed` events that transitioned to `cancelled` or `failed` (via `payload.state`). List title, node id, reason, and whether the failure was later reversed. These are 🟢 notes unless a `failed` is immediately followed by a `done` on the same node without evidence — then 🟡.
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
jq '
  .data.nodes
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
' /tmp/cg-review-view.json
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
