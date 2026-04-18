---
name: cg-implementation-driver
description: Use when the user wants multi-step coding work managed through CaseGraph instead of ad hoc chat state. Trigger on phrases like "manage this in cg", "drive implementation from the case", "record evidence for compaction", "resume from cg", "verify before close", or when a task needs durable checkpoints, verification, and guarded closure.
---

# Drive implementation through CaseGraph

## Overview

Use CaseGraph as the durable task backbone for implementation, verification, resume, and close. Build only the graph needed to expose sequencing and blockers, record evidence before context can be lost, and treat `cg case close` as an explicit end-state check rather than a synonym for "work feels done".

Use this skill for direct case management through the `cg` CLI. For normal workspace reading use **casegraph**. For AI-authored graph changes use **casegraph-patch**. For importers, workers, sync, or storage recovery use **casegraph-integrate**.

## Command bootstrap

Resolve a working launcher before using the commands below:

1. If `cg --help` works, use `cg`.
2. If CaseGraph is installed locally in the current project, use `pnpm exec cg --help` or `npx cg --help`.
3. If you are inside the CaseGraph repository, run `pnpm install` and `pnpm build`, then use `pnpm cg --help`.
4. If none of those work, install `@caphtech/casegraph-cli` and use either global `cg` or project-local `pnpm exec cg`.

In the rest of this skill, `cg ...` means "use the launcher that succeeded here."

## When to use

Use this skill when:

- the task spans multiple implementation or verification steps
- the user explicitly asks to manage the work in `cg`
- compaction, handoff, or long-running execution can erase chat context
- decisions, evidence, and close state need to survive outside the transcript

Skip it for tiny one-pass edits that do not need a durable case.

## Operating loop

1. Resolve or create the case.
   - Reuse an existing case when the outcome is the same.
   - Otherwise create a case with one goal and the minimum task graph needed to expose the frontier.
2. Build the minimum useful structure.
   - Add a goal plus concrete task nodes.
   - Use `depends_on` for hard sequencing, `waits_for` for external blockers, and `contributes_to` from work nodes to the goal.
   - Read [task-templates.md](references/task-templates.md) when deciding how much graph to create.
3. Execute from the frontier.
   - Inspect `cg frontier --case <id> --format json`.
   - Start only the task you are actively executing.
   - If the next step is blocked, record the blocker in the case instead of leaving it only in chat.
4. Change code and checkpoint before context can disappear.
   - Record evidence for what changed, what was verified, and what remains.
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
- Use `event record` only after creating an event node, and only for milestone or external-world facts worth preserving.
- Keep node titles outcome-oriented so they work as resume anchors.
- If a task is still being proven, it is not done yet.
- If the case still has ready work or unresolved warnings, closing needs an explicit judgment.

## Command skeleton

```sh
cg case new --id <case_id> --title "<title>"
cg node add --case <case_id> --id goal_<name> --kind goal --title "<goal>"
cg node add --case <case_id> --id task_<name> --kind task --title "<task>"
cg edge add --case <case_id> --id edge_<name> --type contributes_to --from task_<name> --to goal_<name>
cg frontier --case <case_id> --format json
cg task start --case <case_id> task_<name>
cg evidence add --case <case_id> --id evidence_<name> --title "<title>" --target task_<name> --description "<summary>"
cg task done --case <case_id> task_<name>
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

- [task-templates.md](references/task-templates.md)
- [checkpoint-evidence.md](references/checkpoint-evidence.md)
- [close-and-resume-rules.md](references/close-and-resume-rules.md)

## Related

- direct workspace reading or manual authoring: **casegraph**
- AI-authored `GraphPatch` changes: **casegraph-patch**
- importers, workers, sync, validation, and recovery: **casegraph-integrate**
