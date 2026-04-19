# Projecting a case to GitHub Issues via `gh`

Use this runbook when a case needs to be visible to PMs or collaborators on GitHub. The projection is **one-way push** (CaseGraph → GitHub Issues, optionally Projects V2 and Issue Dependencies) plus a **narrow pull** (close → `done`, optionally reopen → `todo` as patch proposals). GitHub is the *view*; CaseGraph remains the source of truth.

This is a **skill-level projection**, not the event-derived projection produced by code-level sinks. Nothing in `packages/` reads or writes the mapping file described below, and no `projection.pushed` / `projection.pulled` events are emitted. Running `cg case show --case <id> --format json` will not surface a `github` entry under `projection_mappings` — that is expected, not a bug.

## Capability tiers

- **Core (always on)** — Issues push (root + child), `cg:state/*` labels, hidden metadata fence, mapping file; pull close → `done` proposal. The root issue body is refreshed on every push so PMs reading the case root always see current frontier + blockers. Uses only `gh issue` / `gh label` subcommands.
- **Opt-in: Assignees** (`sinks.github.mirror_assignees: true`) — for each projected node, mirror `metadata.assignees: string[]` (GitHub logins) to the issue's assignees with set-diff semantics. Without this opt-in, the skill never touches assignees, so a human-maintained assignment on GitHub is safe.
- **Opt-in: Projects V2** (`sinks.github.project.number`) — add each managed issue to a Projects V2 board and set `CG Case ID` / `CG Node ID` / `CG State` custom fields. Optionally also `Priority` (single-select) from `metadata.priority`, `Target Date` (date) from `metadata.due_at`, and `Waiting For` (text) from unresolved `waits_for` targets. Uses `gh project` subcommands; no GraphQL.
- **Opt-in: Issue Dependencies** (`sinks.github.mirror_dependencies: true`) — mirror internal `depends_on` edges to GitHub's native issue dependencies. Uses `gh api graphql` (no native `gh issue` verb).
- **Opt-in: Reopen → `todo`** (`sinks.github.propose_reopen_patches: true`) — in pull, emit `change_state: todo` when an issue that was last pushed as `done` / `cancelled` is currently open on GitHub.

Every opt-in is gated by config. If the gate is absent, the feature stays off — the skill never enables a new API just because `gh` supports it.

### Standard `node.metadata` keys consumed

| Key | Type | Used by |
|---|---|---|
| `metadata.assignees` | `string[]` of GitHub logins | Assignees opt-in |
| `metadata.priority` | `"high"\|"medium"\|"low"` or number (matches `metadataPriorityValue` in `packages/kernel/src/helpers.ts:123`) | Projects V2 `Priority` field |
| `metadata.due_at` | ISO 8601 date (e.g. `"2026-05-31"`) | Projects V2 `Target Date` field |

Unknown keys are ignored. Missing keys skip the corresponding projection — they are not errors.

## Still not supported

- `waits_for` / `contributes_to` mirroring (deliberately excluded by `docs/spec/08-projections.md §8.4`).
- Sub-issues hierarchy (overlaps conceptually with Issue Dependencies; pick one).
- Comments → evidence/notes import; webhook-assisted cursor mode; rename / label / delete reverse sync (see `§8.8` / `§8.9` conflict policy).
- Cross-repo root/child hierarchy — root and child issues must live in the same repo.

## Prerequisites

1. `gh --version` resolves and `gh auth status` is green for the target owner.
2. For the Projects V2 opt-in, refresh the token with project scopes once: `gh auth refresh -s read:project -s project`. Skip if you will not enable `sinks.github.project`.
3. `.casegraph/config.yaml` contains:

   ```yaml
   sinks:
     github:
       owner: <gh-owner>
       repo: <gh-repo>
       labels_prefix: "cg:"                                 # optional, default "cg:"
       root_issue_title_template: "[CaseGraph] {case_title}"  # optional

       # Opt-ins — each is off unless its key is present
       mirror_assignees: true       # mirror metadata.assignees → GitHub issue assignees
       project:
         number: 7                  # Projects V2 number; absence disables the feature
         owner: caphtech            # project owner (may differ from repo owner; e.g. org-owned board)
         fields:
           case_id: "CG Case ID"    # text field name (required if project.number set)
           node_id: "CG Node ID"    # text field name (required if project.number set)
           cg_state: "CG State"     # single-select field name (required if project.number set)
           priority: "Priority"     # optional single-select; values must match metadata.priority strings
           target_date: "Target Date"  # optional date field; populated from metadata.due_at
           waiting_for: "Waiting For"  # optional text field; rendered from unresolved waits_for targets
       mirror_dependencies: true    # mirror depends_on → Issue Dependencies via gh api graphql
       propose_reopen_patches: true # include reopen → change_state: todo in pull patch
   ```

   If `sinks.github.owner` or `sinks.github.repo` is absent, stop with:
   `configure sinks.github.owner and sinks.github.repo in .casegraph/config.yaml before running GitHub projection`.
   Do not silently default to any repo. Opt-in fields are read best-effort and the absence of one does not stop the run.

4. On first run, pre-create labels (`--force` makes this idempotent and ignores "already exists"). `cg:state/*` labels are created dynamically from the states actually present in the case, so newly-introduced states (`proposed`, `failed`, future additions) do not break the push:

   ```sh
   for L in cg:case-root cg:task cg:decision "cg:case/<case_id>" ; do
     gh label create "$L" --repo "<owner>/<repo>" --force >/dev/null
   done
   # Enumerate the states actually used in this case and create a label for each.
   cg --format json case show --case <case_id> \
     | jq -r '.data.nodes[].state' | sort -u \
     | while read -r S; do
         gh label create "cg:state/$S" --repo "<owner>/<repo>" --force >/dev/null
       done
   ```

   Re-run this step before push whenever a new state is introduced in the case; it is cheap (one `gh label create --force` per distinct state) and keeps the label set in sync without hard-coding a state enumeration.

5. If `project.number` is set, verify the configured fields exist (do not auto-create — an unexpected field on a shared board is worse than a stopped push):

   ```sh
   gh project field-list <number> --owner <project-owner> --format json
   ```

   If any configured field name is missing, stop with `project field '<name>' not found on project <number>; create it with 'gh project field-create' or remove it from sinks.github.project.fields`.

## Mapping file

Path: `.casegraph/cases/<case_id>/projections/github.yaml`. Colocated with `case.yaml` and `events.jsonl`, so archiving or moving a case takes the mapping with it.

```yaml
sink_name: github
owner: caphtech
repo: casegraph
case_id: release-1.8.0
last_pushed_revision: 57

# Per-run bookkeeping for the root issue so body refresh can skip when nothing changed.
# `root.issue_number` is the canonical root-issue pointer; there is no top-level `root_issue_number`.
root:
  issue_number: 42
  last_pushed_revision: 57
  last_frontier_digest: "sha1:3ab09..."  # hash of (ordered frontier node_ids + states + blockers) for skip-detection

# Present only when sinks.github.project is configured. Cached once; do not re-query on every push.
project:
  number: 7
  owner: caphtech
  project_id: PVT_kwDOxxxxxx
  field_ids:
    case_id: PVTF_lADOxxxxxx
    node_id: PVTF_lADOyyyyyy
    cg_state: PVTSSF_lADOzzzz
    priority: PVTSSF_lADOwwwww        # present only if fields.priority is configured
    target_date: PVTF_lADOvvvvvv       # present only if fields.target_date is configured
    waiting_for: PVTF_lADOttttttt      # present only if fields.waiting_for is configured
  state_option_ids:
    todo: 47fc9ee4
    doing: 98236657
    waiting: 11ab9e3d
    done: 5fd9be75
    cancelled: f75ad846
  priority_option_ids:                 # present only if fields.priority is configured
    high: aa111111
    medium: bb222222
    low:  cc333333

# Present only when sinks.github.mirror_dependencies is true. Keyed by internal edge_id so diff is set-like.
dependency_edges:
  edge_submit_depends_regression:
    blocking_issue: 43        # source (depends_on target in CaseGraph = blocker in GitHub)
    blocked_issue: 44         # target of dependency relation (depends_on source = blocked)

nodes:
  task_run_regression:
    issue_number: 43
    issue_node_id: I_kwDOxxxxxx     # cached; required for GraphQL Issue Dependency mutations
    project_item_id: PVTI_lADOxxxx  # present only when project opt-in is used
    last_pushed_revision: 57
    last_pushed_state: todo
    last_pushed_assignees: [alice, bob]       # present only when mirror_assignees is on
    last_pushed_priority: high                # present only when project.fields.priority is set
    last_pushed_due_at: "2026-05-31"          # present only when project.fields.target_date is set
    last_pushed_waiting_for: "event_store_approval" # present only when project.fields.waiting_for is set
  decision_direction:
    issue_number: 44
    issue_node_id: I_kwDOyyyyyy
    last_pushed_revision: 55
    last_pushed_state: proposed
```

`last_pushed_revision` stores `data.revision.current` from `cg case show --case <id> --format json` at push time. It lets subsequent runs skip instantly when nothing has changed.

`issue_node_id` is the GraphQL global ID returned by `gh issue view <n> --json id`. Cache it on create so Issue Dependency mutations do not require a per-push lookup.

If the file is malformed, refuse to write. Ask the user to repair it rather than regenerating silently — the mapping is the only record that an external issue was created.

## Body metadata fence

Every managed issue body ends with this fence (wrapped in a single HTML comment so the metadata is invisible on GitHub but machine-readable on pull):

```text
<!-- casegraph:begin
spec_version: 0.1-draft
sink: github-cli
case_id: <case_id>
node_id: <node_id>
node_kind: task|decision|case-root
last_pushed_revision: <n>
managed_fields: [title, labels, state]
casegraph:end -->
```

Content above the fence is agent-written (title, one-line summary, acceptance bullets, current blockers). A human may edit *outside* the fence; on update, preserve anything above the fence that the skill did not itself generate — only rewrite the skill's own section and the fence itself.

## Push loop

All `gh` calls pass `--repo <owner>/<repo>` explicitly so behaviour does not depend on `cwd`.

1. Read `sinks.github` from `.casegraph/config.yaml`. If missing, stop.
2. `cg --format json case show --case <id>` → note `data.revision.current`, `data.caseRecord.title`, `data.nodes`, `data.edges`.
3. `cg --format json frontier --case <id>` → `data.nodes[]` (already filtered to the actionable subset).
4. Load `.casegraph/cases/<id>/projections/github.yaml`, or start from `{sink_name: github, owner, repo, case_id, last_pushed_revision: 0, root: {issue_number: null}, nodes: {}}`.
5. If `mapping.last_pushed_revision == revision.current` **and** the opt-ins are already caught up with config, log `nothing to push (revision <n>)` and exit. "Caught up" means:
   - Assignees opt-in: every node's `last_pushed_assignees` matches `metadata.assignees ?? []`.
   - Project opt-in: `mapping.project` is present and every entry in `mapping.nodes` has a `project_item_id`. If optional Project fields are configured (`priority`/`target_date`/`waiting_for`), their `last_pushed_*` values must match the current node metadata and computed waiting-for text.
   - Dependencies opt-in: `mapping.dependency_edges` exists (even if empty) and matches the current set of `depends_on` edges among projected nodes.
   - Root refresh: `mapping.root.last_frontier_digest` matches the digest computed from the current frontier + blockers.
   If an opt-in was just turned on, reset `last_pushed_revision: 0` in the mapping before the next run, or simply make a trivial case change; both force step 5 to fall through.
6. **Ensure root issue and refresh its body.**

   a. If `mapping.root.issue_number` is null, create it:
      ```sh
      gh issue create \
        --repo "<owner>/<repo>" \
        --title "[CaseGraph] <case_title>" \
        --body "<root body with fence>" \
        --label "cg:case-root" \
        --label "cg:case/<case_id>"
      ```
      Persist `mapping.root.issue_number`.

   b. On every push, regenerate the root body from the current case state and rewrite it only when the frontier digest has changed. The body is the PM's single-pane-of-glass — if it drifts, the projection loses most of its value.

      Regenerated root body (above the fence):
      - one-line case summary from `data.caseRecord.description`
      - `## Frontier` — bullet list of each frontier node: `- [ ] <title> (<state>) — #<issue_number>` (use `[x]` only when state is `done`).
      - `## Blockers` — one bullet per item in `cg --format json blockers --case <id> → data.items`, rendered as `- <node.title> ← <reason.kind>: <reason.detail>`.
      - `## Acceptance / DoD` — case-level acceptance criteria if `caseRecord.description` or `caseRecord.acceptance` contain them; otherwise omit the section.

      Compute a deterministic digest: `sha1(JSON.stringify(frontier_node_ids_sorted + states + blocker_reasons))`. If `digest == mapping.root.last_frontier_digest`, skip the body rewrite. Otherwise:
      ```sh
      gh issue edit <mapping.root.issue_number> --repo "<owner>/<repo>" --body "<regenerated body with fence>"
      ```
      Update `mapping.root.last_pushed_revision` and `mapping.root.last_frontier_digest`.

   The root issue never closes during normal push — only the explicit `cg case close` flow (out of this runbook's scope) should lead to root closure.
7. **For each frontier node** in step 3:
   - If `mapping.nodes[node_id]` is absent → **create**:
     ```sh
     gh issue create \
       --repo "<owner>/<repo>" \
       --title "<node.title>" \
       --body "<child body with fence>" \
       --label "cg:<node.kind>" \
       --label "cg:state/<node.state>" \
       --label "cg:case/<case_id>"
     ```
     Then capture the GraphQL node id for later mutations:
     ```sh
     gh issue view <n> --repo "<owner>/<repo>" --json id -q .id
     ```
     Persist `issue_number`, `issue_node_id`, `last_pushed_revision: revision.current`, `last_pushed_state: node.state`.
   - Else if `node.state != mapping.nodes[node_id].last_pushed_state` → **update state**:
     ```sh
     gh issue edit <n> --repo "<owner>/<repo>" \
       --remove-label "cg:state/<old>" \
       --add-label "cg:state/<new>"
     ```
     Then, only if the new state is terminal:
     - `done`: `gh issue close <n> --repo "<owner>/<repo>"`
     - `cancelled`: `gh issue close <n> --repo "<owner>/<repo>" --reason not-planned`
     - `waiting`: stays open; the `cg:state/waiting` label is the only visible change.
     Update `last_pushed_state` and `last_pushed_revision`.
   - Else if `mapping.nodes[node_id].last_pushed_revision < revision.current` → **rewrite body**:
     ```sh
     gh issue edit <n> --repo "<owner>/<repo>" --body "<new body with fence>"
     ```
     Update `last_pushed_revision`. Only do this when something in the managed body could have changed (acceptance, blockers, title, waiting-for).

   The managed child body (above the fence) contains, in order:
   1. one-line summary (from `node.description` or first line of same)
   2. `## Acceptance` — bullet list of `node.acceptance[]` if non-empty
   3. `## Waiting for` — bullet list of unresolved `waits_for` targets (event node title + state) if any exist; omit when the node has no outstanding waits. Resolve via `data.edges` where `edge.type == "waits_for" && edge.source_id == node.node_id`; look up each `edge.target_id` in `data.nodes` and skip targets whose state is `done`.
   4. `## Depends on` — bullet list of `depends_on` targets rendered as `- #<issue_number> <title>` for projected nodes, `- <title> (not projected)` otherwise. GitHub auto-creates a "mentioned in" backlink for `#N`.

7.3 **(Opt-in: Assignees)** If `sinks.github.mirror_assignees: true`:
   - Current = `node.metadata.assignees` (default `[]` if missing/null).
   - Previous = `mapping.nodes[node_id].last_pushed_assignees` (default `[]`).
   - Additions: `current - previous`. Removals: `previous - current`.
   - One call when either set is non-empty (`gh issue edit` accepts repeatable flags, so batch in a single call):
     ```sh
     gh issue edit <n> --repo "<owner>/<repo>" \
       $(for a in <add...>; do printf -- "--add-assignee %s " "$a"; done) \
       $(for r in <remove...>; do printf -- "--remove-assignee %s " "$r"; done)
     ```
   - Persist `last_pushed_assignees: current`.
   - If an assignee login is invalid or not a repo collaborator, `gh` fails loudly. Do not silently drop; surface the error so the human can fix `metadata.assignees` or the repo access.

7.5 **(Opt-in: Projects V2)** If `sinks.github.project.number` is configured, resolve field IDs once per mapping, then attach items and set fields.

   a. If `mapping.project.project_id` is absent, cache board metadata:
      ```sh
      gh project view <number> --owner <project-owner> --format json
      gh project field-list <number> --owner <project-owner> --format json
      ```
      Persist `project_id`, `field_ids.{case_id,node_id,cg_state}`, and every `state_option_ids[<state>]` from the `CG State` single-select options. If any **required** field (case_id / node_id / cg_state) is missing, stop (the Prerequisites check already flagged this; honour it).

      For each **optional** field that is configured under `sinks.github.project.fields` (`priority`, `target_date`, `waiting_for`): if the field exists on the board, cache its `field_id` and (for `priority`) its option ids under `priority_option_ids`; if it does not exist, drop the key from the effective config for this run and record a single observation like `project field 'Priority' not found; skipping priority sync`. Unlike the required fields, missing optionals are a warning, not a stop.

   b. For each mapping node without `project_item_id`, add it to the board and cache the item id:
      ```sh
      gh project item-add <number> --owner <project-owner> \
        --url "https://github.com/<owner>/<repo>/issues/<n>" --format json
      ```

   c. If the node was newly created this run, set its CG Case ID and CG Node ID text fields once:
      ```sh
      gh project item-edit \
        --id <project_item_id> --project-id <project_id> \
        --field-id <field_ids.case_id> --text "<case_id>"
      gh project item-edit \
        --id <project_item_id> --project-id <project_id> \
        --field-id <field_ids.node_id> --text "<node_id>"
      ```

   d. If `node.state != last_pushed_state` (the same trigger as the label change in step 7), set the CG State single-select:
      ```sh
      gh project item-edit \
        --id <project_item_id> --project-id <project_id> \
        --field-id <field_ids.cg_state> \
        --single-select-option-id <state_option_ids[new_state]>
      ```

   e. **(Optional: Priority)** If `field_ids.priority` is cached and `node.metadata.priority` is a non-null value (`high|medium|low` or a number normalized via `metadataPriorityValue`):
      - Resolve the target option id: for string values, `priority_option_ids[value]`; for numbers, map `1→high`, `2→medium`, `3→low`, otherwise skip.
      - If it differs from `last_pushed_priority`, set it:
        ```sh
        gh project item-edit \
          --id <project_item_id> --project-id <project_id> \
          --field-id <field_ids.priority> \
          --single-select-option-id <priority_option_ids[<value>]>
        ```
      - Persist `last_pushed_priority`.

   f. **(Optional: Target Date)** If `field_ids.target_date` is cached and `node.metadata.due_at` is an ISO 8601 date string:
      - If it differs from `last_pushed_due_at`:
        ```sh
        gh project item-edit \
          --id <project_item_id> --project-id <project_id> \
          --field-id <field_ids.target_date> \
          --date "<node.metadata.due_at>"
        ```
      - Persist `last_pushed_due_at`.

   g. **(Optional: Waiting For)** If `field_ids.waiting_for` is cached:
      - Compute `waiting_for_text`: comma-separated titles of unresolved `waits_for` event targets (same resolution as the child body section). Empty string when there are no outstanding waits.
      - If it differs from `last_pushed_waiting_for`:
        ```sh
        gh project item-edit \
          --id <project_item_id> --project-id <project_id> \
          --field-id <field_ids.waiting_for> \
          --text "<waiting_for_text>"
        ```
      - Persist `last_pushed_waiting_for`. Setting it to an empty string clears the field; this is the desired behaviour when a `waits_for` edge becomes satisfied.

   Apply steps a–d to the root issue (`mapping.root.project_item_id` kept alongside `mapping.root.issue_number`) so the case appears on the board too. The root's CG State mirrors `caseRecord.state` (`open` / `closed`) — if the single-select does not have an exact match, use `doing` while open and `done` once closed. Priority / Target Date / Waiting For are skipped for the root (they belong to individual nodes, not the case).

7.6 **(Opt-in: Issue Dependencies)** If `sinks.github.mirror_dependencies: true`, diff the current set of internal `depends_on` edges (among projected nodes only) against `mapping.dependency_edges` and issue one GraphQL mutation per change.

   CaseGraph semantic: `depends_on(A, B)` means A depends on B, i.e. B must complete first. GitHub semantic: `blocked_by(A, B)` — A is blocked by B. Mapping is direct: `blocking_issue = issue(B)`, `blocked_issue = issue(A)`.

   a. On first use, query the input shape once so field names do not drift:
      ```sh
      gh api graphql -f query='
        query {
          __type(name: "CreateIssueDependencyInput") { inputFields { name } }
        }'
      ```
      GitHub's mutation names and input fields have shifted during the feature's rollout. If `CreateIssueDependency` / `DeleteIssueDependency` are not present, try `addIssueDependency` / `removeIssueDependency` and inspect the corresponding input types. Record the resolved shape once in the checkpoint evidence.

   b. For each **added** edge (internal edge present, not in mapping):
      ```sh
      gh api graphql -f query='
        mutation($issueId: ID!, $blockerId: ID!) {
          createIssueDependency(input: { issueId: $issueId, dependsOnIssueId: $blockerId }) {
            issue { number }
          }
        }' -F issueId=<blocked.issue_node_id> -F blockerId=<blocking.issue_node_id>
      ```
      Persist under `mapping.dependency_edges[<edge_id>] = { blocking_issue, blocked_issue }`.

   c. For each **removed** edge (in mapping, no longer in internal graph): call the delete mutation with the same pattern and drop the entry.

   d. Only mirror edges where both endpoints already have issues in `mapping.nodes`. If one side is not projected (goal / event / evidence, or a filtered-out state), skip the edge silently — it is not an error.

   Record a single observation per run: `depends_on mirror: +N / -M (failed: K)`. Partial failure is acceptable; the next run retries what is still in the diff.

8. **For each mapping entry not in the current frontier** whose internal node is now `done` or `cancelled`: close its issue with a short trail:
   ```sh
   gh issue comment <n> --repo "<owner>/<repo>" --body "closed by CaseGraph: node reached <state>"
   gh issue close <n> --repo "<owner>/<repo>"  # add --reason not-planned for cancelled
   ```
   Leave the mapping entry in place so the number is remembered.
9. Write `mapping.last_pushed_revision = revision.current` and the per-node updates back to `projections/github.yaml`.
10. Record a checkpoint evidence before returning, per [checkpoint-evidence.md](checkpoint-evidence.md):
    ```sh
    cg evidence add --case <id> \
      --id evidence_gh_push_<ts> \
      --title "Checkpoint: GitHub push at rev <n>" \
      --target <root_or_recent_task> \
      --description "Pushed to <owner>/<repo>. Created: N. Updated state: M. Closed: K. Mapping at rev <n>."
    ```

Idempotency rules:
- Every decision is driven by diffing the mapping against the current case, not by querying GitHub. Re-running push when nothing changed produces zero `gh` calls.
- If step 7 fails mid-stream, the mapping entries already written are still valid; the next run will pick up the unfinished ones.
- Never create a second issue for a node that already has a mapping entry, even if the issue was manually closed on GitHub.

## Pull loop (close → done; optional reopen → todo)

1. Load `.casegraph/cases/<id>/projections/github.yaml`. If empty, nothing to pull.
2. One bulk query. If `sinks.github.propose_reopen_patches: true`, request `--state all` so reopens are visible in the same page; otherwise restrict to `--state closed` to keep the payload small.

   When `propose_reopen_patches: true`:
   ```sh
   gh issue list \
     --repo "<owner>/<repo>" \
     --state all \
     --label "cg:case/<case_id>" \
     --json number,state,title,closedAt \
     --limit 200
   ```

   When `propose_reopen_patches` is unset or `false`:
   ```sh
   gh issue list \
     --repo "<owner>/<repo>" \
     --state closed \
     --label "cg:case/<case_id>" \
     --json number,state,title,closedAt \
     --limit 200
   ```
3. Build operations (each mapping node contributes at most one op per pull):
   - **Close → done.** For each issue with `state == CLOSED` whose mapping entry has `last_pushed_state ∈ {todo, doing, waiting}`: one `change_state` op with `state: done`.
   - **Reopen → todo (opt-in).** Only if `propose_reopen_patches: true`: for each issue with `state == OPEN` whose mapping entry has `last_pushed_state ∈ {done, cancelled}`: one `change_state` op with `state: todo`. Always propose `todo`, not `doing` — start the node from a neutral state and let the human run `cg task start` if the work actually resumed. Field name is `state`, not `to_state`, per `ChangeStatePatchOperation` in `packages/kernel/src/types.ts:352`.
4. `cg --format json case show --case <id>` → `base_revision = data.revision.current`.
5. If there are zero operations, stop. Otherwise write `.casegraph/patches/github-pull-<ISO8601>.yaml`:

   ```yaml
   patch_id: patch_gh_pull_<ulid>
   spec_version: 0.1-draft
   case_id: <case_id>
   base_revision: 57
   summary: "GitHub: C closed → done, R reopened → todo"
   generator:
     kind: sync
     name: gh-cli-skill
     version: 0.2.0
   operations:
     - op: change_state
       node_id: task_run_regression
       state: done
     - op: change_state
       node_id: task_file_bug_report
       state: todo
   notes:
     - "issue #43 closed in GitHub 2026-04-18T09:30Z"
     - "issue #48 reopened in GitHub after being pushed as done"
   risks:
     - "External close/reopen may be a mistake; review before apply."
   ```

   Cite `docs/spec/04-graphpatch.md §4.4 change_state` and §4.3 (`generator.kind: sync`).
6. Human review:
   ```sh
   cg patch review --file .casegraph/patches/github-pull-<ISO8601>.yaml
   ```
   Exit code 4 (`stale base_revision`) means the revision moved between steps 4 and 6. Redo from step 4 once, then stop if it repeats — a human should investigate.
7. Optional apply once the human is satisfied:
   ```sh
   cg patch apply --file .casegraph/patches/github-pull-<ISO8601>.yaml
   ```
   This is the only mutating call in pull. On success, the next push will reconcile the mapping (nodes now `done`, so no further `gh` calls are fired).
8. Do not update the mapping file after pull. The mapping is strictly a record of what was last *pushed*; push re-reads case state and converges.

### Signals that pull deliberately ignores

Record these only as `notes[]` entries in the patch when you want the user to see them, never as `operations[]`:

- Reopened issues **when `propose_reopen_patches` is off** → the case is still the source of truth.
- Title changes on GitHub → never shadow the internal title.
- Label additions/removals outside `cg:state/*` → treated as human annotation.
- Assignee edits made directly on GitHub — **when `mirror_assignees` is on**, the next push will overwrite them from `metadata.assignees`. If a human's manual add is important, update `metadata.assignees` first. When the opt-in is off, the skill never touches assignees.
- Project field edits in GitHub (custom fields, status column) → GitHub is the view, push re-asserts on next run.
- Issue Dependency edits made directly on GitHub → likewise; the next push diffs against `mapping.dependency_edges`, so a human-added dependency may be removed silently. If this matters, disable `mirror_dependencies` and drop `dependency_edges` from the mapping.
- Deleted issues → leave the mapping entry; next push will recreate with a new number.

This matches the "internal graph wins" posture in `docs/spec/08-projections.md §8.8` and §8.9.

## Failure modes

- `gh` not authenticated → stop at step 1 of push or pull, no file writes.
- `gh` rate limit → surface `gh`'s own error output verbatim. Do not retry silently.
- Mapping file malformed → refuse to write, ask the user to repair.
- `gh issue create` fails after label pre-creation → leave the mapping entry unset. The next run will create a fresh issue. This is safer than writing a guessed `issue_number`.
- `cg patch review` fails with exit 2 (validation) → the generated patch is malformed. Do not apply. Stop and inspect.
- `gh project field-list` returns without a configured field → stop the project opt-in branch with the exact remediation message from Prerequisites §5. Core push continues.
- `gh project item-add` / `item-edit` returns a scope error (`missing scope project`) → disable project opt-in for the rest of the run, record `project sync skipped: missing project scope` in the checkpoint, continue with the core push. Do not patch the token automatically.
- `gh api graphql` `addIssueDependency` returns `Field 'dependsOnIssueId' doesn't exist on input 'AddIssueDependencyInput'` → re-run the `__type` introspection query, update the mutation shape, store the resolved shape in the checkpoint evidence, retry once.
- `gh api graphql` returns `Resource not accessible by integration` (dependencies not enabled on repo) → disable `mirror_dependencies` for the rest of the run, record the skip, continue. The feature may not be available on all repos yet.
- Partial failure in the Projects V2 or Issue Dependencies substeps is acceptable: mapping is updated only for the edges/items that succeeded, and the next push retries the remainder because the diff is recomputed from the mapping.

## Verification (smoke test against a throwaway repo)

1. `cg init` in a scratch workspace; `cg case new --id test-gh-proj --title "GH projection smoke"`; add one goal + two tasks via the SKILL.md Command skeleton.
2. Hand-write `sinks.github` in `.casegraph/config.yaml` pointing at a repo you own.
3. Run the push loop. Expect:
   - `gh issue list --repo <repo> --label "cg:case/test-gh-proj"` shows 3 issues (1 root + 2 tasks).
   - `.casegraph/cases/test-gh-proj/projections/github.yaml` has `root.issue_number` set and entries for both tasks.
   - Each body contains the `<!-- casegraph:begin ... :end -->` fence.
4. Re-run push immediately. Expect: `nothing to push (revision <n>)`, zero `gh` calls.
5. `cg task start <task_id>`; re-run push. Expect: exactly one `gh issue edit --remove-label cg:state/todo --add-label cg:state/doing`, nothing else.
6. `gh issue close <n>` on one child issue; run pull. Expect: `.casegraph/patches/github-pull-*.yaml` with one `change_state` op and `base_revision` matching `cg case show`. `cg patch review` passes. `cg patch apply` updates the node. Re-running pull emits zero operations.
7. Reopen that issue, rename another, add a stray label; run pull **with `propose_reopen_patches` off**. Expect zero `operations[]`; any of these may appear under `notes[]` depending on how loudly you want to surface them.
8. `cg --format json case show --case test-gh-proj | jq '.data.projection_mappings'` → no `github` entry. This is the documented limitation (skill-level projection, not event-derived).

### v0.2 opt-in smoke tests

9. **Reopen → todo (opt-in)**. Set `sinks.github.propose_reopen_patches: true`. Reopen the issue you closed in step 6 (which is now internally `done`). Run pull. Expect `.casegraph/patches/github-pull-*.yaml` containing exactly one op: `change_state` with `state: todo`. `cg patch review` passes; `cg patch apply` reverts the node to `todo`. Re-run push. Expect the issue's state label to be edited back to `cg:state/todo` and the issue to remain open.

10. **Projects V2 (opt-in)**. Create a throwaway project: `gh project create --owner <you> --title "cg smoke"`; add the three fields `CG Case ID` (text), `CG Node ID` (text), `CG State` (single select with options todo/doing/waiting/done/cancelled). Set `sinks.github.project.{number, owner, fields}` to match. Run push. Expect:
    - `gh project item-list <number> --owner <owner> --format json` lists the root + 2 task items.
    - `mapping.project` is populated with `project_id`, `field_ids`, `state_option_ids`.
    - Each task mapping has a `project_item_id`.
    - `cg task start <id>`; re-run push. Expect one `gh project item-edit` call updating `CG State` alongside the label edit.

11. **Issue Dependencies (opt-in)**. Add an internal edge: `cg edge add --type depends_on --from <task_b> --to <task_a>` (so B depends on A). Set `sinks.github.mirror_dependencies: true`. Run push. Expect `gh api graphql` to be invoked once with the dependency mutation, and the GitHub issue for B to show "blocked by #A" in its dependencies panel. `mapping.dependency_edges[<edge_id>]` is populated. Remove the internal edge; re-run push; expect the delete mutation and the mapping entry gone. If the repo does not have Issue Dependencies enabled, expect a clean skip (see Failure modes) and zero disruption to the core push.

12. **Assignees (opt-in)**. On a task node, set metadata: `cg node update --case <id> <task_id> --metadata '{"assignees": ["alice"]}'` (or hand-edit case.yaml). Set `sinks.github.mirror_assignees: true`; run push. Expect one `gh issue edit --add-assignee alice`; `gh issue view <n>` shows alice assigned. Change to `["bob"]`; re-push. Expect one `gh issue edit --add-assignee bob --remove-assignee alice` combined call. Clear the list; re-push. Expect `--remove-assignee bob`. `mapping.nodes[<task_id>].last_pushed_assignees` tracks each step.

13. **Root body refresh (always on)**. After step 3, note the root issue body. Then `cg task start <task_id>`; re-run push. Expect the root issue body to be rewritten: the task's state in the `## Frontier` section flips from `(todo)` to `(doing)`, and `mapping.root.last_frontier_digest` is updated. Re-run push with no further changes — expect no `gh issue edit` on the root (digest unchanged).

14. **Priority / Target Date / Waiting For (opt-in fields)**. Add optional fields `Priority` (single select: high/medium/low), `Target Date` (date), `Waiting For` (text) to the project from step 10. Extend `sinks.github.project.fields` to include them. On a task: `cg node update ... --metadata '{"priority":"high","due_at":"2026-05-31"}'` and add a `waits_for` edge to an unrecorded event node. Run push. Expect three `gh project item-edit` calls setting the three fields for that task's project item. Verify on the board. Record the event (`cg event record`); re-push. Expect `Waiting For` cleared to empty. If a field is not configured on the project, expect a warning observation and zero disruption to the rest of push.

## Checkpoint cadence for this runbook

Record a checkpoint evidence:

- after every successful push batch (step 10 above)
- after writing a pull patch file, before `cg patch apply`
- before any step that queries GitHub over a slow link

Follow the payload shape in [checkpoint-evidence.md](checkpoint-evidence.md).
