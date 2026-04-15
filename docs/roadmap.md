# Roadmap

## Phase 0: Design freeze
- spec 0.1-draft を文章で固める
- release case / move case を examples として固定
- CLI command surface を凍結候補まで絞る

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

## Phase 3: Projection sinks
- markdown checklist sink
- Todoist sink
- Taskwarrior sink
- limited reverse sync

## Phase 4: Workers
- shell worker
- local LLM worker
- code agent worker bridge
- approval policy

## Phase 5: Hardening
- conformance suite
- property tests
- migration tool
- better error surfaces
- TUI / graph view exploration

## Deferred topics
- multi-user collaboration
- rich approval / compensation / resource graph
- scheduling optimization
- SaaS deployment model
