# Repository Guidelines

## Project Structure & Module Organization
`docs/` is the current source of truth. Use `docs/spec/` for numbered core specifications (`00-overview.md` through `11-schema-reference.md`), `docs/adr/` for architectural decisions, and `docs/examples/` for reference scenarios such as `release-case.md` and `move-case.md`. `docs/roadmap.md` and `docs/project-governance.md` define scope and contribution boundaries. The design docs also reserve future implementation space for `/packages` and `/tests`; until code lands, keep structural changes centered in `docs/`. `casegraph-plugin/` ships optional Claude Code integration skills (three `skills/*/SKILL.md`) surfaced via `.claude-plugin/marketplace.json`; it has no build step and no dependency on `/packages`.

## Build, Test, and Development Commands
Current contributor workflow centers on the pnpm TypeScript workspace:

- `rg --files docs` lists spec, ADR, and example files quickly.
- `sed -n '1,120p' docs/spec/05-cli.md` reviews a spec section from the terminal.
- `pnpm typecheck` runs the TypeScript project references check.
- `pnpm build` compiles the workspace packages.
- `pnpm test` runs the full Vitest suite.
- `pnpm test:analysis-golden` runs the topology-analysis golden corpus and prints exact-match metrics.
- `pnpm test:analysis-eval` runs the mixed analysis harness, including local external-manifest replay.
- `pnpm lint` runs Biome checks.
- `pnpm cg -- migrate check [--patch-file <path>]` scans workspace/event/explicit-patch `spec_version` compatibility.
- `git diff -- docs` checks doc-only edits before opening a PR.

## Coding Style & Naming Conventions
Write in Markdown with short sections, explicit headings, and fenced command or JSON examples. Keep filenames in kebab-case. Preserve numeric prefixes for ordered specs (`05-cli.md`) and zero-padded ADRs (`0003-patch-mediated-ai.md`). Match the repo’s existing style: Japanese explanatory prose is fine, but keep stable technical terms and CLI verbs literal and consistent, for example `GraphPatch`, `cg frontier`, and `cg sync push`.

## Testing Guidelines
Follow `docs/spec/10-testing-strategy.md` when proposing behavior: prioritize reducer determinism, graph invariants, frontier and blocker correctness, patch apply safety, protocol conformance, and golden CLI fixtures. If a change affects user-visible behavior, update or add an acceptance example under `docs/examples/`.

## Commit & Pull Request Guidelines
`main` has no commit history yet, so there is no established message pattern to copy. Start with concise Conventional Commit subjects such as `docs: clarify approval policy` or `spec: add stale patch rejection rule`. PRs should state design intent, list affected spec/ADR/example files, and call out compatibility risks for event logs, patch contracts, or JSON-RPC protocols. Include a short CLI snippet when behavior changes.

## Security & Design Rules
Do not commit secrets, tokens, or raw credentials in docs or examples. Preserve the repository’s core constraints: local-first source of truth, AI as a patch producer rather than a state owner, and external services treated as projections instead of the system of record.
