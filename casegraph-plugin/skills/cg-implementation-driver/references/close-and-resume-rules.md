# Close and resume rules

Treat completion and closure as separate states. A task becomes done when its outcome is verified. A case becomes closed only when the whole graph is in a stable end state.

## Task completion pattern

Use this loop for each concrete task:

1. `pnpm cg frontier --case <id> --format json`
2. `pnpm cg task start --case <id> <task_id>`
3. make the change
4. run the relevant checks
5. attach checkpoint or verification evidence
6. `pnpm cg task done --case <id> <task_id>`

Do not mark a task done before the evidence exists.

## Case close checklist

Before closing:

1. run `pnpm cg validate --case <id> --format json`
2. inspect `pnpm cg frontier --case <id> --format json`
3. inspect blockers or waiting nodes if anything is unresolved
4. make sure the final verification evidence is attached
5. close with `pnpm cg case close --case <id>`

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

1. `pnpm cg case show --case <id> --format json`
2. `pnpm cg frontier --case <id> --format json`
3. read the latest checkpoint evidence
4. read the latest verification evidence
5. inspect waiting, failed, or cancelled nodes
6. continue the highest-value ready node or resolve the active blocker

If the case no longer matches the real work, update the graph before executing more code.

## Anti-patterns

- Closing because all chat messages look settled
- Marking tasks done without proof
- Leaving critical resume context only in the transcript
- Recording every small action as an event
- Using `doing` to hide external waiting
- Forcing close to silence unresolved blockers
