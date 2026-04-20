# Quickstart

Japanese: [quickstart.ja.md](quickstart.ja.md)

This guide gets a fresh workspace running, creates a small case, pushes a markdown projection, and pulls a state change back as a patch.

## Prerequisites

- Node.js 22+ (required by `node:sqlite`)
- `@caphtech/casegraph-cli` installed globally: `npm install -g @caphtech/casegraph-cli`
- A writable workspace directory
- (Repository contributors running against source may substitute `pnpm run cg` for `cg` after `pnpm install && pnpm build`.)

## 1. Prepare a workspace directory

```bash
export WORKSPACE="$(mktemp -d /tmp/casegraph-demo.XXXXXX)"
```

The commands below target the empty workspace in `WORKSPACE`. The CLI entrypoint used in this guide is `cg --workspace "$WORKSPACE"`.

## 2. Initialize a workspace

```bash
cg --workspace "$WORKSPACE" init --title "CaseGraph Demo"
```

This creates `.casegraph/` under `"$WORKSPACE"`.

## 3. Create a small release case

```bash
cg --workspace "$WORKSPACE" case new --id release-demo --title "Release demo" --description "Quickstart case"

cg --workspace "$WORKSPACE" node add --case release-demo --id goal_release_demo --kind goal --title "Release demo ready"
cg --workspace "$WORKSPACE" node add --case release-demo --id task_write_notes --kind task --title "Write release notes" --state todo
cg --workspace "$WORKSPACE" node add --case release-demo --id task_publish --kind task --title "Publish build" --state todo

cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_publish_depends_notes --type depends_on --from task_publish --to task_write_notes
cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_notes_goal --type contributes_to --from task_write_notes --to goal_release_demo
cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_publish_goal --type contributes_to --from task_publish --to goal_release_demo
```

## 4. Inspect the initial state

```bash
cg --workspace "$WORKSPACE" frontier --case release-demo
cg --workspace "$WORKSPACE" blockers --case release-demo
```

Expected result:

- `task_write_notes` is actionable
- `task_publish` is blocked by `task_write_notes`

## 5. Push the markdown projection

```bash
cg --workspace "$WORKSPACE" sync push --sink markdown --case release-demo --apply
```

This writes:

```text
$WORKSPACE/.casegraph/cases/release-demo/projections/markdown.md
```

The built-in markdown sync is the required reference integration for v0.1, so no extra sink setup is needed.

## 6. Mark work complete in markdown

Open the generated markdown file and change:

```text
- [ ] Write release notes <!-- node: task_write_notes -->
```

to:

```text
- [x] Write release notes <!-- node: task_write_notes -->
```

## 7. Pull the change back as a patch

```bash
cg --workspace "$WORKSPACE" sync pull --sink markdown --case release-demo --output "$WORKSPACE/release-demo-sync.patch.json"
cg --workspace "$WORKSPACE" patch review --file "$WORKSPACE/release-demo-sync.patch.json"
cg --workspace "$WORKSPACE" patch apply --file "$WORKSPACE/release-demo-sync.patch.json"
```

## 8. Confirm the next actionable task

```bash
cg --workspace "$WORKSPACE" frontier --case release-demo
cg --workspace "$WORKSPACE" case view --case release-demo
```

Expected result:

- `task_publish` is now actionable
- the case view shows `task_write_notes` as done and `task_publish` as the remaining task on the critical branch

## 9. Optional analysis commands

```bash
cg --workspace "$WORKSPACE" analyze critical-path --case release-demo --goal goal_release_demo
cg --workspace "$WORKSPACE" analyze slack --case release-demo --goal goal_release_demo
cg --workspace "$WORKSPACE" analyze bottlenecks --case release-demo --goal goal_release_demo
```

## 10. Record the case as complete

```bash
cg --workspace "$WORKSPACE" task done --case release-demo task_publish
cg --workspace "$WORKSPACE" evidence add --case release-demo \
  --id evidence_publish_receipt \
  --title "Published build receipt" \
  --target task_publish \
  --url "https://example.invalid/releases/demo"
cg --workspace "$WORKSPACE" task done --case release-demo goal_release_demo
cg --workspace "$WORKSPACE" frontier --case release-demo
cg --workspace "$WORKSPACE" validate --case release-demo
cg --workspace "$WORKSPACE" case show --case release-demo
```

Expected result:

- `frontier` is empty
- `validate` returns success
- `case show` may still report `state: open` at this point

This is the current completion pattern.
Completion is represented through the combination of goal state, evidence, frontier, and validate output, and you can then close the case lifecycle explicitly.

## 11. Optionally close the case

```bash
cg --workspace "$WORKSPACE" case close --case release-demo
cg --workspace "$WORKSPACE" case show --case release-demo
```

Expected result:

- `case show` reports `state: closed`

## Related guides

- [v0.1 Release Checklist (EN)](release-checklist.en.md)
- [Manual Acceptance (EN)](manual-acceptance.en.md)
