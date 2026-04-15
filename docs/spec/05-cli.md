# 05. CLI Specification

## 5.1 方針

CLI は「メモ入力の窓」ではなく、**ケースグラフ操作面** です。  
自然文一発ですべてを済ませる設計にはしません。

CLI の責務は以下です。

- graph を明示的に操作する
- 現在状態と blocker を説明可能に出す
- patch をレビューし適用する
- worker / sink / importer を呼び出す
- スクリプト可能である

---

## 5.2 コマンド名

仮コマンド名は `cg` とします。

---

## 5.3 グローバル規約

### 出力形式
- human-readable table / text が既定
- `--format json` を全コマンドで推奨
- `--quiet`, `--verbose` を用意

### exit code
- `0`: success
- `2`: validation error
- `3`: not found
- `4`: conflict
- `5`: adapter / worker error
- `10`: patch rejected

### config 探索順
1. `--workspace`
2. `CASEGRAPH_WORKSPACE`
3. current directory から `.casegraph/` を探索

---

## 5.4 初期化系

### `cg init`
workspace 初期化。

```bash
cg init --title "My Workspace"
```

### `cg case new`
新しい case を作る。

```bash
cg case new --id release-1.8.0 --title "Release 1.8.0" --description "May release"
```

### `cg case list`
case 一覧。

### `cg case show`
case の概要、counts、frontier summary を表示。

---

## 5.5 Graph 操作系

### `cg node add`

```bash
cg node add --case release-1.8.0   --id task_run_regression   --kind task   --title "Run regression test"   --state todo
```

### `cg node update`
タイトル、説明、labels、metadata などを更新。

### `cg edge add`

```bash
cg edge add --case release-1.8.0   --id edge_submit_depends_regression   --type depends_on   --from task_submit_store   --to task_run_regression
```

### `cg edge remove`
edge 削除。

### `cg graph show`
graph の要約表示。`--format mermaid` を将来入れてもよい。

---

## 5.6 状態更新系

### `cg task start`
task を `doing` に遷移。

### `cg task done`
task を `done` に遷移。

### `cg task wait`
task を `waiting` に遷移。理由や待機 event を記録可能。

```bash
cg task wait --case move-2026-05 task_book_mover   --reason "見積もり返信待ち"   --for event_mover_quote_returned
```

### `cg task resume`
task を `todo` に戻す。

### `cg task cancel`
不要化した task を `cancelled` にする。

### `cg task fail`
試行失敗を記録する。

### `cg decision decide`
decision を確定し、必要なら metadata に結果を残す。

### `cg event record`
event node を `done` にする。

### `cg evidence add`
evidence を追加し、verifies edge を張る。

---

## 5.7 分析系

### `cg frontier`
今やれる task / decision を返す。

```bash
cg frontier --case release-1.8.0
```

### `cg blockers`
blocked node と理由を返す。

### `cg impact`
ある node の変更がどこへ伝播するかを見る。

### `cg validate`
graph / storage / patch の妥当性確認。

---

## 5.8 Patch 系

### `cg plan propose`
planner を呼んで patch を生成。

```bash
cg plan propose --case move-2026-05 --input notes.md --planner local-llm
```

### `cg patch show`
patch の diff 表示。

### `cg patch apply`
patch 適用。

### `cg patch reject`
patch を却下して履歴だけ残す拡張も将来考えられる。

---

## 5.9 Import / Export

### `cg ingest`
Markdown や plain text から graph 候補を取り込む。

```bash
cg ingest --case release-1.8.0 notes.md --importer markdown
```

### `cg export`
case snapshot, events, mermaid, json などへの export。

---

## 5.10 Worker 系

### `cg run`
worker を指定して task を実行する。

```bash
cg run --case release-1.8.0 --worker codex task_update_release_notes
cg run --case move-2026-05 --worker local-llm task_summarize_required_documents
cg run --case release-1.8.0 --worker shell task_run_tests
```

### 期待される worker 出力
- execution result
- summary
- artifacts
- optional GraphPatch

---

## 5.11 Sync 系

### `cg sync push`
内部 graph から sink へ投影。

```bash
cg sync push --case release-1.8.0 --sink todoist
cg sync push --case move-2026-05 --sink markdown
```

### `cg sync pull`
外部から状態差分を取得。reverse sync は限定的でよい。

```bash
cg sync pull --case release-1.8.0 --sink taskwarrior
```

---

## 5.12 典型フロー

### 例: case 作成から frontier 確認まで

```bash
cg init --title "Ops"
cg case new --id release-1.8.0 --title "Release 1.8.0"
cg node add --case release-1.8.0 --id goal_release_ready --kind goal --title "Release 1.8.0 ready"
cg node add --case release-1.8.0 --id task_run_regression --kind task --title "Run regression test" --state todo
cg node add --case release-1.8.0 --id task_submit_store --kind task --title "Submit to App Store" --state todo
cg edge add --case release-1.8.0 --id edge_submit_depends_regression --type depends_on --from task_submit_store --to task_run_regression
cg frontier --case release-1.8.0
```

### 例: planner から patch 適用

```bash
cg plan propose --case move-2026-05 --input move-notes.md --planner local-llm > patch.json
cg patch show patch.json
cg patch apply patch.json --case move-2026-05
cg frontier --case move-2026-05
```

---

## 5.13 v0.1 で CLI に求める品質

- スクリプト可能
- 出力が安定
- dry-run がある
- JSON 出力がある
- エラー原因が明確
- path / IDs / revision mismatch が説明可能
