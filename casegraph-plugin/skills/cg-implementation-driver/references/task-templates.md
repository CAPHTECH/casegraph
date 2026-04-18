# Task templates

Use these patterns to build the smallest graph that still exposes sequencing, blockers, verification, and close readiness.

## Node naming

- Goals: `goal_<outcome>`
- Tasks: `task_<verb>_<object>`
- Decisions: `decision_<question>`
- Events: `event_<milestone_or_external_fact>`
- Evidence: `evidence_<what_was_proven>`

Prefer stable, outcome-oriented names over chat-specific phrasing.

## Edge selection

- `depends_on`: hard prerequisite inside the case
- `waits_for`: waiting on an external event node or milestone
- `contributes_to`: a work node advances a goal
- `verifies`: evidence proves a task, decision, or goal
- `alternative_of`: mutually exclusive options

If an edge does not change readiness, it probably does not need to exist.

## Template: small implementation

Use for a bounded feature, fix, or refactor that can be completed in one working slice.

- `goal_<outcome>`
- `task_implement_<outcome>`
- `task_verify_<outcome>`
- `task_verify_<outcome> depends_on task_implement_<outcome>`
- both tasks `contributes_to` the goal

This is the default template.

## Template: multi-step implementation

Use when there is real sequencing across design, code, docs, and verification.

- `goal_<outcome>`
- `task_shape_structure`
- `task_apply_change`
- `task_update_docs`
- `task_verify_delivery`
- `task_apply_change depends_on task_shape_structure`
- `task_update_docs depends_on task_apply_change`
- `task_verify_delivery depends_on task_apply_change`
- `task_verify_delivery depends_on task_update_docs`
- every task `contributes_to` the goal

Do not split further unless separate blockers or ownership boundaries appear.

## Template: investigation before fix

Use when the path to the fix is still uncertain.

- `goal_resolve_<problem>`
- `task_reproduce_<problem>`
- `task_identify_cause`
- `decision_fix_direction`
- `task_apply_fix`
- `task_verify_regression`

Typical ordering:

- `task_identify_cause depends_on task_reproduce_<problem>`
- `decision_fix_direction depends_on task_identify_cause`
- `task_apply_fix depends_on decision_fix_direction`
- `task_verify_regression depends_on task_apply_fix`

When an external signal matters, add an event node and connect waiting tasks with `waits_for`.

## Template: external dependency

Use when part of the work depends on another team, service, review, or user action.

- create `event_<external_fact>`
- mark the waiting task with `cg task wait --case <id> <task_id> --reason "<why>" --for <event_id>`
- record the event only when the fact actually happens: `cg event record --case <id> <event_id>`
- resume the waiting task after the blocker clears

Do not fake progress by keeping a blocked task in `doing`.

## Template: docs or skill authoring

Use when the deliverable is reusable guidance rather than runtime code.

- `goal_publish_<guidance>`
- `task_write_primary_artifact`
- `task_link_entrypoints`
- `task_validate_examples_or_references`

Treat examples, command snippets, and cross-links as verification work, not as part of writing.

## Minimum graph rule

Start with one goal, one implementation task, and one verification task. Only add more nodes when at least one of these becomes true:

- a real ordering constraint exists
- a blocker can stall work independently
- a separate proof step is needed
- a decision point can branch future work
- the task needs handoff-safe checkpoints
