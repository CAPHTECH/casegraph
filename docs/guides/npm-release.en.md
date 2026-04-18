# npm Release Guide

Japanese: [npm-release.ja.md](npm-release.ja.md)

Use this guide when preparing the scoped npm release for CaseGraph.

## Scope

All published packages use the `@caphtech` npm scope:

- `@caphtech/casegraph-kernel`
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

To publish the full release with one OTP entry, use:

```bash
pnpm publish:release -- --otp 123456
```

If the OTP expires or a later package fails, resume from a specific package:

```bash
pnpm publish:release -- --from @caphtech/casegraph-worker-shell --otp 654321
```

For unattended publishing, prefer npm trusted publishing or a granular access token with bypass 2FA. The OTP helper is intended for interactive local releases.

## Publish order

`pnpm publish:release` publishes in dependency order so the CLI can resolve the packages it depends on. The effective order is:

```bash
pnpm --filter @caphtech/casegraph-kernel publish --access public
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
