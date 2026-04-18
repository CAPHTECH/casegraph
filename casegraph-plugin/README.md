# casegraph-plugin

Claude Code plugin for the [CaseGraph](../) CLI.

Four skills that teach Claude how to read, author, orchestrate work, and integrate a CaseGraph workspace through the `cg` CLI.

## Skills

| Skill | Scope |
|-------|-------|
| `casegraph` | Workspace reading, manual authoring (case / node / edge / task / decision / event / evidence), and analysis (`frontier`, `blockers`, `analyze impact\|critical-path\|slack\|bottlenecks\|unblock`, `cycles`, `components`, `bridges`, `cutpoints`, `fragility`, `case view`). |
| `cg-workflow-driver` | Multi-step delivery through `cg`: minimum case structure, frontier-driven execution, compaction-safe checkpoint evidence, resume order, and guarded `cg case close` across implementation, docs, investigation, or review work. |
| `casegraph-patch` | AI-proposed graph changes via `GraphPatch`. Locks the `cg patch validate → review → apply` ordering, the `base_revision` contract, the fenced-block convention, and ADR-0003 "AI does not own state". |
| `casegraph-integrate` | External integrations (`cg import markdown`, `cg sync push\|pull`, `cg worker run`) and storage verification / recovery (`cg validate`, `cg cache rebuild`, `cg events verify\|export`, `cg migrate`). Covers plugin handshake, `env_allowlist`, `approval_policy`. |

The skills are split so that the highest-risk surfaces stay explicit: day-to-day graph reading, cg-driven workflow orchestration, patch application discipline, and external integration/recovery each have separate triggers and rules.

## Install

From the Claude Code CLI:

```
/plugin marketplace add <this-repo-path-or-URL>
/plugin install casegraph-plugin@casegraph-marketplace
```

Marketplace manifest: `../.claude-plugin/marketplace.json`.

## Relationship to CaseGraph core

This plugin is an **optional integration** for Claude Code. `packages/core` and `packages/cli` do not depend on it. The plugin only ships documentation/guidance for AI assistants — it is not an adapter in the sense of `docs/spec/06-adapter-protocol.md` (which covers out-of-process JSON-RPC importers / sinks / workers).

The design principle "core does not depend on a specific LLM vendor" is preserved.

## See also

- `docs/README.md` — design index
- `docs/spec/04-graphpatch.md` — GraphPatch specification
- `docs/spec/05-cli.md` — CLI surface
- `docs/adr/0003-patch-mediated-ai.md` — AI is patch-producing, not state-owning
- `docs/adr/0005-jsonrpc-stdio-plugin-protocol.md` — adapter protocol
