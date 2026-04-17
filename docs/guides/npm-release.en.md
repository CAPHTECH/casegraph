# npm Release Guide

Japanese: [npm-release.ja.md](npm-release.ja.md)

Use this guide when preparing the scoped npm release for CaseGraph.

## Scope

All published packages use the `@caphtech` npm scope:

- `@caphtech/casegraph-core`
- `@caphtech/casegraph-cli`
- `@caphtech/casegraph-importer-markdown`
- `@caphtech/casegraph-sink-markdown`
- `@caphtech/casegraph-worker-shell`
- `@caphtech/casegraph-worker-code-agent`
- `@caphtech/casegraph-worker-local-llm`

## Preconditions

- You are authenticated to npm with publish access to `@caphtech`
- The repository root is clean enough to identify the release commit
- `pnpm install` has been run with the current workspace metadata

## Verification

Run these commands from the repository root:

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm pack:release
pnpm publish:release:dry-run
```

`pnpm pack:release` confirms each package tarball includes the intended build output and metadata.  
`pnpm publish:release:dry-run` confirms publish ordering and registry metadata without publishing.

## Publish order

Publish in dependency order so the CLI can resolve the packages it depends on:

```bash
pnpm --filter @caphtech/casegraph-core publish --access public
pnpm --filter @caphtech/casegraph-importer-markdown publish --access public
pnpm --filter @caphtech/casegraph-sink-markdown publish --access public
pnpm --filter @caphtech/casegraph-worker-shell publish --access public
pnpm --filter @caphtech/casegraph-worker-code-agent publish --access public
pnpm --filter @caphtech/casegraph-worker-local-llm publish --access public
pnpm --filter @caphtech/casegraph-cli publish --access public
```

If a package must be republished after a failed attempt, bump versions before retrying. Do not rely on force-publishing an existing version.

## Post-release check

Verify the public install path after publish:

```bash
npm install -g @caphtech/casegraph-cli
cg --help
```
