# Checkpoint and evidence rules

Use evidence, decisions, and event nodes to preserve context that must survive compaction, handoff, or asynchronous verification.

## Record type selection

- Evidence: what changed, what was checked, what remains, and how to resume
- Decision: which option was chosen and why it now constrains future work
- Event: a milestone or external fact that actually happened

If the information should help the next agent continue safely, prefer evidence.

## Checkpoint evidence

Create checkpoint evidence before likely interruption, task switching, or long verification runs.

Recommended payload:

- current objective
- files or surfaces touched
- commands already run
- result summary
- remaining frontier
- known risks or open questions
- exact next step

Example:

```sh
cg evidence add \
  --case <id> \
  --id evidence_checkpoint_<name> \
  --title "Checkpoint: <task>" \
  --target <task_id> \
  --description "Changed <files>. Ran <commands>. Verified <result>. Next: <next step>. Risks: <open risk>."
```

## Verification evidence

Create verification evidence after running checks that support `task done` or `case close`.

Recommended payload:

- command or test name
- observed result
- warnings that remain
- scope of what was actually proven

Example:

```sh
cg evidence add \
  --case <id> \
  --id evidence_verify_<name> \
  --title "Verification: <task or goal>" \
  --target <task_or_goal_id> \
  --description "Ran <command>. Result: <pass/fail>. Proved: <scope>. Remaining warnings: <warnings or none>."
```

## Event recording

Use an event node only when the fact deserves its own timeline marker.

Typical cases:

- external approval arrived
- migration finished
- release artifact was published
- dependent service recovered

Flow:

1. create the event node
2. connect waiting tasks with `waits_for` if needed
3. call `cg event record --case <id> <event_id>` only when it actually happened

## Decision recording

Record a decision when one option is selected and future work now depends on it.

Capture:

- the chosen option
- the reason it won
- what alternatives were rejected
- which downstream task now depends on that choice

Do not create decisions for reversible trivia.

## Checkpoint cadence

Record a checkpoint at these moments:

- before a long-running command
- before switching tasks
- before waiting on an external blocker
- after a meaningful verification result
- before closing a case

Missing one checkpoint is usually cheaper than rebuilding the entire context from chat.
