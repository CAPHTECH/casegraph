# 04. GraphPatch

## 4.1 目的

CaseGraph では、AI や外部ロジックが graph を **直接変更しません**。  
代わりに `GraphPatch` を生成し、人間または deterministic rule が適用します。

この設計の狙いは次です。

- 再現性
- 差分レビュー
- 監査性
- dry-run
- テスト可能性
- AI 非依存性

---

## 4.2 基本構造

`GraphPatch` は「この case に対して、どの変更をどの順で提案するか」を表す差分オブジェクトです。

### 必須フィールド
- `patch_id`
- `spec_version`
- `case_id`
- `base_revision`
- `summary`
- `operations[]`

### 推奨フィールド
- `generator`
- `notes[]`
- `risks[]`

---

## 4.3 Generator

誰がこの patch を作ったかを残します。

```json
{
  "kind": "planner",
  "name": "local-llm",
  "version": "0.1.0"
}
```

### `kind` の例
- `user`
- `planner`
- `normalizer`
- `worker`
- `sync`

---

## 4.4 Operation types

v0.1 の core operation は次です。

- `add_node`
- `update_node`
- `remove_node`
- `add_edge`
- `remove_edge`
- `change_state`
- `attach_evidence`
- `set_case_field`

### `add_node`
新しい node を追加。

### `update_node`
既存 node の一部フィールド更新。`changes` は少なくとも 1 つの定義済みフィールドを含む必要があり、`{}` や全フィールド未定義の patch は `patch_update_node_changes_empty` で reject されます。

### `remove_node`
既存 node を削除。v0.1 では論理削除でもよい。

### `add_edge`
新しい edge を追加。

### `remove_edge`
既存 edge を削除。

### `change_state`
node の明示状態遷移。`kind: "evidence"` の node は観測の証跡として terminal 扱いなので、`change_state` の対象にすると `patch_change_state_evidence` で reject されます。evidence の取り消しは `detach_evidence` 系 op で表現してください。

### `attach_evidence`
evidence node 追加 + verifies edge + attachment reference の sugar でもよい。

### `set_case_field`
case metadata の更新。

---

## 4.5 Operation list を採る理由

配列を種類別に分けるより、operation list の方がよい理由は次です。

- 順序を保持できる
- 将来 op type を増やしやすい
- apply engine が一貫する
- diff / review UI を作りやすい

---

## 4.6 例

```json
{
  "patch_id": "patch_01JABC...",
  "spec_version": "0.1-draft",
  "case_id": "release-1.8.0",
  "base_revision": 42,
  "summary": "Regression test と store submission まわりの task を追加",
  "generator": {
    "kind": "planner",
    "name": "local-llm",
    "version": "0.1.0"
  },
  "operations": [
    {
      "op": "add_node",
      "node": {
        "node_id": "task_run_regression",
        "kind": "task",
        "title": "Run regression test",
        "state": "todo",
        "acceptance": ["主要シナリオが通る"],
        "metadata": {}
      }
    },
    {
      "op": "add_node",
      "node": {
        "node_id": "task_submit_store",
        "kind": "task",
        "title": "Submit to App Store",
        "state": "todo",
        "acceptance": ["申請完了"],
        "metadata": {}
      }
    },
    {
      "op": "add_edge",
      "edge": {
        "edge_id": "edge_submit_depends_regression",
        "type": "depends_on",
        "source_id": "task_submit_store",
        "target_id": "task_run_regression"
      }
    }
  ],
  "notes": [
    "既存の release goal への contributes_to は別 patch で追加可能"
  ],
  "risks": [
    "store review の待機 event が未定義"
  ]
}
```

---

## 4.7 Apply semantics

patch apply flow は次を行います。

1. patch schema validation
2. base revision チェック
3. node / edge 参照整合性チェック
4. hard dependency cycle チェック
5. policy チェック
6. event log への append

### base revision mismatch
- 既定: reject
- オプション: `--rebase-if-safe`

v0.1 では安全側に倒して reject が基本です。

---

## 4.8 競合と安全性

GraphPatch が危険になるのは、次のときです。

- 既存 node を無断で消す
- blocker を消して不正に ready にする
- 外部 worker が effectful change を silent に紛れ込ませる
- stale な case 状態に基づいて patch を作る

### 緩和策
- base revision 必須
- patch preview
- policy による op 制限
- effectful worker には explicit approval

---

## 4.9 AI 連携での使い方

### Planner
自然文やメモから task / edge 候補 patch を作る。

### Normalizer
重複 task 統合や命名整理の patch を作る。

### Worker
実行結果を graph に反映する patch を返す。  
ただし code diff や attachment は artifact として別で返してよい。

---

## 4.10 Patch review の最小 UX

Phase 2 以降の CLI / API では、最低限次の 3 段階が必要です。

1. patch proposal を生成する
2. patch diff をレビューする
3. 受け入れた patch を apply する

### patch preview に必要な表示
- add / update / remove の要約
- cycle / invalid reference の警告
- risky op の強調

Phase 0 では、この一連の CLI 名はまだ凍結しません。

---

## 4.11 なぜ AI に直接 mutate させないか

これは設計の根本です。

直接 mutate させると、
- 変更理由が不明になる
- replay できない
- test fixture を作りにくい
- sync conflict の切り分けが難しい
- public OSS として信頼が落ちる

GraphPatch を挟むことで、AI を便利に使いながら、コアの決定論性を守れます。
