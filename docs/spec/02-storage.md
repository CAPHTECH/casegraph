# 02. Storage Model

## 2.1 方針

ストレージ設計は次の 2 点を同時に満たす必要があります。

1. 人間が追えること
2. 機械が高速に扱えること

この両立のため、CaseGraph は **event log を正本** とし、**SQLite を materialized cache** とします。

---

## 2.2 ディレクトリ構成

```text
.casegraph/
  workspace.yaml
  config.yaml
  cases/
    <case-id>/
      case.yaml
      events.jsonl
      attachments/
      projections/
  cache/
    state.sqlite
```

### 各ファイルの役割

#### `workspace.yaml`
workspace のメタ情報。

#### `config.yaml`
adapter / worker / sink / default format / approval policy など。

#### `case.yaml`
case の静的メタ情報。`title`, `description`, `labels`, `state` などの current snapshot を保持してもよいが、正本は event log。

#### `events.jsonl`
その case の append-only event log。current state はこれから再構築できる。

#### `attachments/`
evidence 等のローカル添付ファイル。

#### `projections/`
外部 sink との mapping や同期メタデータ。

#### `cache/state.sqlite`
再構築可能な cache。検索、frontier、projection diff 計算に利用。

---

## 2.3 Event log を正本にする理由

### 長所
- append-only で監査しやすい
- Git の差分で追いやすい
- 壊れても rebuild しやすい
- patch 適用や worker 実行履歴を時系列で残せる
- 後から reducer を変えても再評価できる

### 短所
- current state を直接読むにはコストがかかる
- 大きくなると検索が遅い
- 重複イベントやマージ競合への配慮が要る

SQLite cache はこの短所を補うために使います。

---

## 2.4 Event log の設計

`events.jsonl` の 1 行は 1 event envelope です。

### event envelope の必須項目
- `event_id`
- `spec_version`
- `case_id`
- `timestamp`
- `actor`
- `type`
- `payload`

### 推奨項目
- `causation_id`
- `correlation_id`
- `command_id`
- `source`
- `revision_hint`

### actor の例
```json
{
  "kind": "user",
  "id": "local-user",
  "display_name": "riz"
}
```

### source の例
- `cli`
- `patch`
- `worker`
- `sync`

---

## 2.5 Current state の構築

Reducer は event log を先頭から順に適用し、現在状態を作ります。

### reducer の責務
- case metadata の更新
- nodes の upsert
- edges の upsert / delete
- node state 遷移
- attachment reference の反映
- projection mapping の更新
- validation のための派生情報生成

### 重要な性質
- event の適用は deterministic
- event の順序に依存する
- unknown event type は default で error にする
- 将来拡張用に namespaced event type を許容する

---

## 2.6 SQLite cache

SQLite は正本ではなく cache です。したがって消失しても event log から rebuild できます。

### 推奨テーブル
- `cases`
- `nodes`
- `edges`
- `node_derived`
- `events`
- `projection_mappings`
- `attachments`

### `node_derived` に持つもの
- `is_ready`
- `is_blocked`
- `blocker_count`
- `waiting_event_count`
- `contributes_to_goals`
- `last_state_change_at`

### rebuild コマンド
```bash
cg cache rebuild
```

---

## 2.7 Attachments

Attachment は binary を event log に直接埋め込まない。event log には reference を書きます。

### 方式
- 既定: workspace 内に copy
- 代替: absolute path reference
- 代替: URL reference

### event log に記録する情報
- `attachment_id`
- `storage_mode`
- `path_or_url`
- `sha256` (可能なら)
- `mime_type`
- `size_bytes`

---

## 2.8 Projection metadata

外部 sink との mapping は case ごとに持ちます。

### 保持対象
- `sink_name`
- `internal_node_id`
- `external_item_id`
- `last_pushed_at`
- `last_pulled_at`
- `last_known_external_hash`
- `sync_policy`

### 目的
- reverse sync の判断
- diff の計算
- duplicate projection の回避

---

## 2.9 バージョニングと migration

### spec version
各 workspace / case / event / patch に spec version を含める。

### migration 原則
- event log の history は書き換えない
- reducer で旧 version を読めるようにする
- 必要なら `cg migrate` で materialized state を更新する

### public OSS としての意義
スキーマ進化を無計画にすると ecosystem が壊れるため、versioning は初期から明示します。

---

## 2.10 同時編集の扱い

v0.1 は本格的な multi-user を対象にしません。ただし将来への布石として、次を残します。

- `event_id` は globally unique
- `command_id` を付けられる
- reducer は idempotent にできる範囲で設計する
- projection mapping は source-of-truth を内部優先にする

Git でのマージ競合は、人間が解く対象として割り切ります。

---

## 2.11 破損時の復旧戦略

最低限、次をサポートします。

- `cg validate storage`
- `cg cache rebuild`
- `cg events verify`
- `cg events export`

### なぜ compact を急がないか
append-only log の価値は履歴にあります。初期段階で compact を入れると、監査性とデバッグ性を損ねやすいからです。

---

## 2.12 推奨実装

参照実装では次を推奨します。

- `events.jsonl`: UTF-8, 1 行 1 JSON
- timestamps: ISO 8601 UTC
- cache: SQLite
- attachments: ファイルシステム
- file lock: OS レベルで簡易に導入
