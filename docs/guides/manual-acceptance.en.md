# Manual Acceptance

Japanese: [manual-acceptance.ja.md](manual-acceptance.ja.md)

This guide is a human-run end-to-end check for the current `v0.1` reference implementation. It exercises the deterministic core, markdown sync, patch review/apply, and one analysis surface.

Estimated time: 10 to 15 minutes.

## Prerequisites

```bash
pnpm install
pnpm build
```

Run the commands below in an empty temporary directory.

## 1. Initialize a workspace

```bash
pnpm cg init --title "Acceptance Workspace"
```

## 2. Create the release example

```bash
pnpm cg case new --id release-1.8.0 --title "Release 1.8.0" --description "May release"

pnpm cg node add --case release-1.8.0 --id goal_release_ready --kind goal --title "Release 1.8.0 ready"
pnpm cg node add --case release-1.8.0 --id task_run_regression --kind task --title "Run regression test" --state todo --metadata '{"estimate_minutes":45}'
pnpm cg node add --case release-1.8.0 --id task_update_notes --kind task --title "Update release notes" --state todo --metadata '{"estimate_minutes":15}'
pnpm cg node add --case release-1.8.0 --id task_submit_store --kind task --title "Submit to App Store" --state todo --metadata '{"estimate_minutes":20}'
pnpm cg node add --case release-1.8.0 --id task_monitor_post_release --kind task --title "Monitor post-release" --state todo --metadata '{"estimate_minutes":30}'
pnpm cg node add --case release-1.8.0 --id event_release_live --kind event --title "Release live" --state todo

pnpm cg edge add --case release-1.8.0 --id e1 --type depends_on --from task_submit_store --to task_run_regression
pnpm cg edge add --case release-1.8.0 --id e2 --type depends_on --from task_submit_store --to task_update_notes
pnpm cg edge add --case release-1.8.0 --id e3 --type waits_for --from task_monitor_post_release --to event_release_live
pnpm cg edge add --case release-1.8.0 --id e4 --type contributes_to --from task_run_regression --to goal_release_ready
pnpm cg edge add --case release-1.8.0 --id e5 --type contributes_to --from task_update_notes --to goal_release_ready
pnpm cg edge add --case release-1.8.0 --id e6 --type contributes_to --from task_submit_store --to goal_release_ready
pnpm cg edge add --case release-1.8.0 --id e7 --type contributes_to --from task_monitor_post_release --to goal_release_ready
```

## 3. Check the initial state

```bash
pnpm cg frontier --case release-1.8.0
pnpm cg blockers --case release-1.8.0
pnpm cg case view --case release-1.8.0
```

Expected result:

- frontier includes `task_run_regression` and `task_update_notes`
- blockers mention `task_submit_store` and `task_monitor_post_release`
- case view renders a readable tree

## 4. Push the markdown projection

```bash
pnpm cg sync push --sink markdown --case release-1.8.0 --apply
```

This creates:

```text
.casegraph/cases/release-1.8.0/projections/markdown.md
```

## 5. Complete two tasks in markdown

Edit the projection file and check both of these items:

```text
- [x] Run regression test <!-- node: task_run_regression -->
- [x] Update release notes <!-- node: task_update_notes -->
```

## 6. Pull, review, and apply the sync patch

```bash
pnpm cg sync pull --sink markdown --case release-1.8.0 --output ./release-sync.patch.json
pnpm cg patch review --file ./release-sync.patch.json
pnpm cg patch apply --file ./release-sync.patch.json
```

Expected result:

- patch review succeeds
- patch apply succeeds
- the patch changes the two checked tasks to `done`

## 7. Confirm the next frontier item

```bash
pnpm cg frontier --case release-1.8.0
```

Expected result:

- `task_submit_store` is now actionable

## 8. Finish the remaining release gate

```bash
pnpm cg task done --case release-1.8.0 task_submit_store
pnpm cg event record --case release-1.8.0 event_release_live
pnpm cg frontier --case release-1.8.0
```

Expected result:

- `task_monitor_post_release` becomes actionable after the event is recorded

## 9. Run one analysis surface

```bash
pnpm cg analyze critical-path --case release-1.8.0 --goal goal_release_ready
pnpm cg analyze slack --case release-1.8.0 --goal goal_release_ready
```

Expected result:

- both commands return structured output without errors
- the remaining unresolved path is centered on `task_monitor_post_release`

## 10. Verify storage integrity

```bash
pnpm cg validate storage
pnpm cg events verify --case release-1.8.0
pnpm cg cache rebuild
```

Expected result:

- storage validation succeeds
- event verification succeeds
- cache rebuild succeeds without changing the logical state

## Pass condition

This acceptance run passes when:

- the core mutation flow works
- markdown sync works end to end
- patch review/apply works on sync-generated patches
- storage recovery/admin commands still succeed afterwards
