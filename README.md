# CaseGraph

CaseGraph is a local-first, CLI-first case graph for work that has dependencies, waits, evidence, and AI-assisted patch proposals.

Instead of treating work as a flat todo list, CaseGraph models it as a graph with:

- tasks, goals, decisions, events, and evidence
- `depends_on`, `waits_for`, and `contributes_to` edges
- deterministic frontier and blocker calculation
- patch-mediated AI changes via `GraphPatch`
- markdown sync as the v0.1 reference integration

The source of truth stays local. AI does not own state; it proposes patches.

## Status

- Version: `0.1.0`
- License: `Apache-2.0`
- Project type: public OSS, local-first, CLI-first

Current implementation includes:

- core case / node / edge / event operations
- deterministic replay, validation, frontier, blockers
- patch validate / review / apply
- markdown import and markdown sync
- worker execution (`shell`, `code-agent`, `local-llm`)
- graph analysis surfaces such as `impact`, `critical-path`, `slack`, and `bottlenecks`

## Quickstart

Prerequisites:

- Node.js 24+
- `pnpm` 10+

```bash
pnpm install
pnpm build
export WORKSPACE="$(mktemp -d /tmp/casegraph-demo.XXXXXX)"

pnpm run cg --workspace "$WORKSPACE" init --title "CaseGraph Demo"
pnpm run cg --workspace "$WORKSPACE" case new --id release-demo --title "Release demo"
pnpm run cg --workspace "$WORKSPACE" node add --case release-demo --id goal_release_demo --kind goal --title "Release demo ready"
pnpm run cg --workspace "$WORKSPACE" node add --case release-demo --id task_write_notes --kind task --title "Write release notes" --state todo
pnpm run cg --workspace "$WORKSPACE" node add --case release-demo --id task_publish --kind task --title "Publish build" --state todo
pnpm run cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_publish_depends_notes --type depends_on --from task_publish --to task_write_notes
pnpm run cg --workspace "$WORKSPACE" frontier --case release-demo
pnpm run cg --workspace "$WORKSPACE" blockers --case release-demo
```

For the full walkthrough:

- [Quickstart (EN)](docs/guides/quickstart.en.md)
- [Quickstart (JA)](docs/guides/quickstart.ja.md)

## Documentation

- [Docs index](docs/README.md)
- [CLI specification](docs/spec/05-cli.md)
- [Testing strategy](docs/spec/10-testing-strategy.md)
- [Release case example](docs/examples/release-case.md)
- [Move case example](docs/examples/move-case.md)
- [Roadmap](docs/roadmap.md)

Release and verification guides:

- [Release checklist (EN)](docs/guides/release-checklist.en.md)
- [Release checklist (JA)](docs/guides/release-checklist.ja.md)
- [Manual acceptance (EN)](docs/guides/manual-acceptance.en.md)
- [Manual acceptance (JA)](docs/guides/manual-acceptance.ja.md)

## Development

Common commands:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:analysis-golden
pnpm test:analysis-eval
```

The CLI entrypoint used in docs and tests is:

```bash
pnpm run cg --workspace "$WORKSPACE" ...
```

## Repository layout

```text
docs/       specs, ADRs, guides, examples
packages/   core, cli, importer, sink, workers
tests/      unit, integration, conformance, property, e2e
```

## Related integration

- [casegraph-plugin](casegraph-plugin/README.md) for Claude Code guidance

## Community

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](LICENSE).

Copyright 2026 CAPH TECH Inc.
