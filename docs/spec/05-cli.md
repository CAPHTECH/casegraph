# 05. CLI Specification

## 5.1 方針

CLI は「メモ入力の窓」ではなく、**ケースグラフ操作面** です。  
自然文一発ですべてを済ませる設計にはしません。

Phase 0 では、**Phase 1 の参照実装に必要な core surface だけを凍結** します。
この時点で凍結するのは、case 作成と close、graph 編集、state 更新、`frontier` / `blockers` / `validate`、storage recovery です。

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

### `cg case close`
case を `closed` に遷移する。

既定では次を満たさないと close できません。

- `frontier` が空
- goal node がすべて terminal (`done` / `cancelled` / `failed`)
- validation error が 0

validation warning が残る場合は `--force` が必要です。

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
タイトル、説明、labels、metadata、`state` を更新する。`--state` を渡した場合は `node.state_changed` イベントとして記録される。他フィールドと併用した場合は state 変更と field 変更が順に 2 イベントとして append される。

### `cg edge add`

```bash
cg edge add --case release-1.8.0 \
  --id edge_submit_depends_regression \
  --type depends_on \
  --from task_submit_store \
  --to task_run_regression
```

`--from` / `--to` はそれぞれ `--source` / `--target` の alias として同じ意味で受け付ける。

### `cg edge remove`
edge を削除する。

---

## 5.6 状態更新

### `cg task start`
task を `doing` に遷移する。

### `cg task done`
task を `done` に遷移する。

注: 現行の参照実装では、この state transition surface が generic node state change を担っています。
そのため dedicated な `goal done` command はまだなく、goal node を `done` にする場合も同じ surface を使います。

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
`kind: "event"` の node を `done` にする。対象 node が存在しない場合は exit `3 (not_found)`、`kind` が `event` 以外の場合は exit `2 (validation_error)` で reject される。

### `cg evidence add`
evidence を追加し、必要なら `verifies` 関係を作る。

### v0.1 completion checklist
現行 v0.1 では次の checklist で completion を表現します。

1. 構成 task / decision / event を `done` または意図した終端状態にする
2. 必要な証跡を `cg evidence add --target <nodeId>` で添付する
3. 達成した goal を state update surface で `done` にする
4. `cg frontier --case <caseId>` で actionable が残っていないことを確認する
5. `cg validate --case <caseId>` を実行する
6. 必要なら `cg case close --case <caseId>` で lifecycle 上も閉じる
7. 必要なら `cg case show --case <caseId>` で counts と frontier summary を確認する

`cg case close` は lifecycle 上の明示操作で、node-level completion の代替ではありません。
`archive` は引き続き later-phase の管理面で追加してよいものとします。

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
`--patch-file <path>` を繰り返し指定すると、明示指定 patch file (`.json` / `.yaml` / `.yml`) も走査対象に含める。

JSON 出力には `supported`, `pending_steps`, `issues`, `targets` を含める。

```json
{
  "supported": true,
  "pending_steps": [
    {
      "step_id": "patch-spec-0.0.9-to-0.1-draft",
      "target": "patch_file",
      "from_version": "0.0.9",
      "to_version": "0.1-draft",
      "action": "rewrite_spec_version"
    }
  ],
  "targets": [
    {
      "target": "patch_file",
      "path": "legacy.patch.yaml",
      "from_version": "0.0.9",
      "to_version": "0.1-draft",
      "action": "rewrite_spec_version",
      "status": "pending",
      "changed": false
    }
  ]
}
```

### `cg migrate run`
`--dry-run` を受け付ける。
現行の既知 path は `0.0.9 -> 0.1-draft` で、workspace metadata / case metadata / explicit patch file の
version marker を正規化する。legacy event log は rewrite せず reader compatibility で扱う。
`--patch-file <path>` を繰り返し指定すると、明示指定 patch file (`.json` / `.yaml` / `.yml`) も migration 対象に含める。
未知 version が見つかった場合は `migration_unsupported_version` (exit code 2) で停止する。

JSON 出力には `dry_run`, `changed`, `applied_steps`, `cache_rebuilt`, `targets` を含める。

```json
{
  "dry_run": false,
  "changed": true,
  "cache_rebuilt": true,
  "applied_steps": [
    {
      "step_id": "workspace-spec-0.0.9-to-0.1-draft"
    },
    {
      "step_id": "case-spec-0.0.9-to-0.1-draft"
    },
    {
      "step_id": "patch-spec-0.0.9-to-0.1-draft"
    }
  ],
  "targets": [
    {
      "target": "event_log",
      "action": "reader_compatible",
      "status": "applied",
      "changed": false
    }
  ]
}
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

Phase 3 では built-in markdown sync を reference integration として含める。
より広い external sink support は optional integration track とし、core roadmap completion の必須条件には含めない。

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

Phase 5 では hardening と read-only graph inspection 向けに次の command surface を追加しています。

- `cg case view --case <caseId>`
  - `depends_on` / `waits_for` を辺として ASCII ツリーを描画する (goal を根に、入次数ゼロのノードも根として並べる)。
  - 各行は `{decorator} {node_id} [{kind}/{state}] {title}` の形。decorator は `!` actionable、`✓` done、`→` waiting、`✗` blocked、`·` neutral。
  - DAG 上で複数の親から参照される node は、最初の出現だけを full subtree として描画し、以後は `= ... (shared)` の参照行にする。サイクルは `(cycle)` を末尾に付ける。
  - `--format json` では `{ tree_lines, nodes, edges, derived, validation, revision }` 形式の JSON を返す。
- `cg migrate check`
  - `.casegraph/workspace.yaml`, 各 `case.yaml`, 各 `events.jsonl` の `spec_version` を走査し、`supported` / `issues` / `pending_steps` を返す。
  - `0.1-draft` の現行 workspace では `pending_steps = []` を返す。
- `cg migrate run [--dry-run]`
  - 既知 path `0.0.9 -> 0.1-draft` を実行し、workspace metadata / case metadata / explicit patch file の
    version marker を正規化する。
  - legacy event log は rewrite せず reader compatibility で扱う。
  - `changed`, `applied_steps`, `cache_rebuilt`, `targets` を返す。
  - unsupported version がある workspace では structured issue を添えて停止する。

広い TUI / graph view はこの時点では **exploratory** とし、full spec は凍結しない。
guardrail は次の通り。

- source of truth は event log + replayed state のままにする
- read-only inspection を優先し、state mutation surface を追加しない
- stable な protocol / schema / export surface は約束しない
- 現行の public working surface は `cg case view` までに留める

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

この structural surface は 1 つの normalized substrate を共有します。

- `--goal` なしは `hard_unresolved`: unresolved node (`todo` / `doing` / `waiting` / `failed`) と、その間の hard edge (`depends_on`, `waits_for`) を使う
- `--goal <goalNodeId>` ありは `hard_goal_scope(goal_node_id)`: `contributes_to` で goal に届く unresolved contributor から始め、unresolved hard prerequisite closure を含める。goal node 自体や resolved node は含めない
- normalized graph は simple undirected とし、edge direction は落とし、同じ endpoint pair の multi-edge は 1 本に正規化し、self-loop は warning `self_loop_ignored` を返して無視する
- scope が空なら error にせず、空の result と warning `scope_has_no_unresolved_nodes` を返す

この surface は `packages/kernel` の topology projection / component traversal を共通 substrate とし、
`packages/core` はその上に raw topology の experimental surface を載せる wrapper として使うが、
`cg analyze topology` のような raw mechanism 名は stable CLI としては出さない。
raw topology (`beta_0`, `beta_1`, component witness) は `@caphtech/casegraph-core/experimental` へ隔離し、
user-facing CLI は `cycles`, `components`, `bridges`, `cutpoints`, `fragility` を保つ。

#### Structural risk explanation contract

Phase 6 の structural surface は、raw topology をそのまま公開するのではなく、
作業構造の risk explanation に変換して返します。説明語彙は次に固定します。

| topology evidence | user-facing meaning |
| --- | --- |
| `beta_0` / `components` | unresolved hard graph の disconnected work region。互いに hard dependency でつながっていない未解決作業群を示す |
| `beta_1` / cycle witnesses | dependency loop または mutual blocking structure。代表 witness は loop を説明するための証跡であり、完全な homology basis は保証しない |
| `bridges` | single dependency edge。その依存が欠けると unresolved work region が分断される |
| `cutpoints` | single task / event node。その node が欠けると unresolved work region が分断される |
| `fragility` | prioritized intervention candidates。bridge / cutpoint / downstream signal を evidence tag / metric として統合し、先に人間が確認または分解すべき node を順位付けする |

`--format json` の evidence contract は次に限定します。

- 全 surface は projection metadata として `case_id`, `revision`, `projection`, `goal_node_id`, `warnings` を返す
- `projection` は `hard_unresolved` または `hard_goal_scope` のみ。`hard_unresolved` では `goal_node_id = null`、`hard_goal_scope` では要求された goal id を返す
- `components` は raw count として `component_count` と `components[]` を返し、各 component は `node_ids`, `node_count`, `edge_count` を含む
- `cycles` は raw count として `cycle_count` と `cycles[]` を返し、各 cycle witness は `node_ids` と `edge_pairs[] { source_id, target_id }` を含む
- `bridges` は raw count として `bridge_count` と `bridges[]` を返し、各 bridge は `source_id`, `target_id`, `left_node_ids`, `right_node_ids` を含む
- `cutpoints` は raw count として `cutpoint_count` と `cutpoints[]` を返し、各 cutpoint は `node_id`, `separated_component_count`, `separated_component_node_sets` を含む
- `fragility` は `nodes[]` を返し、各 node は `node_id`, `kind`, `state`, `title`, `fragility_score`, `incident_bridge_count`, `cutpoint_component_count`, `downstream_count`, `goal_context_count`, `max_distance`, `reason_tags` を metric / evidence tag として含む

warning propagation は次に固定します。

- projection / normalization 由来の warning は derived surface (`cycles`, `components`, `bridges`, `cutpoints`, `fragility`) の `warnings` にそのまま伝播する
- raw cycle witness が `beta_1` より少ない場合、`cycles` は `cycle_witnesses_incomplete` を伝播する
- `fragility` は bridge / cutpoint / bottleneck 由来の warning を union し、cycle のため bottleneck signal を得られない場合は `bottleneck_signal_unavailable_due_to_cycles` を返す
- `scope_has_no_unresolved_nodes` は error ではなく、空 result と warning として返す
- warning は explanation の caveat であり、GraphPatch risk、validation error、または event-log mutation ではない

この contract は read-only inspection 専用で、output は read-only projection です。

- event log + replayed state が唯一の source of truth であり、analysis 実行は event を追記しない
- 結果は作業判断の evidence であり、node / edge / state / projection mapping を変更しない
- 外部 service や markdown projection に新しい source of truth を作らない

明示的な非対象は次の通りです。

- `hard_unresolved` / `hard_goal_scope(goal_node_id)` 以外の新しい projection semantics
- temporal topology または time-varying filtration
- higher-order topology、simplicial complex、Betti-2+
- `cg analyze topology`、raw `beta_0` / `beta_1`、または component witness を stable CLI として凍結すること
- graph-reading / analysis surface の broad UX redesign
- analysis result から graph mutation、projection sink 更新、または source-of-truth 変更を行うこと

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
