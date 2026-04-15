# 06. Adapter Protocol

## 6.1 目的

CaseGraph は public OSS として、特定サービスに閉じない構造を持つ必要があります。  
そのため adapter は out-of-process で接続し、標準化されたプロトコルでやり取りします。

v0.1 では **JSON-RPC 2.0 over stdio** を採用します。

---

## 6.2 Adapter の種類

### Importer
外部データから graph 候補を取り込む。

例:
- Markdown
- plain text inbox
- issue list
- meeting note

### Sink
内部 graph を外部表現へ投影する。

例:
- Todoist
- Taskwarrior
- Markdown checklist
- GitHub Issues

### Notifier
通知を送る。

例:
- desktop notification
- webhook
- mail

---

## 6.3 なぜ JSON-RPC over stdio か

- 言語非依存
- CLI と相性が良い
- プロセス分離で失敗境界が明確
- plugin を配布しやすい
- 将来 MCP / editor integration へ橋渡ししやすい

---

## 6.4 基本 handshake

### initialize request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocol_version": "0.1",
    "role": "sink"
  }
}
```

### initialize response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "name": "todoist",
    "version": "0.1.0",
    "capabilities": {
      "push": true,
      "pull": true,
      "dry_run": true
    }
  }
}
```

---

## 6.5 共通メソッド

### `initialize`
handshake。

### `health.check`
疎通確認。

### `capabilities.list`
動作可能なメソッドや制限を返す。

### `shutdown`
終了。

---

## 6.6 Importer protocol

### `importer.ingest`
外部入力を受けて `GraphPatch` を返す。

#### request

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "importer.ingest",
  "params": {
    "case_id": "move-2026-05",
    "input": {
      "kind": "file",
      "path": "/tmp/move-notes.md"
    },
    "options": {
      "mode": "append"
    }
  }
}
```

#### response

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": {
    "patch": { "...": "GraphPatch" },
    "warnings": ["候補 task 名に重複の可能性あり"]
  }
}
```

---

## 6.7 Sink protocol

### `sink.planProjection`
内部 state snapshot を受け、どの external item を upsert / delete / complete すべきかの plan を返す。

### `sink.applyProjection`
projection plan を実行する。

### `sink.pullChanges`
外部側の差分を返す。v0.1 では limited reverse sync を前提にする。

---

## 6.8 Projection plan の考え方

Sink は勝手に内部 graph を変更しない。まず projection plan を返し、それを CaseGraph 側が検証する。

### plan の例
- `upsert_item`
- `complete_item`
- `archive_item`
- `set_label`
- `set_due`

これにより、外部ツール固有の表現差を adapter 内に閉じ込められます。

---

## 6.9 Pull changes の制約

reverse sync は強くしすぎない。v0.1 では次程度に限定するのが妥当です。

- external item completed -> internal node done 提案
- external item reopened -> internal node todo 提案
- note / comment -> attachment / note suggestion

### 理由
外部ツールは source of truth ではないため、構造情報まで逆流させると整合性が崩れやすいからです。

---

## 6.10 Error model

JSON-RPC error を用いる。加えて `data` に次を含めてよい。

- `retryable: boolean`
- `external_code`
- `details`
- `partial_result`

---

## 6.11 Capability declaration

Adapter は capability を宣言します。

### 例

```json
{
  "push": true,
  "pull": false,
  "supports_due_date": true,
  "supports_labels": true,
  "supports_notes": false,
  "supports_idempotency_key": true
}
```

CaseGraph はこれを見て projection policy を調整します。

---

## 6.12 Adapter trust boundary

Adapter は effectful です。したがって次の性質を前提に扱います。

- 外部 API を叩く
- secret を必要とする
- 失敗や partial apply がある
- 冪等性が不完全な場合がある

そのため `dry_run` と `apply` を分離し、event log に sync 履歴を残します。
