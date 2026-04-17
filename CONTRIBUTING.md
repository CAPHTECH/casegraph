# Contributing to CaseGraph

Thanks for contributing to CaseGraph.

CaseGraph is a local-first, CLI-first graph for work with deterministic core behavior. The project values small, well-grounded changes over broad speculative expansion.

## Before you change anything

Read these first:

- [README.md](README.md)
- [docs/README.md](docs/README.md)
- [docs/roadmap.md](docs/roadmap.md)
- [docs/project-governance.md](docs/project-governance.md)

If your change affects behavior, also read the relevant spec section under `docs/spec/`.

## What to optimize for

Prefer changes that preserve these constraints:

- local-first source of truth
- deterministic replay and reducer behavior
- AI as patch-producing, not state-owning
- external tools treated as projections, not the system of record

Be especially careful with:

- event log semantics
- `GraphPatch` contracts
- frontier / blocker derivation
- plugin protocol compatibility
- user-visible CLI JSON output

## Development workflow

1. Create a branch from `main`.
2. Keep the change narrowly scoped.
3. Update docs and examples when user-visible behavior changes.
4. Run the relevant checks locally.
5. Open a pull request with intent, affected files, and compatibility notes.

## Local checks

Run the baseline checks from the repository root:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Run these when relevant:

```bash
pnpm test:e2e
pnpm test:analysis-golden
pnpm test:analysis-eval
```

Use `pnpm test:e2e` when the documented CLI flow or markdown sync behavior changes.

## Documentation expectations

This repository is doc-driven. If you change behavior, update the corresponding material:

- `docs/spec/` for normative behavior
- `docs/examples/` for acceptance-oriented examples
- `docs/guides/` for user-facing operating flow
- `docs/adr/` for architectural decisions that need explicit rationale

## Commit and pull request guidance

- Use concise Conventional Commit subjects such as `fix: ...`, `docs: ...`, `test: ...`, `ci: ...`.
- Mention compatibility risks for event logs, patch files, and JSON-RPC protocols.
- Include a short CLI snippet when behavior changes.

## Security

Do not open public issues for suspected vulnerabilities until you have checked [SECURITY.md](SECURITY.md).

Never commit:

- secrets
- tokens
- production credentials
- private customer or workspace data

## License

By contributing to this repository, you agree that your contributions will be licensed under the Apache License 2.0 that applies to this project.
