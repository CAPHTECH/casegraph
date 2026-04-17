# 03. State and Frontier

## 3.1 なぜ state と frontier を分けるか

複雑な仕事では、「この node の状態」と「今やれるかどうか」は一致しません。

たとえば task が `todo` でも、

- 依存が終わっていない
- 必要な event が来ていない
- 明示的に待機にした
- 代替案の選択がまだ確定していない

なら、今やるべきではありません。

そのため CaseGraph は、**明示状態** と **導出状態** を分けます。

---

## 3.2 明示状態

共通 enum は以下です。

- `proposed`
- `todo`
- `doing`
- `waiting`
- `done`
- `cancelled`
- `failed`

### 状態の意味

#### `proposed`
候補として存在するが、まだ本採用していない。

#### `todo`
採用済みで、着手前または通常待ち。

#### `doing`
実行中。

#### `waiting`
外的要因のため、表の実行キューから外す。  
`waits_for` による自動 block と違い、**明示的な hold** でもある。

#### `done`
完了。

#### `cancelled`
不要になった。失敗ではなく、文脈上取りやめ。

#### `failed`
試行したが成立しなかった。再試行や代替案への移行の起点になる。

---

## 3.3 導出状態

明示状態から別に、reducer は以下を導出します。

- `is_ready`
- `is_blocked`
- `blockers[]`
- `waiting_for[]`
- `dependency_satisfied_ratio`
- `has_unverified_completion`

### `is_ready`
その node を今取りかかる候補として出してよい。

### `is_blocked`
hard dependency または pending event により進行不能。

### `blockers[]`
block の理由。UI / CLI で説明可能な文字列や参照 ID を返す。

### `has_unverified_completion`
`state=done` だが必要な evidence が未添付、または検証未了。v0.1 では warning 扱いでよい。

---

## 3.4 Hard dependency の定義

以下を hard dependency とみなします。

- `depends_on`
- `waits_for` (target event が未完了の間)

`contributes_to` と `alternative_to` は hard dependency ではありません。

---

## 3.5 Actionable の定義

v0.1 で frontier に載る候補は以下です。

- `kind in {task, decision}`
- `state in {todo, doing}`
- `is_blocked = false`

### frontier から除外されるもの
- `goal`
- `event`
- `evidence`
- `state in {proposed, waiting, done, cancelled, failed}`

### 補足
`event` と `evidence` は CLI から操作できますが、通常の実行キューには載せません。

---

## 3.6 Frontier 算出規則

擬似コード:

```text
frontier(case):
  result = []
  for each node in case.nodes:
    if node.kind not in {task, decision}:
      continue
    if node.state not in {todo, doing}:
      continue
    if has_unsatisfied_depends_on(node):
      continue
    if has_pending_waits_for(node):
      continue
    result.append(node)
  return prioritize(result)
```

### `prioritize()` の v0.1 方針
v0.1 では単純でよい。

優先順位の候補:
1. 明示 priority metadata
2. due date metadata
3. created_at
4. stable node_id

priority 自体は core field ではなく metadata 扱いでよい。

---

## 3.7 Blocker の表現

`cg blockers` は「blocked です」で終わってはいけません。なぜ blocked かが必要です。

### blocker reason の例
- `depends_on:node_x is not done`
- `waits_for:event_y is not done`
- `node state is waiting`
- `dependency cycle detected`

v0.1 では少なくとも、**blocker が node / edge にトレースできること** を保証します。

---

## 3.8 Cycle detection

### 対象
- `depends_on`
- `waits_for` を含む hard dependency graph

### 方針
- self-loop は禁止
- 強連結成分が 2 以上なら validation error
- cycle があれば `frontier` は安全側に倒してその部分を ready にしない

---

## 3.9 Goal の扱い

goal は v0.1 では primary actionable ではありません。ただし次の役割を持ちます。

- case を意味的に整理する
- task / decision / event を束ねる
- projection や graph 表示の anchor になる

### 完了判定
goal の自動完了は v0.1 では強制しません。  
理由は、`contributes_to` が「必須構成要素」ではなく「寄与」を表すためです。

---

## 3.10 代替案の扱い

`alternative_to` は readiness に直接効かせません。  
代替案が readiness を変えるには、次のいずれかが必要です。

- decision node が確定し、他候補を `cancelled` にする
- user が明示的に不要候補を `cancelled` にする
- future version で choice group 機能を入れる

---

## 3.11 Evidence と完了

`verifies` は `evidence -> target` です。v0.1 では次の方針を推奨します。

- target を `done` にするのは明示操作
- evidence が付けば completion の信頼度が上がる
- evidence 必須かどうかは target.metadata で表す

### 派生フラグの例
- `requires_evidence = true`
- `has_required_evidence = false`

---

## 3.12 Impact analysis

impact analysis は later-phase の分析能力で、次の問いに答える機能です。

- この node が失敗 / 変更されたら、どこが影響を受けるか
- どの ready node が無効化されるか
- どの goal への寄与が崩れるか

### v0.1 の基本ルール
- 逆向きの `depends_on` / `waits_for` を辿る
- 必要なら `contributes_to` を補助的に表示する
- 影響は「hard impact」と「context impact」を分けて返す
- `frontier` に載っている node のうち、hard impact に含まれるものは `frontier_invalidations` として返す

### 現行参照実装の計算
- `hard impact`: source node から逆向き hard dependency を辿って到達できる node
- `context impact`: `{source} ∪ hard impact` から `contributes_to` を辿って到達できる node
- trace は shortest path を返し、`via_node_ids` / `via_edge_ids` で説明可能にする

Phase 0 では、この能力の CLI 名は凍結しません。

---

## 3.13 Critical path analysis

critical path analysis は later-phase の分析能力で、次の問いに答える機能です。

- この case で未解決 hard dependency の最長鎖はどれか
- 特定 goal を達成するための支配的な prerequisite 鎖はどれか
- 見積りが揃っているとき、総所要時間が最も長い経路はどれか

### 現行参照実装の計算
- 対象 graph は unresolved node のみで作る
- unresolved とみなす state は `todo`, `doing`, `waiting`, `failed`
- `depends_on` / `waits_for` は prerequisite 順に正規化して longest path を計算する
- `--goal` 指定時は、goal に `contributes_to` でぶら下がる node と、その hard prerequisite closure を対象にする
- `depth_path` は hop 数最大の path
- `duration_path` は `metadata.estimate_minutes` が揃った path のみを対象にし、総見積り時間最大の path
- `event` は zero-duration milestone として扱う
- scope 内に hard cycle がある場合は safety 側に倒して失敗にする

### `estimate_minutes`
- task / decision / goal など任意 node の metadata に置ける
- 現行参照実装では non-event node について `integer >= 0` のみ有効
- 無効値は validation warning (`invalid_estimate_minutes`) を返す

---

## 3.14 Slack analysis

slack analysis は later-phase の分析能力で、次の問いに答える機能です。

- どの node が critical path 上にあるか
- どの node にどれだけ余裕があるか
- goal scope の projected duration は何分か

### 現行参照実装の計算
- scope は critical path analysis と同じ unresolved hard graph を使う
- non-event node に有効な `estimate_minutes` が揃っている場合のみ forward / backward pass を行う
- node ごとに `earliest_*`, `latest_*`, `slack_minutes`, `is_critical` を返す
- event は zero-duration milestone として扱う
- 見積り欠損がある場合は `missing_estimates_present` と `slack_unavailable_due_to_missing_estimates` を返す

---

## 3.15 Bottleneck analysis

bottleneck analysis は later-phase の分析能力で、次の問いに答える機能です。

- 今止まると downstream に何件波及するか
- ready node の無効化候補をどれだけ抱えているか
- 特定 goal 文脈で支配的な prerequisite はどれか

### 現行参照実装の計算
- scope は critical path analysis と同じ unresolved hard graph を使う
- 各 node について hard dependency の downstream 到達集合を計算する
- `frontier_invalidation_count` は downstream と current frontier の共通部分を返す
- `goal_context_count` は `{node} ∪ downstream` から `contributes_to` を辿って到達する goal 文脈数を返す
- rank は `frontier_invalidation_count desc`, `downstream_count desc`, `goal_context_count desc`, `max_distance desc`, `node_id asc`

---

## 3.16 Minimal unblock set

minimal unblock set analysis は later-phase の分析能力で、次の問いに答える機能です。

- この blocked node を ready にするには、何を最小限動かせばよいか
- 再帰的な prerequisite chain の末端にある actionable leaf はどれか
- event 待ちや explicit waiting がどこに残っているか

### 現行参照実装の計算
- target node から `depends_on` / `waits_for` を再帰的に辿る
- ready な未完了 prerequisite は `actionable_leaf` として返す
- pending event は `wait_leaf` として返す
- それ以上掘れない waiting / failed / non-ready node は `state_leaf` として返す
- blocker ごとに leaf から target までの `via_node_ids` / `via_edge_ids` を返す
- target がすでに ready なら `target_already_ready` を返す

---

## 3.17 Topology projections (deferred design)

現在の `impact` / `critical-path` / `slack` / `bottlenecks` / `unblock` は、
依存グラフに対する実務分析であり、まだ代数トポロジー API ではありません。

将来の topology 拡張では、まず次の projection 名だけを使います。

### `hard_unresolved`

- 対象 node: `todo`, `doing`, `waiting`, `failed`
- 対象 edge: `depends_on`, `waits_for`
- direction を持つ hard dependency graph から、位相計算用には undirected graph を作る

### `hard_goal_scope(goal_node_id)`

- goal に `contributes_to` で到達する unresolved node を集める
- そこから hard prerequisite closure を足す
- 位相計算に渡す graph 自体は `hard_unresolved` と同じ規則で undirected 化する

この projection は Betti number や cycle witness を計算するための設計用語であり、
参照実装には experimental core API があるが、現行の stable schema / CLI にはまだ入れない。

---

## 3.18 代表コマンド

```bash
cg frontier --case release-1.8.0
cg blockers --case move-2026-05
cg analyze impact --case release-1.8.0 --node task_run_regression
cg analyze critical-path --case release-1.8.0 --goal goal_release_ready
cg analyze slack --case release-1.8.0 --goal goal_release_ready
cg analyze bottlenecks --case release-1.8.0 --goal goal_release_ready
cg analyze unblock --case release-1.8.0 --node task_submit_store
```

---

## 3.19 明示的な再開

`waiting` は明示的な hold なので、待機 event が完了しても自動的に `todo` へ戻すとは限りません。  
v0.1 では、再開はユーザーまたは patch / automation が行います。

推奨コマンド:

```bash
cg task resume --case move-2026-05 task_book_mover
```

---

## 3.20 v0.1 でやりすぎないこと

- 自動スケジューリング最適化
- 確率的な risk ranking
- choice / compensation / approval の複雑な推論
- persistent homology や temporal topology の stable 化
- goal 自動完了の強い論理

CaseGraph の核は、まず **ready / blocked / why** を正確に出すことです。
