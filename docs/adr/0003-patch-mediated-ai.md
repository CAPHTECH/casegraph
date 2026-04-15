# ADR-0003: Patch-mediated AI integration

- **Status:** Accepted
- **Date:** 2026-04-15

## Context

AI は分解、正規化、要約、実行補助に有用だが、直接 graph を mutate させると再現性と説明責任が壊れる。

特に public OSS では「AI が勝手に変えた」を許すと、テストもレビューも成立しにくい。

## Decision

- AI / worker / sync feedback は `GraphPatch` を返す
- patch は apply 前に validation と policy check を受ける
- patch には `base_revision` と `generator` を含める

## Consequences

### Positive
- diff review が可能
- dry-run ができる
- plugin の品質差を core から隔離できる
- golden test を作りやすい

### Negative
- 直接 mutate より手間が増える
- stale patch の扱いが必要になる
- UX を雑にすると面倒なだけの仕組みに見えやすい
