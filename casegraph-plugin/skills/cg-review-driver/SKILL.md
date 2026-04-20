---
name: cg-review-driver
description: Use when the user wants to review AI-performed work on a CaseGraph case. Trigger on phrases like "case <id> をレビューして", "AI がやった作業を確認して", "review the case", "audit this case", "証跡をチェックして", or whenever a structured read-only inspection of task completion, evidence integrity, decision traceability, and event-log trustworthiness is needed.
---

# Review AI-performed work through CaseGraph

## Overview

Run a structured, read-only audit of a case after an AI has performed work on it. Produce a markdown review report classifying findings as must-fix (🔴), should-review (🟡), or note (🟢), and list external artifacts that still require human cross-check. Never mutate the graph — the only writes allowed are the report text and, if explicitly requested, one `evidence.attached` event at the end to record the review itself.

Use this skill after **cg-workflow-driver** or another AI-driven loop has produced done tasks, new decisions, evidence nodes, and patch-applied events. For live workflow orchestration use **cg-workflow-driver**. For AI-authored graph changes use **casegraph-patch**. For raw workspace reading use **casegraph**.

## Command bootstrap

Resolve a working launcher before using the commands below:

1. If `cg --help` works, use `cg`.
2. If CaseGraph is installed locally in the current project, use `pnpm exec cg --help` or `npx cg --help`.
3. If you are inside the CaseGraph repository, run `pnpm install` and `pnpm build`, then use `pnpm cg --help`.
4. If none of those work, install `@caphtech/casegraph-cli` and use either global `cg` or project-local `pnpm exec cg`.

In the rest of this skill, `cg ...` means "use the launcher that succeeded here."

## When to use

Use this skill when:

- an AI-driven loop has just marked tasks done and the case is about to be closed
- work is being handed off between sessions and the next agent needs to know what is already trustworthy
- a periodic audit is due on a long-running case
- someone asks "did the AI actually do this" and the answer must be graph-evidence based, not vibes

Skip it for a case that has only human edits, or for a case with fewer than a handful of nodes.

## Capability tiers

- **Core (always on)** — Phases A–E machine checks, Phase F item enumeration, markdown report output.
- **Opt-in: scoped review** — pass `--since-revision <n>` or `--since-timestamp <ISO8601>` to the skill to ignore history before that point. Useful on long-running cases to avoid re-reviewing everything.
- **Opt-in: record the review** — when the human says "record this review" (or equivalent), attach the report as a single `evidence` node on the case root via `cg evidence add`. Default off.

Out of scope in v0.1: batch review across multiple cases, diff reviews between two revisions, automated Phase F execution.

## Operating loop (6 phases)

Run in order. Each phase reads from `--format json` and pipes through jq — never emit mutating commands. Detail in [review-phases.md](references/review-phases.md).

1. **Orientation** — `cg case show --case <id> --format json` → read `revision.current`, `case.state`. Then `cg case view --case <id> --format json` → full `nodes[]` / `edges[]` / `derived[]` / `validation[]` arrays that later phases query. If `--since-revision` is set, scope all later event-log queries to events newer than that revision.
2. **State Health** — `cg validate --case <id> --format json` (errors must be 0), `cg events verify --case <id> --format json` (**HARD STOP** if integrity fails — the graph itself is not trustworthy), then `cg frontier --case <id>` and `cg blockers --case <id>`.
3. **Evidence Integrity** — find done-without-verifies, empty-evidence, and just-in-time evidence per [evidence-integrity-rules.md](references/evidence-integrity-rules.md).
4. **Decision Traceability** — every `kind:decision` in `state:done` should have `metadata.result` or a non-empty description. Flag naked decisions.
5. **Event Trail Audit** — `cg events export --case <id> --format json` and apply [event-trail-jq.md](references/event-trail-jq.md) patterns to classify patches by `generator.kind`, detect orphan workers, list cancel/fail transitions.
6. **Reality Cross-Check** — enumerate files, tests, PRs, URLs claimed by evidence nodes. Do not auto-verify; list them for the human under "Manual cross-check required" in the report.

## Verdict gates

| Verdict | Condition |
|---|---|
| 🔴 Red | Phase B failed (event log verify or validation errors > 0), or any `kind in {task, decision}` with `state: done` has no `verifies` edge, or any `worker.dispatched` event lacks a matching `worker.finished`. Short-circuit: Red results cause later phases to be reported but not trusted. |
| 🟡 Yellow | Any just-in-time evidence, naked decision, AI-authored (`generator.kind in {agent, worker}`) `patch.applied` without an accompanying `evidence.attached` event in the same revision range, or `state: open` with a non-empty frontier when the user's prompt implied the case was done. |
| 🟢 Green | No Red or Yellow findings. Only 🟢 notes and "Manual cross-check required" items remain. A Green verdict is **not** an automatic approval — it means the graph side passes; the human still owns Phase F. |

## Report output

Emit a single markdown document. Do not split into multiple files. Shape is fixed by [report-template.md](references/report-template.md). Keep it pasteable into a PR description or a chat thread.

When the user asks to record the review, attach it via:

```sh
cg evidence add --case <id> \
  --id evidence_review_<ISO8601_compact> \
  --title "Review report at revision <n>" \
  --target <case_root_or_most_relevant_goal_id> \
  --description "<full markdown report or summary + link to where the full text is stored>"
```

This is the only mutating command the skill ever emits, and only on explicit request.

## What this skill does NOT do

- Does not author patches. If the review suggests a fix, hand off to **casegraph-patch**.
- Does not close cases. `cg case close` stays with **cg-workflow-driver**.
- Does not automatically verify Phase F items (files, tests, PRs). The skill surfaces them; the human runs `git log`, reruns tests, opens PRs.
- Does not consume the full event log when `--since-revision` is set — scoping is strict so a long case stays reviewable.
- Does not run `cg patch apply`, `cg task ...`, `cg node ...`, `cg edge ...`, or any other mutating verb. Its entire output is read queries plus (optionally) one `cg evidence add` at the end.

## References

- [review-phases.md](references/review-phases.md)
- [evidence-integrity-rules.md](references/evidence-integrity-rules.md)
- [event-trail-jq.md](references/event-trail-jq.md)
- [report-template.md](references/report-template.md)

## Related

- live workflow orchestration: **cg-workflow-driver**
- AI-authored graph changes via `GraphPatch`: **casegraph-patch**
- direct workspace reading: **casegraph**
- importers, workers, sync, and storage recovery: **casegraph-integrate**
