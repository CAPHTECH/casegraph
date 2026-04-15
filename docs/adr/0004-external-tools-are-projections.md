# ADR-0004: External tools are projections

- **Status:** Accepted
- **Date:** 2026-04-15

## Context

Todoist や Taskwarrior は便利だが、CaseGraph の内部モデルより表現力が低い。  
依存、待機、証跡、寄与関係、patch history まで同じ粒度で保持できない。

外部ツールを正本にすると、内部モデルがそれに引きずられて貧弱になる。

## Decision

- 外部ツールは projection sink または importer とみなす
- source of truth は内部 graph とする
- reverse sync は限定的な patch 提案として扱う

## Consequences

### Positive
- Todoist 非依存になる
- sink を複数実装しやすい
- 外部ツールの accidental change で中核が壊れにくい

### Negative
- full bidirectional sync は難しくなる
- external-first を期待するユーザーには直感的でない場合がある
