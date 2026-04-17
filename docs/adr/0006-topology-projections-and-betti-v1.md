# ADR-0006: Topology projections and Betti-v1 design

- **Status:** Accepted
- **Date:** 2026-04-17

## Context

CaseGraph にはすでに、実務上の graph-topology analysis がある。

- impact propagation
- critical path
- slack
- bottleneck ranking
- minimal unblock set

これらは reachability / path / downstream を使う決定論的なグラフ解析であり、
「代数トポロジーを使った分析」とはまだ別物である。

一方で、case graph を projection した上で Betti number や cycle witness を扱う設計は、
将来の構造診断として価値がある。
ただし v0.1/v0.2 の段階で persistent homology や高次 simplex まで広げると、
projection の意味論が先に壊れる。

## Decision

代数トポロジー拡張の v1 設計対象は、**undirected projection 上の Betti-0 / Betti-1** に限定する。

### Projection

v1 で扱う projection は次の 2 種類だけに固定する。

1. `hard_unresolved`
   - case 全体の unresolved hard graph
2. `hard_goal_scope(goal_node_id)`
   - goal に `contributes_to` で到達する unresolved node と、その hard prerequisite closure

### Node scope

projection に含める unresolved state は、現行 critical-path/slack/bottleneck と同じにする。

- `todo`
- `doing`
- `waiting`
- `failed`

### Edge scope

projection に含める edge は hard dependency だけにする。

- `depends_on`
- `waits_for`

`contributes_to`, `alternative_to`, `verifies` は projection の入力には使わない。
`contributes_to` は `hard_goal_scope` の scope 切り出しにだけ使う。

### Graph form

- projection 後の計算対象は **simple undirected graph** とする
- edge direction は Betti 計算には持ち込まない
- multi-edge は endpoint が同じなら 1 本に正規化する
- self-loop は validation issue として扱い、topology result には warning を返す

### Result shape (design-only)

experimental core 実装は次の shape を基準にする。
ただし、この ADR ではまだ public schema / stable CLI に昇格しない。

```yaml
projection: hard_unresolved | hard_goal_scope
goal_node_id: goal_release_ready | null
node_count: 6
edge_count: 5
beta_0: 1
beta_1: 0
components:
  - node_ids: [task_prepare, task_review, task_publish]
cycle_witnesses:
  - node_ids: [task_a, task_b, task_c, task_a]
warnings: []
```

### Algebraic quantities

- `beta_0`: connected component count
- `beta_1`: `|E| - |V| + beta_0`

`cycle_witnesses` は full basis を保証しない。
まずは representative cycle を返す説明用 surface とする。

## Consequences

### Positive

- 現行の graph-topology analysis と代数トポロジー拡張を混同しない
- projection semantics を先に固定できる
- event export corpus に対する評価設計を先に作れる
- Betti-0/1 なら実装が軽く、決定論性も維持しやすい

### Negative

- persistent homology や temporal topology は別 ADR が必要
- directed graph の意味論は topology result に直接残らない
- cycle witness は homology basis そのものではない

## Non-goals for this ADR

- `cg analyze topology` の CLI freeze
- public TypeScript schema の追加
- Betti-2 以上
- persistent homology
- time-varying filtration
