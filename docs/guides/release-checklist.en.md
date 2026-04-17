# v0.1 Release Checklist

Japanese: [release-checklist.ja.md](release-checklist.ja.md)

Use this checklist when calling the current tree a `v0.1` release candidate.

When verifying a temporary workspace from the repository root, set `WORKSPACE=/path/to/temp-dir` and use `pnpm run cg --workspace "$WORKSPACE" ...`.

## Scope and surface

- [ ] The stable core remains the Phase 1 CLI surface plus storage recovery/admin commands
- [ ] Markdown sync is still the required reference integration
- [ ] External sinks remain optional integrations
- [ ] Deferred topics are not being treated as release blockers

## Automated verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:e2e`
- [ ] `pnpm pack:release`
- [ ] `pnpm publish:release:dry-run`

Optional diagnostics when analyzing failures:

- [ ] `pnpm test:analysis-golden`
- [ ] `pnpm test:analysis-eval`

## Manual verification

- [ ] The [Quickstart](quickstart.en.md) completes end to end
- [ ] The [Manual Acceptance](manual-acceptance.en.md) flow completes end to end
- [ ] `pnpm run cg --workspace "$WORKSPACE" migrate check` reports the expected status on the checked workspace
- [ ] `pnpm run cg --workspace "$WORKSPACE" case view --case release-1.8.0` renders a non-empty tree for the release example

## Documentation review

- [ ] `docs/README.md` links to the current guides
- [ ] English and Japanese guide pairs describe the same flow
- [ ] `docs/spec/00-overview.md` success criteria still match the implementation
- [ ] `docs/spec/10-testing-strategy.md` still matches the actual regression suite

## Release notes input

- [ ] Record the commit hash used for the release candidate
- [ ] Record the verification date
- [ ] Record the exact commands that passed
- [ ] Note any known optional surfaces or deferred items explicitly
- [ ] Confirm the npm scope is `@caphtech`
- [ ] Confirm the publish order matches [npm Release Guide](npm-release.en.md)

## Minimum release statement

Before publishing, be able to state all of the following without caveats:

- the deterministic core is passing its full regression suite
- markdown sync is passing both happy-path and edge-case regressions
- black-box E2E is passing the documented core + sync flows
- the docs describe the current stable and optional boundaries accurately
