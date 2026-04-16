# 05. CLI Specification

## 5.1 方針

CLI は「メモ入力の窓」ではなく、**ケースグラフ操作面** です。  
自然文一発ですべてを済ませる設計にはしません。

Phase 0 では、**Phase 1 の参照実装に必要な core surface だけを凍結** します。
この時点で凍結するのは、case 作成、graph 編集、state 更新、`frontier` / `blockers` / `validate`、storage recovery です。

一方で次の能力は設計上は残しますが、**CLI 名や UX はまだ凍結しません**。

- patch proposal / review / apply
- ingest / generic export
- projection sync
- worker 実行
- impact analysis

CLI の責務は以下です。

- graph を明示的に操作する
- 現在状態と blocker を説明可能に出す
- storage を検証し、復旧できる
- スクリプト可能である

---

## 5.2 コマンド名

仮コマンド名は `cg` とします。

---

## 5.3 グローバル規約

### 出力形式
- human-readable table / text が既定
- 凍結対象コマンドは `--format json` をサポートする
- `--quiet`, `--verbose` を用意する

### exit code
- `0`: success
- `2`: validation error
- `3`: not found
- `4`: conflict

adapter / patch / worker など later-phase の面では、必要に応じて追加 code を導入してよい。
ただし Phase 0 では上記 4 種だけを凍結対象とする。

### config 探索順
1. `--workspace`
2. `CASEGRAPH_WORKSPACE`
3. current directory から `.casegraph/` を探索

---

## 5.4 Workspace / Case

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
case 一覧を返す。

### `cg case show`
case の概要、counts、frontier summary を返す。

---

## 5.5 Graph 編集

### `cg node add`

```bash
cg node add --case release-1.8.0 \
  --id task_run_regression \
  --kind task \
  --title "Run regression test" \
  --state todo
```

### `cg node update`
タイトル、説明、labels、metadata などを更新する。

### `cg edge add`

```bash
cg edge add --case release-1.8.0 \
  --id edge_submit_depends_regression \
  --type depends_on \
  --from task_submit_store \
  --to task_run_regression
```

### `cg edge remove`
edge を削除する。

---

## 5.6 状態更新

### `cg task start`
task を `doing` に遷移する。

### `cg task done`
task を `done` に遷移する。

### `cg task wait`
task を `waiting` に遷移する。理由や待機 event を記録できる。

```bash
cg task wait --case move-2026-05 task_book_mover \
  --reason "見積もり返信待ち" \
  --for event_mover_quote_returned
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
evidence を追加し、必要なら `verifies` 関係を作る。

---

## 5.7 分析

### `cg frontier`
今やれる `task` / `decision` を返す。

```bash
cg frontier --case release-1.8.0
```

### `cg blockers`
blocked node と理由を返す。

### `cg validate`
case graph と current state の整合性を確認する。
Phase 0 では patch file 検証や importer 検証までは含めない。

---

## 5.8 Storage Recovery / Admin

### `cg validate storage`
workspace 構造、case metadata、event log、cache 参照の基本整合性を確認する。

### `cg cache rebuild`
event log から cache を再構築する。

```bash
cg cache rebuild
```

### `cg events verify`
event log の envelope shape と replay 前提の整合性を確認する。

### `cg events export`
対象 case の raw event stream を export する。

---

## 5.9 後続フェーズで凍結する領域

以下は v0.1 の設計には含まれるが、Phase 0 では **command name を固定しない**。

- patch proposal / patch review / patch apply
- notes からの ingest
- case snapshot や projection 向け export
- external sink への sync push / pull
- worker 実行
- impact analysis

他の spec 文書でこれらの能力に触れる場合も、**CLI 名は将来の決定事項** として扱う。

---

## 5.10 典型フロー

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

### 例: storage 検証と復旧

```bash
cg validate storage
cg events verify --case release-1.8.0
cg cache rebuild
cg case show --case release-1.8.0 --format json
```

---

## 5.11 Phase 0 で CLI に求める品質

- スクリプト可能
- 凍結対象コマンドの JSON 出力が安定
- エラー原因が明確
- workspace path / case ID mismatch が説明可能
- `blockers` が node / edge にトレースできる
