# Decomposition patterns

Use this reference before creating task nodes. Pick the closest case type, then fit the graph to the task. The point is not to make a large graph; it is to expose the next safe pause, proof, or handoff boundary.

## Selection rules

- Use 2 task nodes when the work has one core change boundary and one consumer/verification boundary.
- Use 3 task nodes when diagnosis, implementation, and verification are meaningfully separate.
- Use 4 task nodes only when rollback/ops/security/adversarial proof is a separate deliverable.
- Do not split by file unless each file has a different owner, blocker, or proof condition.
- Every task must state the check or evidence that proves it is done.

## Case types

| Case type | Use when | Recommended task cut |
| --- | --- | --- |
| API or type contract propagation | A primitive type/signature changes and callers/tests must follow | 1. core contract and primitive behavior; 2. consumers, composition, and tests |
| Async or error propagation | A sync API becomes async, or thrown/returned errors propagate through callers | 1. source API/helper and direct behavior; 2. caller propagation and tests |
| Bug fix with known failure | A reproducible defect has a narrow suspected area | 1. reproduce/localize; 2. fix; 3. regression verification |
| Refactor with invariant preservation | Structure changes but behavior must stay stable | 1. characterize invariants/checks; 2. structural change; 3. invariant verification |
| Multi-module migration | Several modules must move to one new shared contract | 1. shared primitive/adapter; 2. downstream consumers; 3. cross-module tests and cleanup |
| Test or verification hardening | Main deliverable is confidence, not feature behavior | 1. identify missing proof; 2. add checks/tests; 3. run and record verification |
| Investigation or review | The answer is findings, recommendation, or disposition | 1. collect evidence; 2. analyze and resolve uncertainty; 3. publish recommendation |
| Security, concurrency, or data migration | Failure modes are adversarial or operational | 1. invariants/threat model; 2. implementation; 3. adversarial/regression checks; 4. rollback/ops evidence |
| Documentation or skill authoring | Output is durable guidance | 1. write primary artifact; 2. link entrypoints/examples; 3. validate examples and references |

## Handoff-ready case requirements

A case is ready for a fresh worker session only when all of these are true:

- exactly one goal node captures the outcome, acceptance criteria, constraints, and out-of-scope items
- 2-4 task nodes exist and are cut by verification or handoff boundary
- every task description names the artifact it should change or produce
- every task description names the smallest proof command or evidence required before `task done`
- hard ordering is represented with `depends_on`
- `cg frontier --case <id> --format json` has a small ready set, ideally one node
- the case is open, not closed, and no implementation task has been marked done without evidence

If a case fails these requirements, repair the graph before implementation. Do not rely on chat history to fill missing acceptance criteria.

## Examples

### Result type migration

Use the API/type contract propagation pattern:

- `task_update_contract`: add Result type and convert validators
- `task_update_consumers_tests`: update services/app/tests and run verification

### Sync-to-async propagation

Use the async propagation pattern:

- `task_update_async_source`: add async helper and update the source API
- `task_propagate_callers_tests`: update callers/tests and run typecheck/tests

### Bug fix

Use the bug fix pattern:

- `task_reproduce_failure`: prove the failure and identify the smallest failing path
- `task_fix_cause`: change the implementation
- `task_verify_regression`: run the regression and relevant adjacent checks
