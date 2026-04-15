# ADR-0002: Event log + SQLite cache

- **Status:** Accepted
- **Date:** 2026-04-15

## Context

CaseGraph は履歴を重視する。  
一方で frontier 計算、検索、projection diff 計算は高速である必要がある。

正本を単純な snapshot にすると、いつ何が変わったかを追いにくい。  
event sourcing のみだと current state の参照が重い。

## Decision

- append-only event log を正本とする
- SQLite を materialized cache とする
- cache は消しても rebuild 可能とする

## Consequences

### Positive
- 監査性が高い
- reducer の回帰テストがしやすい
- 将来 reducer を改善しても履歴を再評価できる
- local CLI との相性が良い

### Negative
- 実装が少し複雑になる
- migration と rebuild の設計が必要
- event envelope の規律が重要になる
