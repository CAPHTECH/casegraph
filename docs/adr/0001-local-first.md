# ADR-0001: Local-first and deterministic core

- **Status:** Accepted
- **Date:** 2026-04-15

## Context

CaseGraph は開発タスクだけでなく一般タスクも扱う。  
そのため private なメモ、証跡、契約関連情報、個人予定に近い情報を含みうる。

また、公開 project としては特定 SaaS 依存の中心設計を避けたい。  
さらに、AI や plugin の非決定性を中核状態管理に混ぜると、監査性と再現性が損なわれる。

## Decision

- source of truth はローカルの event log とする
- core state transition, validation, frontier computation は deterministic に実装する
- AI / adapter / worker は core の外に置く

## Consequences

### Positive
- privacy と portability が高い
- Git 運用しやすい
- replay / rebuild ができる
- public OSS としてベンダー中立性が高い

### Negative
- collaborative real-time editing には向かない
- local storage と cache の責務分離が必要になる
- adapter / sync 実装は「内部正本」前提で作る必要がある
