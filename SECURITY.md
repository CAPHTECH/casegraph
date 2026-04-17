# Security Policy

## Supported versions

CaseGraph is currently in the `0.x` stage. The latest `main` branch is the supported line for security fixes.

## Reporting a vulnerability

Do not file a public issue for a suspected vulnerability.

Use one of these paths:

1. Open a GitHub Security Advisory / private vulnerability report for this repository if the UI is available.
2. If that is not available, contact a repository maintainer directly before publishing details.

Please include:

- affected version or commit hash
- reproduction steps
- impact
- any proof-of-concept or logs needed to validate the report
- whether the issue affects local-only use, plugin boundaries, or external integrations

## Scope

Reports are especially useful when they involve:

- approval bypass in worker execution
- unsafe patch application or validation bypass
- event log or cache integrity issues
- trust-boundary problems in importer / sink / worker protocols
- secret leakage in docs, examples, CI, or runtime behavior

## Disclosure expectations

- Give maintainers a reasonable chance to reproduce and fix the issue before public disclosure.
- Minimize public detail until a fix or mitigation is available.
- After a fix is available, coordinated public disclosure is welcome.
