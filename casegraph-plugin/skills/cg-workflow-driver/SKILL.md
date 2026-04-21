---
name: cg-workflow-driver
description: Use when the user wants multi-step work managed through CaseGraph instead of ad hoc chat state. Trigger on phrases like "manage this in cg", "drive this from the case", "record evidence for compaction", "resume from cg", "verify before close", or whenever durable checkpoints, verification, and guarded closure are needed for implementation, docs, investigation, or review work.
---

# Drive work through CaseGraph

## Overview

Use CaseGraph as the durable task backbone for multi-step delivery, verification, resume, and close. Build only the graph needed to expose sequencing and blockers, record evidence before context can be lost, and treat `cg case close` as an explicit end-state check rather than a synonym for "the conversation sounds done".

Use this skill for workflow orchestration through the `cg` CLI. For direct workspace reading use **casegraph**. For AI-authored graph changes use **casegraph-patch**. For importers, workers, sync, or storage recovery use **casegraph-integrate**.

## Command bootstrap

Resolve a working launcher before using the commands below. Use `cg --version` as the existence check — it prints a single line and is the canonical way to confirm the CLI is installed.

1. If `cg --version` works, use `cg`.
2. If CaseGraph is installed locally in the current project, use `pnpm exec cg --version` or `npx cg --version`.
3. If you are inside the CaseGraph repository, run `pnpm install` and `pnpm build`, then use `pnpm cg --version`.
4. If none of those work, install `@caphtech/casegraph-cli` and use either global `cg` or project-local `pnpm exec cg`.

In the rest of this skill, `cg ...` means "use the launcher that succeeded here."

In a fresh workspace (no `.casegraph/` directory yet), run `cg init` once before the first `cg case new` — otherwise `cg case new` will fail with a missing-workspace error.

## When to use

Use this skill when:

- the task spans multiple steps or checkpoints
- the user explicitly asks to manage the work in `cg`
- compaction, handoff, or long-running work can erase chat context
- evidence, decisions, and close state need to survive outside the transcript
- the case should be mirrored to GitHub Issues so collaborators can follow progress outside `cg`

When GitHub mirroring is required, read [github-projection.md](references/github-projection.md) before adding the first task node.

Skip it for tiny one-pass edits that do not need a durable case.

## Operating loop

1. Resolve or create the case.
   - Reuse an existing case when the outcome is the same.
   - Otherwise create a case with one goal and the minimum task graph needed to expose the frontier.
2. Build the minimum useful structure.
   - Add a goal plus concrete task nodes.
   - Do not mirror one task node per file or per code change. Cut task nodes by work-step divergence (where the agent would pause, verify, or hand off), usually 2-3 nodes total for a focused refactor or migration.
   - Use `depends_on` for hard sequencing, `waits_for` for external blockers, and `contributes_to` from work nodes to the goal.
   - Read [task-templates.md](references/task-templates.md) when deciding how much graph to create.
3. Execute from the frontier.
   - Inspect `cg frontier --case <id> --format json`.
   - Start only the task you are actively executing.
   - If the next step is blocked, record the blocker in the case instead of leaving it only in chat.
4. Checkpoint before context can disappear.
   - Record evidence for what changed, what was checked, and what remains.
   - Use event nodes only for meaningful milestones or external facts.
   - Read [checkpoint-evidence.md](references/checkpoint-evidence.md) for the checkpoint pattern.
5. Verify before marking tasks done.
   - Run the smallest checks that prove the task outcome.
   - Attach verification evidence, then mark the task done.
6. Close deliberately.
   - Done tasks do not automatically mean a closed case.
   - Run validation, inspect remaining frontier and blockers, then close.
   - Read [close-and-resume-rules.md](references/close-and-resume-rules.md) before close or resume.

## Core rules

- Model outcomes, blockers, and proof; do not mirror every conversational thought into the graph.
- Prefer evidence for compaction resilience. The next agent should be able to resume from the case without replaying the full chat.
- Use `decision decide` when an option is chosen and that choice constrains future work.
- On any direction pivot (abandoning an approach, switching strategy, reframing the problem), create a dedicated `decision` node whose body holds the rationale and the rejected alternative. Do not bury the pivot reason inside `evidence.description` — evidence records what was observed or produced, not why the course changed. A pivot without a decision node is not a recorded pivot.
- Use `event record` only after creating an event node, and only for milestone or external-world facts worth preserving.
- Keep node titles outcome-oriented so they work as resume anchors.
- Add `--description` to every node that is not a one-line atomic action: capture what "done" means, what was considered, and any inputs the next agent needs. Descriptions exist for compaction resilience and resume, not only for GitHub projection.
- If a task is still being proven, it is not done yet.
- Before `cg case close`, the goal itself must be in the `done` state. Use `cg task done <goal_id>` (it works on `kind:goal` too) or `cg node update --id <goal_id> --state done` after every contributing task is done and evidence is attached. Do not invent an evidence node just to "mark a goal done".
- If `cg case close` refuses, read `cg validate --format json` first, fix the reported blocker (usually: a task not yet done, or the goal not yet done), then retry. Do not force close or paper over with fabricated evidence.
- If the case still has ready work or unresolved warnings, closing needs explicit judgment.

## Context economy

Every `cg` invocation and its output become a tool_use + tool_result in the session history, which the next API call re-sends in full. For long workflows, call volume — not single-command size — drives context growth. Trim where it does not cost correctness; `cg frontier` is the authoritative ready-set and is the point of using cg, so keep reading it — cut other noise instead.

- Prefer default text format for status reads (`cg case show`, `cg validate`). Reach for `--format json` only when the agent will actually parse a field. `cg frontier` is the exception: agents typically need `node_id` values, so json is the right default there.
- Batch node/edge creation up front when the plan is known; avoid interleaving node adds with execution just to "see the graph grow" in the transcript.
- Attach `cg evidence add` for outcomes and checkpoints that must survive compaction, not for narration of each intermediate step.

## Command skeleton

This is the happy-path set only. For any verb, flag, enum, or jq pattern beyond what is shown here, read [cg-cli-cheatsheet.md](references/cg-cli-cheatsheet.md) **before** running `cg <verb> --help` — it is compact and covers the whole Phase 0+ surface (node update, task wait/cancel/fail, analyze, patch, sync, worker, migrate, enums). Fall back to `--help` only when the cheatsheet lacks what you need.

```sh
cg case new --id <case_id> --title "<title>"
cg node add --case <case_id> --id goal_<name> --kind goal --title "<goal>" --description "<what done looks like, constraints, out-of-scope>"
cg node add --case <case_id> --id task_<name> --kind task --title "<task>" --description "<acceptance criteria, inputs, expected artifact>"
cg edge add --case <case_id> --id edge_<name> --type contributes_to --from task_<name> --to goal_<name>
cg frontier --case <case_id> --format json
cg task start --case <case_id> task_<name>
cg evidence add --case <case_id> --id evidence_<name> --title "<title>" --target task_<name> --description "<summary>"
cg task done --case <case_id> task_<name>
# After every contributing task is done, mark the goal done too:
cg task done --case <case_id> goal_<name>
cg validate --case <case_id> --format json
cg case close --case <case_id>
```

## Resume order

When resuming after compaction or handoff:

1. `cg case show --case <id> --format json`
2. `cg frontier --case <id> --format json`
3. the latest checkpoint and verification evidence
4. unresolved waiting or failed nodes
5. recent decisions and event nodes

## References

- [cg-cli-cheatsheet.md](references/cg-cli-cheatsheet.md)
- [task-templates.md](references/task-templates.md)
- [checkpoint-evidence.md](references/checkpoint-evidence.md)
- [close-and-resume-rules.md](references/close-and-resume-rules.md)
- [github-projection.md](references/github-projection.md)

## Related

- direct workspace reading or manual authoring: **casegraph**
- AI-authored `GraphPatch` changes: **casegraph-patch**
- importers, workers, sync, validation, and recovery: **casegraph-integrate**
