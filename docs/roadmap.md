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

## Phase 3: Markdown sync and optional integrations
- markdown checklist sync ✅ (required reference integration)
- external sink support は optional とし、Todoist / Taskwarrior は roadmap の完了条件に含めない
- reverse sync は narrow な補助機能としてのみ扱う

## Phase 4: Workers
- shell worker ✅
- local LLM worker ✅ (v0.2, Ollama 互換)
- code agent worker bridge ✅ (v0.2, claude/codex/aider CLI)
- approval policy ✅

## Phase 5: Hardening
- conformance suite ✅
- property tests ✅
- migration tool ✅ (supported legacy scan/run + explicit patch-file path)
- better error surfaces ✅ (analysis / migration structured issues)
- `cg case view` ✅ (read-only graph inspection)
- broader TUI / graph view は guardrail のみ。full spec は凍結しない

## Phase 6: Topology and evaluation
- current graph-topology docs consolidation ✅
- algebraic topology ADR for Betti-0 / Betti-1 on projections ✅
- mixed evaluation harness over golden corpus + event-export corpus ✅
- external real-data corpus loading via local manifest ✅ (JSON array + JSONL)

## Deferred topics
Deferred topics は Phase 6 の未完ではなく、開始条件が揃うまで保留する別トラックとする。
以下の項目は、開始条件が満たされるまで roadmap の完了条件に含めない。

- multi-user collaboration
  開始条件: 単一 writer 前提では扱えない merge / conflict / ownership の要件が明示され、event log と projection sync を複数 writer でどう整合させるかを設計する必要が出た時。
  非目標: server-first への全面転換や、常時接続の共同編集 UI を先に作ること。

- rich approval / compensation / resource graph
  開始条件: 現行の worker approval policy では不足し、予算・権限・補償・利用資源を graph 上で追跡しないと意思決定できないユースケースが固まった時。
  非目標: 汎用ワークフローエンジンや ERP 的な業務システムに広げること。

- scheduling optimization
  開始条件: frontier / critical-path / slack / bottlenecks だけでは不十分で、目的関数と制約条件を固定した上で自動最適化の価値が明確になった時。
  非目標: 決定論的 core を置き換えるブラックボックス最適化や、説明不能な自動計画を先に導入すること。

- persistent homology as stable API
  開始条件: filtration の定義と user-facing explanation surface が固まり、corpus/eval で継続検証できる状態になった時。
  非目標: 研究用の raw 指標を、そのまま stable CLI / public schema として公開すること。

- temporal topology as stable API
  開始条件: event-time / observation-time / windowing の意味論が固まり、時系列構造を stable contract として外に出す必要が確認できた時。
  非目標: event log の timestamp があるだけで temporal topology を定義したことにすること。

- SaaS deployment model
  開始条件: local-first 単体運用が安定し、その上で tenancy / auth / remote sync / hosted operations を別途要求された時。
  非目標: cloud service を source of truth にして local-first 原則を崩すこと。
