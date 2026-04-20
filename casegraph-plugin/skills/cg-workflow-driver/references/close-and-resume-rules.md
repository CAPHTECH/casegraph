# Close and resume rules

Treat completion and closure as separate states. A task becomes done when its outcome is verified. A case becomes closed only when the whole graph is in a stable end state.

## Task completion pattern

Use this loop for each concrete task:

1. `cg frontier --case <id> --format json`
2. `cg task start --case <id> <task_id>`
3. make the change
4. run the relevant checks
5. attach checkpoint or verification evidence
6. `cg task done --case <id> <task_id>`

Do not mark a task done before the evidence exists.

## Case close checklist

Before closing:

1. run `cg validate --case <id> --format json`
2. inspect `cg frontier --case <id> --format json`
3. inspect blockers or waiting nodes if anything is unresolved
4. make sure the final verification evidence is attached
5. close with `cg case close --case <id>`

Use `--force` only when the remaining issue is an understood warning, not when hard blockers still exist.

## What close should mean

A closed case should imply:

- no ready work remains
- no unresolved hard dependency prevents the goal state
- the final verification surface is explicit
- the next reader can tell why the work is considered complete

If one of these is missing, keep the case open.

## Resume pattern

After compaction, handoff, or a long pause:

1. `cg case show --case <id> --format json`
2. `cg frontier --case <id> --format json`
3. read the latest checkpoint evidence
4. read the latest verification evidence
5. inspect waiting, failed, or cancelled nodes
6. continue the highest-value ready node or resolve the active blocker

If the case no longer matches the real work, update the graph before executing more code.

## Marking a goal done before close

- Every contributing task finishes, then the goal itself must be in the `done` state before `cg case close` will succeed.
- `cg task done <goal_id>` works on `kind:goal` today (it is the generic "mark a node as done"). `cg node update --id <goal_id> --state done` is equivalent. Either is fine.
- Evidence nodes are created by `cg evidence add` and attach via the `verifies` edge. They record proof, not completion — do not synthesize an evidence node just to satisfy close.

## When close refuses

`cg case close` does not fail silently on a whim. If it refuses:

1. run `cg validate --case <id> --format json` and read the `blockers` / `warnings` fields.
2. if a task is the blocker, finish or cancel it.
3. if the goal is the blocker, mark it done via `cg task done <goal_id>` or `cg node update --state done`.
4. only then retry `cg case close`. Use `--force` only for a warning you have explicitly judged safe to ignore.

## Anti-patterns

- Closing because all chat messages look settled
- Marking tasks done without proof
- Leaving critical resume context only in the transcript
- Recording every small action as an event
- Using `doing` to hide external waiting
- Forcing close to silence unresolved blockers
- Creating a new evidence node just to mark a goal as complete (evidence records proof, not completion)
- Forgetting to mark the goal done and then assuming `cg case close` is broken
