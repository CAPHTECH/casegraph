# 10. Testing Strategy

## 10.1 方針

CaseGraph は「便利そう」では足りません。  
local-first で event log を正本にする以上、テストで保証すべき中心は次です。

- reducer の決定論性
- graph invariant
- frontier / blockers の正しさ
- storage recovery の確実性

Phase 0 で acceptance 対象にするのは、**Phase 1 core CLI と example fixture** です。
Phase 2 ではこれに加えて、patch apply と markdown importer protocol の接地を追加します。
Phase 3 では built-in な markdown sync を **required reference integration** として扱い、
projection push / pull の回帰を継続対象に含めます。

---

## 10.2 テスト層

### 1. Unit tests
対象:
- domain validation
- edge semantics
- state transitions
- cycle detection
- priority sort

### 2. Reducer tests
event sequence から current state を構築できるか。

### 3. Golden tests
凍結対象 CLI 出力の安定性確認。

### 4. Recovery tests
storage validate / cache rebuild / event replay の安定性確認。

### 5. Property tests
graph invariant の一般性確認。

### 6. Later-phase integration tests
adapter / worker との JSON-RPC 疎通。
特に markdown sync は reference integration として、happy-path だけでなく
pull-before-push, stale mapping archive, unmapped line warning まで回帰対象にする。

### 7. Black-box E2E tests
repo root から build 済み CLI を子プロセスで実行し、
documented flow がそのまま通るかを見る。
`pnpm test:e2e` は `pnpm --silent run cg --workspace <temp-dir> ...` を使い、
Quickstart と Manual Acceptance の core + markdown sync flow を black-box で検証する。
既存の `runCli(...)` ベース test は in-process integration として残し、
black-box E2E は docs と実運用経路のズレ検出を主目的にする。

---

## 10.3 最低限の property tests

- add_node 後は一意 ID が壊れない
- dangling edge は validation error
- `depends_on` cycle は reject
- `frontier` は `blocked` な task を返さない
- reducer の replay は idempotent

Phase 2 では次も property / invariant 候補に含める。

- stale patch は reject
- `remove_node` は参照 edge が残ると reject
- patch replay 後も `frontier` は blocked task を返さない

Phase 5 で `fast-check` による property tests を `tests/properties.test.ts` に追加した。
リプレイの決定性、node_id 一意性 (Map の構造不変条件として)、`depends_on` cycle 検出、
`frontier` の非ブロック性、stale patch reject の 5 つを乱数生成された小さなグラフに対して検証する。

---

## 10.4 Golden fixture の推奨対象

- release case fixture
- move case fixture
- frozen core command の JSON output
- storage recovery flow

次は later-phase の golden fixture として追加する。

- waiting event case
- evidence required case
- projection plan to markdown
- markdown sync round-trip fixture

Phase 2 では次を golden / acceptance に追加する。

- `import markdown` が checklist fixture から patch を生成すること
- `patch review` が `base_revision` と warning / risk を返すこと
- `patch apply` 後に frontier / blockers が期待どおり変化すること

Phase 5-6 では analysis corpus を拡張した。
exact-match golden corpus は `impact`, `critical-path`, `slack`, `bottlenecks`, `unblock`,
`cycles`, `components`, `bridges`, `cutpoints`, `fragility` を含む。
`pnpm test:analysis-golden` は scenario ごとに次を exact-match で比較し、
`analysis_golden_metrics=...` を stdout に出力する。

- `hard_impact`
- `context_impact`
- `frontier_invalidations`
- `depth_path`
- `duration_path`
- `projected_duration_minutes`
- `slack_node_ids`
- `critical_node_ids`
- `slack_minutes_by_node`
- `bottleneck_node_ids`
- `downstream_count_by_node`
- `frontier_invalidation_count_by_node`
- `goal_context_count_by_node`
- `actionable_leaf_node_ids`
- `blocker_node_ids`
- `blocker_kinds_by_node`
- `blocker_actionable_by_node`
- `cycle_count`
- `cycle_node_sets`
- `component_count`
- `component_node_sets`
- `bridge_pairs`
- `cutpoint_ids`
- `separated_component_node_sets_by_node`
- `fragility node_ids / top_node_id`
- `missing_estimate_node_ids`
- `warnings`

この `hit_rate` は **golden corpus に対する再現率** であり、
実運用の正解率を直接表す値ではない。
実務の当たり率を見たい場合は、実データに近い fixture を継続追加し、
人手レビュー済みの expected output を増やしていく。

hard cycle を含む構造 fixture は通常の mutation path では保存できないため、
golden harness では replay-only fixture として純粋 replay 経路で評価する。

raw topology query は `pnpm test:analysis-eval` の event-export corpus に載せる。
ここでは `projection`, `beta_0`, `beta_1`, component set, warning を
partial-label / invariant で継続検証する。
raw topology API import は `@caphtech/casegraph-core/experimental` に限定し、
root public API からは見えないことも regression test に含める。

---

## 10.5 Mixed evaluation harness

Phase 6 では `pnpm test:analysis-eval` を追加し、analysis の評価を二層に分ける。

### 1. Built-in exact corpus

- 既存の `pnpm test:analysis-golden` を exact-match corpus として維持する
- `impact`, `critical-path`, `slack`, `bottlenecks`, `unblock`,
  `cycles`, `components`, `bridges`, `cutpoints`, `fragility` の expected output を固定し、
  `exact_match_hit_rate` を継続計測する

### 2. Event-export corpus

- event stream JSON (`cg events export` 相当) を replay して analysis を走らせる
- event stream JSON array と `events.jsonl` の両方を読める loader を使う
- in-tree の匿名 sample corpus と、ローカルの external corpus を同じ harness で回す
- external corpus は `CASEGRAPH_ANALYSIS_EVAL_MANIFEST=<path>` で追加ロードする
- local fixture manifest から repo 内 `.casegraph/cases/*/events.jsonl` を直接評価する回帰も持つ

manifest の最小 shape:

```yaml
corpora:
  - corpus_id: release-topology
    events_file: ./release-topology.events.json
    queries:
      - name: bottleneck rank
        kind: bottlenecks
        goal_node_id: goal_release_ready
        labels:
          must_include_node_ids: [task_prepare]
          top_k_contains: [task_prepare]
```

### 採点

- `exact_match_hit_rate`
  - built-in golden corpus 専用
- `invariant_pass_rate`
  - node / edge reference の整合性
  - determinism
  - surface ごとの不変条件
- `partial_label_hit_rate`
  - `must_include_node_ids`
  - `must_not_include_node_ids`
  - `expected_warning_ids`
  - `top_k_contains`

この harness は、実データに exact answer がなくても、壊れ方を継続監視できることを狙う。

---

## 10.6 Later-phase protocol conformance tests

public OSS として plugin ecosystem を育てるなら、conformance suite が必要です。

### adapter conformance
- initialize / health / capabilities
- sink.planProjection
- sink.applyProjection
- error shape
- dry-run support

### worker conformance
- initialize / health / capabilities
- worker.execute
- effectful capability declaration
- timeout / error reporting

Phase 5 で `tests/helpers/conformance.ts` に再利用可能な runner を追加し、
`tests/conformance.test.ts` で `importer-markdown` / `sink-markdown` / `worker-shell` の
三つの in-tree plugin に対して `initialize` → `health` → `capabilities.list` →
未知 method による JSON-RPC error → `shutdown` のハンドシェイクを検証する。
role 別の必須 method (`importer.ingest` / `sink.{planProjection,applyProjection,pullChanges}` /
`worker.execute`) が advertise されているかも同時に確認する。
このうち `sink-markdown` は required reference integration として維持し、
out-of-tree sink は optional integration として同じ runner を流用できる形に留める。
out-of-tree plugin も `runPluginConformance({ command, cwd, role })` を呼ぶだけで
最低限の適合性を確認できる。

---

## 10.7 Regression tests for reducer

Reducer は最重要コンポーネントです。  
Phase 1 core では、以下は回帰テスト必須です。

- event order differences
- rebuild from log after cache deletion
- release fixture の frontier / blockers の継続
- move fixture の frontier / blockers の継続

次は later-phase で追加する。

- mixed patch / sync / worker events
- migration across spec versions

Phase 5 hardening では migration check / run の回帰を追加した。
現行版では current workspace が no-op になること、
unsupported workspace / case / event version が structured issue とともに拒否されることを確認する。

Phase 2 では次を reducer / replay 回帰に追加する。

- stale patch rejection
- `patch.applied` replay 後の cache rebuild 一致

---

## 10.8 Fuzz / adversarial tests

特に patch 系は壊れやすいので、Phase 2 以降は次を fuzz で見る価値があります。

- duplicate IDs
- malformed op lists
- remove_node with existing edges
- conflicting state changes
- invalid extension payloads
- huge notes / metadata

---

## 10.9 Manual acceptance scenarios

Phase 0-2 では自動テストだけでなく、人手の acceptance scenario も必要です。
現在は Quickstart / Manual Acceptance の core + sync subset を
`pnpm test:e2e` で black-box 自動検証しているが、
release gate としての人手 runbook は引き続き残す。

### シナリオ例
1. release case を作る
2. 初期 `frontier` が `{task_run_regression, task_update_notes}` になることを確認する
3. release case で prerequisite task を完了し、`task_submit_store` が frontier に入ることを確認する
4. move case で `blockers` が decision / event 由来の理由を返すことを確認する
5. `cg validate storage` と `cg events verify` を実行する
6. cache を削除して `cg cache rebuild` する
7. rebuild 後に `frontier` / `blockers` の結果が維持されることを確認する
8. markdown checklist から `cg import markdown` で patch を生成する
9. `cg patch review` で stale ではないことを確認する
10. `cg patch apply` 後に revision が進み、frontier が変化することを確認する

この一連が破綻しないことを確認する。

---

## 10.10 成功基準

- 凍結対象 CLI の回帰が自動化されている
- storage recovery command の回帰が自動化されている
- reducer が event log から再構築できる
- release case と move case の golden fixture が通る
- markdown importer と patch apply の回帰が自動化されている
- markdown sync push / pull / edge-case 回帰が自動化されている
- documented CLI flow に対する black-box E2E (`pnpm test:e2e`) が通る
- analysis golden corpus の exact-match hit rate を継続計測できる
- event-export corpus に対する invariant / partial-label 評価を継続計測できる
