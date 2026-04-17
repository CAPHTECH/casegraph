# 08. Projections and Sync

## 8.1 前提

この章は built-in な **markdown sync** と、optional な external integration の設計を述べる。
CaseGraph の core 採用に SaaS sink は必須ではないが、markdown sync は reference integration として含める。

CaseGraph の内部 graph は、外部ツールのデータモデルより豊かです。  
そのため同期は「対等な mirror」ではなく、**内部 graph から外部表現への投影** と考えるべきです。

---

## 8.2 なぜ source of truth を外に置かないか

外部ツールを正本にすると、次の情報が失われやすくなります。

- dependency type
- waits_for event
- evidence relation
- contributes_to goal
- patch history
- derived blockers

Todoist であれ Taskwarrior であれ GitHub Issues であれ、内部 case graph 全体をそのまま持てるとは限りません。  
よって source of truth は内部に置きます。

---

## 8.3 Projection の種類

v0.1 では投影対象を次の 3 種に分けます。

### 1. Actionable projection
frontier の task / decision を外部タスクとして出す。

### 2. Waiting projection
待機中の項目を別リストやラベルで出す。

### 3. Summary projection
case の概要や notes を markdown などに出す。

---

## 8.4 デフォルト投影ルール

### Actionable projection
対象:
- `kind in {task, decision}`
- `state in {todo, doing}`
- `is_ready = true`

### Waiting projection
対象:
- `state = waiting`
- or `waits_for` edge が未充足で blocker となっているもの

### Excluded
- `goal`
- `event`
- `evidence`
- `proposed`
- `done`
- `cancelled`

---

## 8.5 Sink ごとの差

外部ツールは表現力が異なるため、sink adapter が差を吸収します。

### 例: due date
- Todoist: native due date に投影可能
- Markdown checklist: コメントに埋めるしかない
- GitHub Issues: issue metadata または body に埋める

### 例: labels
- sink が labels を持つなら直接
- 持たなければ title prefix / note へ encode

---

## 8.6 Projection mapping

内部 node と外部 item の対応を保持します。

### mapping の例

```json
{
  "sink_name": "todoist",
  "internal_node_id": "task_submit_store",
  "external_item_id": "987654321",
  "last_pushed_at": "2026-04-15T12:00:00Z",
  "last_known_external_hash": "abc123"
}
```

### 必要性
- duplicate create 防止
- reverse sync
- rename / reopen への追従

---

## 8.7 Push の基本手順

1. current state を読む
2. sink capability を確認
3. projection plan を作る
4. dry-run 可能なら preview
5. apply
6. event log と mapping を更新

---

## 8.8 Pull の基本手順

reverse sync は限定的に行います。

### 許容される例
- external item completed -> internal state change patch を提案
- external item reopened -> internal reopen patch を提案
- external note -> attachment / note 候補を提案

### 許容しない例
- external tool 側で dependency graph を勝手に上書き
- external labels から内部 edge を推定して mutate
- 外部順序を内部 hard dependency とみなす

---

## 8.9 Conflict policy

### 原則
内部 graph 優先。

### 具体
- external 側の rename は note として取り込み、内部 title を自動変更しない
- external 完了は patch 提案として扱う
- stale mapping は warning を出す
- external item deleted は自動で internal cancelled にしない

---

## 8.10 Sink adapter の responsibility

Sink adapter は次を担います。

- field mapping
- idempotency
- external API error handling
- partial failure handling
- projection plan / apply 分離

### Sink adapter が担わないもの
- internal graph validation
- patch policy decision
- blocker 計算

---

## 8.11 Todoist をどう位置づけるか

Todoist は有力な sink ではありますが、設計上は **一実装例** です。
roadmap 上の必須要件ではなく、必要な運用が出た時に選べる optional integration として扱います。

CaseGraph は public project として次を守るべきです。

- Todoist 依存の core field を作らない
- project / section / label / due を一般投影として扱う
- Todoist がない環境でも成立する
- Markdown sink や Taskwarrior sink でも同じ核で動く
