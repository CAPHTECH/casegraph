# 01. Domain Model

## 1.1 モデルの方針

v0.1 の domain model は、過剰に広くしません。  
理由は、複雑な仕事を扱うからといって、最初からすべてを第一級にすると、公開 project としては学習コストも実装コストも上がりすぎるからです。

そのため v0.1 では、

- 少数の node type
- 少数の edge type
- 共通フィールド + 拡張フィールド

で構成します。

---

## 1.2 Workspace

Workspace はローカルな作業単位です。通常は 1 ディレクトリ 1 workspace です。

### 必須属性
- `workspace_id`
- `title`
- `spec_version`
- `created_at`
- `updated_at`

### 役割
- 複数 case の束ね
- adapter / worker / sink の設定共有
- cache の保存先

---

## 1.3 Case

Case は一件の案件・テーマ・ライフイベントです。case は graph の単位でもあり、event log の単位でもあります。

### 必須属性
- `case_id`
- `title`
- `description`
- `state`: `open | closed | archived`
- `created_at`
- `updated_at`

### 任意属性
- `labels: string[]`
- `metadata: object`
- `extensions: object`

### 例
- `release-1.8.0`
- `move-2026-05`
- `client-acme-april-consulting`

### `case.state` と完了の関係
- `open`: 通常の作業中。v0.1 の参照実装では、完了済み case もこの state のまま保持してよい
- `closed`: completion review 後に `cg case close` で active queue から外した状態
- `archived`: 履歴保存中心の読み取り状態。これも later-phase / admin surface で使う予約状態

現行の完了表現の本体は、goal / task / decision / event の state、evidence、frontier、validate 結果です。
`cg case close` はその上に乗る lifecycle 操作で、node-level completion を置き換えるものではありません。
`cg case archive` はまだ later-phase / admin surface に留めます。

---

## 1.4 Node

Node は case を構成する要素です。v0.1 では次の 5 種のみを core に含めます。

- `goal`
- `task`
- `decision`
- `event`
- `evidence`

### 共通属性

| field | description |
|---|---|
| `node_id` | case 内で一意な ID |
| `kind` | node type |
| `title` | 短い名前 |
| `description` | 詳細説明 |
| `state` | 明示状態 |
| `labels` | 任意の分類ラベル |
| `acceptance` | 完了条件の文章リスト |
| `metadata` | 汎用メタデータ |
| `extensions` | 名前空間付き拡張領域 |
| `created_at` | 作成時刻 |
| `updated_at` | 更新時刻 |

### ID 仕様
ID は opaque string とし、次を推奨します。

- CLI 既定値: ULID
- 許容文字: `A-Za-z0-9._:-`
- 長さ: 3〜64

ID を意味に寄せすぎると変更耐性が落ちるため、意味的タイトルとは分離します。

---

## 1.5 Node kind の意味

### goal
達成したい状態。goal はそのまま実行単位ではないことが多い。

**例**
- 新リリースを安全に出す
- 引っ越しを完了する

### task
実行可能または実行準備可能な作業。

**例**
- リリースノートを書く
- 電力会社へ停止連絡する

### decision
選択や確定が必要な論点。task と違い、「どれを選ぶか」が本体。

**例**
- 宿を候補 A/B/C から選ぶ
- 認証方式を確定する

### event
外部から発生するか、記録対象となる出来事。event は待機の対象になる。

**例**
- 先方返信
- 荷物到着
- 審査完了

### evidence
完了や進行を裏づける証跡。

**例**
- 受付番号
- PR URL
- 契約書 PDF
- スクリーンショット

---

## 1.6 明示状態

共通 enum は以下です。

- `proposed`
- `todo`
- `doing`
- `waiting`
- `done`
- `cancelled`
- `failed`

### 注意
すべての state がすべての node kind に完全に対称ではありません。  
ただし v0.1 では実装と操作を単純に保つため、共通 enum とし、意味解釈を kind ごとに寄せます。

**例**
- `event.done` = その event が発生した / 記録された
- `evidence.done` = 証跡が添付され受理された
- `decision.done` = 選択が確定した

---

## 1.7 Edge

Edge は node 間の関係です。v0.1 core では次の 5 種を採用します。

- `depends_on`
- `waits_for`
- `alternative_to`
- `verifies`
- `contributes_to`

### 共通属性

| field | description |
|---|---|
| `edge_id` | edge ID |
| `type` | edge type |
| `source_id` | source node |
| `target_id` | target node |
| `metadata` | 任意メタデータ |
| `extensions` | 拡張領域 |
| `created_at` | 作成時刻 |

---

## 1.8 Edge semantics

### `depends_on`
**source** は **target** が満たされるまで進めない。

例:
- `task:submit-store-build depends_on task:finish-regression-test`

### `waits_for`
**source** は **target(event)** の発生待ち。

例:
- `task:book-flight waits_for event:passport-renewed`

### `alternative_to`
source と target は代替候補。この edge 自体は readiness を変えない。選択やキャンセルは decision または user action が担う。

### `verifies`
**source(evidence)** が **target(node)** の完了や達成を裏づける。

例:
- `evidence:receipt verifies task:pay-deposit`

### `contributes_to`
source が target の達成に寄与する。hard dependency ではなく、構造的な寄与関係。

例:
- `task:update-changelog contributes_to goal:release-1.8.0-ready`

---

## 1.9 なぜ `contributes_to` を入れるのか

`goal` を持つなら、task / decision / event と goal をつなぐ関係が必要です。これを入れないと、goal が graph 内で孤立しやすくなります。

一方で `depends_on` を代用すると、「達成への寄与」と「実行上の前提」が混ざります。この混同は再計画時に破綻しやすいので、v0.1 から分離します。

---

## 1.10 拡張として扱うもの

次は重要ですが、v0.1 では core から外します。

- actor
- resource
- location
- approval
- compensation
- recurrence
- batching

これらは `metadata` / `extensions` に保持可能とします。v0.2 以降で第一級化を検討します。

---

## 1.11 Invariants

Reducer と validator は最低限、次を保証します。

1. `node_id` は case 内で一意
2. `edge_id` は case 内で一意
3. `source_id`, `target_id` は既存 node を指す
4. `waits_for.target` は `event` であることが望ましい
5. `verifies.source` は `evidence` であることが望ましい
6. `depends_on` に自己ループは禁止
7. hard dependency の循環は validation error
8. `cancelled` / `done` への遷移は event log に残る
9. `extensions` は namespace で衝突回避する

---

## 1.12 行動可能性

CaseGraph はすべての node を同列に扱いません。

### v0.1 で actionable とみなす kind
- `task`
- `decision`

### reference / support とみなす kind
- `goal`
- `event`
- `evidence`

ただし CLI は event 記録や evidence 添付を操作できます。「frontier に出すか」と「CLI で更新可能か」は別です。
