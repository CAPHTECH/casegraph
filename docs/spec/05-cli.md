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
- critical path analysis
- slack analysis
- bottleneck analysis
- minimal unblock set analysis
- structure analysis (`cycles`, `components`, `bridges`, `cutpoints`, `fragility`)

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
patch file 検証や importer 検証は、Phase 2 では別 command として扱う。

---

## 5.8 Storage Recovery / Admin

### `cg validate storage`
workspace 構造、case metadata、event log、cache 参照の基本整合性を確認する。

### `cg cache rebuild`
event log から cache を再構築する。

```bash
cg cache rebuild
```

### `cg migrate check`
workspace / case metadata / event log の `spec_version` を走査し、現行実装と既知 migration path で扱えるかを返す。
`--patch-file <path>` を繰り返し指定すると、明示指定 patch file も走査対象に含める。

### `cg migrate run`
`--dry-run` を受け付ける。
現行の既知 path は `0.0.9 -> 0.1-draft` で、workspace metadata / case metadata / explicit patch file の
version marker を正規化する。legacy event log は rewrite せず reader compatibility で扱う。
`--patch-file <path>` を繰り返し指定すると、明示指定 patch file も migration 対象に含める。
未知 version が見つかった場合は `migration_unsupported_version` (exit code 2) で停止する。

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
- impact / critical path analysis
- slack / bottleneck / unblock analysis
- structure analysis (`cycles`, `components`, `bridges`, `cutpoints`, `fragility`)

他の spec 文書でこれらの能力に触れる場合も、**CLI 名は将来の決定事項** として扱う。

### Phase 2 参照実装の working surface

現行の参照実装では、未凍結領域に対して次の command surface を採用しています。

- `cg patch validate --file <patch.{json|yaml|yml}>`
- `cg patch review --file <patch.{json|yaml|yml}>`
- `cg patch apply --file <patch.{json|yaml|yml}>`
- `cg import markdown --case <caseId> --file <notes.md> [--output <patchPath>]`

### Phase 3 参照実装の working surface

Phase 3 では projection sink 向けに次の command surface を追加しています。

- `cg sync push --sink <name> --case <caseId> [--apply]`
  - 既定は dry-run として plan を表示のみ。`--apply` で `sink.applyProjection` を実行し `projection.pushed` event を追記する。
- `cg sync pull --sink <name> --case <caseId> --output <patchPath>`
  - 外部表現を読み取り、限定的な reverse sync として `GraphPatch` (`generator.kind = "sync"`) を書き出す。
  - `projection.pulled` audit event を直接 event log へ追記し、出力された patch は `cg patch review` / `cg patch apply` で従来の検証経路に乗せる。

### Phase 4 参照実装の working surface

Phase 4 では worker 実行向けに次の command surface を追加しています。

- `cg worker run --worker <name> --case <caseId> --node <taskNodeId> [--approve] [--output <patchPath>] [--timeout <seconds>]`
  - `--approve` は effectful worker で必須。`config.approval_policy.<worker_name>` を `auto` / `require` / `deny` で上書き可能 (既定は capability に基づく `require` / `auto`)。
  - 実行前後に `worker.dispatched` / `worker.finished` audit event を直接 event log へ追記する (どちらも graph state は変えない)。
  - `--timeout` は client 側でも enforce する。plugin が応答しない場合は `worker.finished { status: "failed" }` を追記した上で `worker_timeout` (exitCode 2) を送出する。
  - worker が `GraphPatch` を返した場合、`--output` に保存し、適用は既存の `cg patch review` / `cg patch apply` 経路で行う (ADR-0003)。
  - 組み込み worker: `shell` (Phase 4), `code-agent` / `local-llm` (v0.2 追加)。`code-agent` は外部 CLI を spawn し fenced `casegraph-patch` ブロックを抽出する; `local-llm` は Ollama 互換 HTTP に POST して同じ抽出を行う (spec §7.10a)。

### Phase 5 参照実装の working surface

Phase 5 ではグラフ探索向けに次の command surface を追加しています。

- `cg case view --case <caseId>`
  - `depends_on` / `waits_for` を辺として ASCII ツリーを描画する (goal を根に、入次数ゼロのノードも根として並べる)。
  - 各行は `{decorator} {node_id} [{kind}/{state}] {title}` の形。decorator は `✓` ready/done、`→` waiting、`✗` blocked、`·` neutral。サイクルは `(cycle)` を末尾に付ける。
  - `--format json` では `{ tree_lines, nodes, edges, derived, validation, revision }` 形式の JSON を返す。
- `cg migrate check`
  - `.casegraph/workspace.yaml`, 各 `case.yaml`, 各 `events.jsonl` の `spec_version` を走査し、`supported` / `issues` / `pending_steps` を返す。
  - `0.1-draft` の現行 workspace では `pending_steps = []` を返す。
- `cg migrate run [--dry-run]`
  - 参照実装では no-op。`changed = false`, `applied_steps = []` を返す。
  - unsupported version がある workspace では structured issue を添えて停止する。

### Phase 6 参照実装の working surface

Phase 6 では graph 構造の説明 surface として次を追加しています。

- `cg analyze slack --case <caseId> [--goal <goalNodeId>]`
- `cg analyze bottlenecks --case <caseId> [--goal <goalNodeId>]`
- `cg analyze unblock --case <caseId> --node <targetNodeId>`
- `cg analyze cycles --case <caseId> [--goal <goalNodeId>]`
- `cg analyze components --case <caseId> [--goal <goalNodeId>]`
- `cg analyze bridges --case <caseId> [--goal <goalNodeId>]`
- `cg analyze cutpoints --case <caseId> [--goal <goalNodeId>]`
- `cg analyze fragility --case <caseId> [--goal <goalNodeId>]`

この surface は `packages/core` 内部の topology projection / component traversal を使うが、
`cg analyze topology` のような raw mechanism 名は stable CLI としては出さない。
raw topology (`beta_0`, `beta_1`, component witness) は `@casegraph/core/experimental` へ隔離し、
user-facing CLI は `cycles`, `components`, `bridges`, `cutpoints`, `fragility` を保つ。

これらは **実装上の作業面** であり、Phase 0 の freeze policy は変更しません。

### Analysis 参照実装の working surface

analysis-only の working surface として次を採用しています。

- `cg analyze impact --case <caseId> --node <nodeId>`
  - source node を起点に reverse hard dependency を辿り、`hard_impact` / `context_impact` / `frontier_invalidations` を返す
  - `--format json` では trace と warnings を含む structured result を返す
- `cg analyze critical-path --case <caseId> [--goal <goalNodeId>]`
  - unresolved hard-DAG 上の `depth_path` と、見積りが揃っている場合のみ `duration_path` を返す
  - goal scope 内に hard cycle がある場合は `analysis_cycle_present` (exitCode 2) を返す
- `cg analyze slack --case <caseId> [--goal <goalNodeId>]`
  - unresolved hard-DAG 上の slack / float を返す
  - 見積り欠損がある場合は `projected_duration_minutes = null` と warning を返す
- `cg analyze bottlenecks --case <caseId> [--goal <goalNodeId>]`
  - downstream hard reachability に基づく bottleneck rank を返す
  - `frontier_invalidation_count` と `goal_context_count` を含む
- `cg analyze unblock --case <caseId> --node <nodeId>`
  - target node を ready にするための minimal leaf blocker 集合を返す
  - ready leaf / wait leaf / state leaf を区別して返す

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
