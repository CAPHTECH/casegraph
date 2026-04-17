# Quickstart

Japanese: [quickstart.ja.md](quickstart.ja.md)

This guide gets a fresh workspace running, creates a small case, pushes a markdown projection, and pulls a state change back as a patch.

## Prerequisites

- Node.js 24+ recommended
- `pnpm` 10+
- A writable workspace directory

## 1. Install and build

```bash
pnpm install
pnpm build
```

The CLI entrypoint used in this guide is `pnpm cg`.

## 2. Initialize a workspace

```bash
pnpm cg init --title "CaseGraph Demo"
```

This creates `.casegraph/` in the current directory.

## 3. Create a small release case

```bash
pnpm cg case new --id release-demo --title "Release demo" --description "Quickstart case"

pnpm cg node add --case release-demo --id goal_release_demo --kind goal --title "Release demo ready"
pnpm cg node add --case release-demo --id task_write_notes --kind task --title "Write release notes" --state todo
pnpm cg node add --case release-demo --id task_publish --kind task --title "Publish build" --state todo

pnpm cg edge add --case release-demo --id edge_publish_depends_notes --type depends_on --from task_publish --to task_write_notes
pnpm cg edge add --case release-demo --id edge_notes_goal --type contributes_to --from task_write_notes --to goal_release_demo
pnpm cg edge add --case release-demo --id edge_publish_goal --type contributes_to --from task_publish --to goal_release_demo
```

## 4. Inspect the initial state

```bash
pnpm cg frontier --case release-demo
pnpm cg blockers --case release-demo
```

Expected result:

- `task_write_notes` is actionable
- `task_publish` is blocked by `task_write_notes`

## 5. Push the markdown projection

```bash
pnpm cg sync push --sink markdown --case release-demo --apply
```

This writes:

```text
.casegraph/cases/release-demo/projections/markdown.md
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
pnpm cg sync pull --sink markdown --case release-demo --output ./release-demo-sync.patch.json
pnpm cg patch review --file ./release-demo-sync.patch.json
pnpm cg patch apply --file ./release-demo-sync.patch.json
```

## 8. Confirm the next actionable task

```bash
pnpm cg frontier --case release-demo
pnpm cg case view --case release-demo
```

Expected result:

- `task_publish` is now actionable
- the case view shows `task_write_notes` as done and `task_publish` as the remaining task on the critical branch

## 9. Optional analysis commands

```bash
pnpm cg analyze critical-path --case release-demo --goal goal_release_demo
pnpm cg analyze slack --case release-demo --goal goal_release_demo
pnpm cg analyze bottlenecks --case release-demo --goal goal_release_demo
```

## Related guides

- [v0.1 Release Checklist (EN)](release-checklist.en.md)
- [Manual Acceptance (EN)](manual-acceptance.en.md)
