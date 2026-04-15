# Repository Guidelines

## Project Structure & Module Organization
`docs/` is the current source of truth. Use `docs/spec/` for numbered core specifications (`00-overview.md` through `11-schema-reference.md`), `docs/adr/` for architectural decisions, and `docs/examples/` for reference scenarios such as `release-case.md` and `move-case.md`. `docs/roadmap.md` and `docs/project-governance.md` define scope and contribution boundaries. The design docs also reserve future implementation space for `/packages` and `/tests`; until code lands, keep structural changes centered in `docs/`.

## Build, Test, and Development Commands
No build system or runnable reference implementation is checked in yet. Current contributor workflow is document-driven:

- `rg --files docs` lists spec, ADR, and example files quickly.
- `sed -n '1,120p' docs/spec/05-cli.md` reviews a spec section from the terminal.
- `git diff -- docs` checks doc-only edits before opening a PR.

If you introduce code or tooling, add the corresponding build and test commands to this file in the same change.

## Coding Style & Naming Conventions
Write in Markdown with short sections, explicit headings, and fenced command or JSON examples. Keep filenames in kebab-case. Preserve numeric prefixes for ordered specs (`05-cli.md`) and zero-padded ADRs (`0003-patch-mediated-ai.md`). Match the repo’s existing style: Japanese explanatory prose is fine, but keep stable technical terms and CLI verbs literal and consistent, for example `GraphPatch`, `cg frontier`, and `cg sync push`.

## Testing Guidelines
There is no committed automated test suite yet. Follow `docs/spec/10-testing-strategy.md` when proposing behavior: prioritize reducer determinism, graph invariants, frontier and blocker correctness, patch apply safety, protocol conformance, and golden CLI fixtures. If a change affects user-visible behavior, update or add an acceptance example under `docs/examples/`.

## Commit & Pull Request Guidelines
`main` has no commit history yet, so there is no established message pattern to copy. Start with concise Conventional Commit subjects such as `docs: clarify approval policy` or `spec: add stale patch rejection rule`. PRs should state design intent, list affected spec/ADR/example files, and call out compatibility risks for event logs, patch contracts, or JSON-RPC protocols. Include a short CLI snippet when behavior changes.

## Security & Design Rules
Do not commit secrets, tokens, or raw credentials in docs or examples. Preserve the repository’s core constraints: local-first source of truth, AI as a patch producer rather than a state owner, and external services treated as projections instead of the system of record.
