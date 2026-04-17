# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and the project follows semantic versioning for published packages.

## [0.1.1] - 2026-04-18

### Fixed

- Fixed `@caphtech/casegraph-cli` so `cg --help` exits with code `0` instead of reporting `internal_error: (outputHelp)`.

### Verification

- `pnpm build`
- `pnpm lint`
- `pnpm test`
- public install verification with `npm install -g @caphtech/casegraph-cli@0.1.1`

## [0.1.0] - 2026-04-18

### Added

- Initial public npm publication under the `@caphtech` scope.
- Public packages for the deterministic core, CLI, markdown importer, markdown sink, and built-in workers.
- Package README files, npm metadata, and release guides for public installation and release operations.

### Changed

- Built-in plugin resolution now supports both monorepo development entrypoints and published package installs.

### Verification

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm pack:release`
- npm publish dry-run and published install-path verification
