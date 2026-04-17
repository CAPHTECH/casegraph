# Roadmap

## Phase 0: Design freeze
- spec 0.1-draft を文章で固める
- release case / move case を normative acceptance fixture として固定
- CLI command surface は Phase 1 core と storage recovery だけを凍結する
- Phase 2 以降の capability は残すが、CLI 名と UX はまだ凍結しない

## Phase 1: Reference implementation core
- workspace / case 作成
- event log
- reducer
- validation
- frontier / blockers
- JSON output CLI

## Phase 2: Patch and import
- GraphPatch parser / validator / apply
- markdown importer
- patch review CLI
- cache rebuild
- 参照実装の working surface は `cg patch ...` と `cg import markdown`

## Phase 3: Projection sinks
- markdown checklist sink
- Todoist sink
- Taskwarrior sink
- limited reverse sync

## Phase 4: Workers
- shell worker ✅
- local LLM worker ✅ (v0.2, Ollama 互換)
- code agent worker bridge ✅ (v0.2, claude/codex/aider CLI)
- approval policy ✅

## Phase 5: Hardening
- conformance suite
- property tests
- migration tool ✅ (current-version scan + no-op runner)
- better error surfaces ✅ (analysis / migration structured issues)
- TUI / graph view exploration

## Phase 6: Topology and evaluation
- current graph-topology docs consolidation
- algebraic topology ADR for Betti-0 / Betti-1 on projections
- mixed evaluation harness over golden corpus + event-export corpus ✅
- external real-data corpus loading via local manifest ✅ (JSON array + JSONL)

## Deferred topics
- multi-user collaboration
- rich approval / compensation / resource graph
- scheduling optimization
- persistent homology as stable API
- temporal topology as stable API
- SaaS deployment model
