# Review report template

Verbatim shape the skill must emit at the end of the review loop. One markdown document, pasteable into chat, a PR description, or (if `--record-as-evidence` is on) an `evidence` node's `description`.

Sections are fixed. Empty sections MUST still be rendered with the content `_(none)_` so scanning reviewers know the skill checked and found nothing, rather than that the phase was skipped.

---

## Template (copy, then substitute placeholders)

````markdown
# Case review: `<case_id>`

- **Revision:** `<current_revision>` (reviewed window: `<window_start>`–`<current_revision>`)
- **Case state:** `<open|closed>`
- **Reviewed at:** `<ISO8601_now>` (UTC)
- **Reviewer:** `cg-review-driver` v0.1
- **Scope:** `<full | since-revision N | since-timestamp ISO>`

## Verdict

> `<one_of: 🔴 Red | 🟡 Yellow | 🟢 Green | ⛔ REVIEW ABORTED>`
>
> `<one-line rationale that includes the worst finding category>`

## Health

| Check | Result |
|---|---|
| Validation errors | `<n>` |
| Validation warnings | `<n>` |
| Event log integrity (`events verify`) | `<ok | FAILED>` |
| Frontier size | `<n>` |
| Active blockers | `<n>` |
| Nodes by kind | `<goal=a, task=b, decision=c, event=d, evidence=e>` |
| Events in window | `<n>` |
| Actor distribution | `<human=X, agent=Y, worker=Z, importer=W, sync=V>` |

## Findings

### 🔴 Must fix (`<count>`)

- **`<rule_id>`** — `<node_id_or_edge_id>`: `<one-line message>`
- ...

_(none)_ if count is 0.

### 🟡 Should review (`<count>`)

- **`<rule_id>`** — `<node_id>`: `<one-line message>` (severity_hint: `<optional>`)
- ...

_(none)_ if count is 0.

### 🟢 Notes (`<count>`)

- `<rule_id>`: `<context message>`
- ...

_(none)_ if count is 0.

## Manual cross-check required (`<count>`)

The skill enumerates external references. The human (or a downstream tool) runs these.

- **Files** — `git log -- <path>` to confirm the evidence describes a real change:
  - `<path1>` (from `<evidence_id>`)
  - `<path2>` (from `<evidence_id>`)
- **Pull requests** — `gh pr view <n>` (or open in browser):
  - `#<n>` — `<evidence_id>` — `<url_if_present>`
- **Issues** — `gh issue view <n>`:
  - `#<n>` — `<evidence_id>`
- **Commits** — `git show <sha>`:
  - `<sha>` (from `<evidence_id>`)
- **Tests** — rerun:
  - `<command>` (from `<evidence_id>`)
- **URLs** — manual inspection:
  - `<url>` — `<evidence_id>`

_(none)_ if count is 0.

## Recommended next steps

- If verdict is 🔴 — `<action>`: produce a `GraphPatch` via **casegraph-patch** to attach missing evidence, or revert misplaced `done` states.
- If verdict is 🟡 — `<action>`: request the original author (AI or human) to fill in decision rationale / documentation gap before closing.
- If verdict is 🟢 — `<action>`: complete the Manual cross-check list above. If all items pass, the case is ready for `cg case close` through **cg-workflow-driver**.
- If verdict is ⛔ — `<action>`: stop. Investigate event-log integrity via `cg events verify` and `cg validate storage`. Do not close the case.

## Snapshot references

- Case snapshot: rendered from `cg case show --case <case_id> --format json` at revision `<n>`.
- Event stream: rendered from `cg events export --case <case_id> --format json`, clipped to the review window.

— end of report —
````

---

## Rendering rules

1. **Bullet ordering.** Findings within a severity bucket sort by `rule_id` alphabetical, then by `node_id`. Deterministic output is important when the same case is reviewed twice — diffable reports reveal real change instead of presentation drift.

2. **Counts in headings.** Always show the count in parentheses even when zero. `🔴 Must fix (0)` is a positive signal.

3. **Placeholder strings.** Use `_(none)_` (italic "none") for empty lists. Do not omit the section, do not use `N/A` or dashes.

4. **Verdict rationale length.** One line. If the rationale would exceed one line, choose the single worst finding and name it. The rest is in the Findings section already.

5. **Do not editorialize.** The Verdict block's rationale is factual ("3 done tasks without `verifies` edges") not hortative ("please review carefully").

6. **Do not attach logs.** The report references exported files by path; it does not inline the full event stream. Large inlined blobs defeat the "pasteable" goal.

7. **Language.** English in the template, matching the rest of the skill. The user-facing rendered report can inherit English safely — the findings themselves contain `node_id` values, which are codepoints, not prose.

8. **Section order is fixed.** Verdict → Health → Findings → Manual cross-check → Recommended next steps → Snapshot references. Do not reorder per case.

---

## Recording the report (opt-in)

Only when the user explicitly asks ("record this review", "evidence として残して", etc.):

```sh
cg evidence add --case <case_id> \
  --id "evidence_review_$(date -u +%Y%m%dT%H%M%SZ)" \
  --title "Review report at revision <n>" \
  --target "<case_root_or_goal_id>" \
  --description "$(cat <path-to-rendered-report>)"
```

Choose `<case_root_or_goal_id>` in this priority:
1. A single `kind:goal` node if the case has exactly one goal.
2. The most recently updated `kind:goal` node if the case has multiple.
3. The `case_id` itself as the target — only when no goal exists (which is unusual; most cases have at least one).

Never attach the review to an individual task; the review's scope is the whole case.

Record **only once per human-requested recording action**. If the user calls the skill again and says "record" a second time, create a new evidence node with a fresh timestamp rather than overwriting — historical reviews are independently useful.
