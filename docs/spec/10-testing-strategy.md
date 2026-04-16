# 10. Testing Strategy

## 10.1 方針

CaseGraph は「便利そう」では足りません。  
local-first で event log を正本にする以上、テストで保証すべき中心は次です。

- reducer の決定論性
- graph invariant
- frontier / blockers の正しさ
- storage recovery の確実性

Phase 0 で acceptance 対象にするのは、**Phase 1 core CLI と example fixture** です。
patch apply や plugin protocol の接地は後続フェーズで追加します。

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

---

## 10.3 最低限の property tests

- add_node 後は一意 ID が壊れない
- dangling edge は validation error
- `depends_on` cycle は reject
- `frontier` は `blocked` な task を返さない
- reducer の replay は idempotent

patch apply に対する property は、Phase 2 が入った時点で追加する。

---

## 10.4 Golden fixture の推奨対象

- release case fixture
- move case fixture
- frozen core command の JSON output
- storage recovery flow

次は later-phase の golden fixture として追加する。

- waiting event case
- evidence required case
- patch preview
- projection plan to markdown
- projection plan to todoist-like sink

---

## 10.5 Later-phase protocol conformance tests

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

---

## 10.6 Regression tests for reducer

Reducer は最重要コンポーネントです。  
Phase 1 core では、以下は回帰テスト必須です。

- event order differences
- rebuild from log after cache deletion
- release fixture の frontier / blockers の継続
- move fixture の frontier / blockers の継続

次は later-phase で追加する。

- stale patch rejection
- mixed patch / sync / worker events
- migration across spec versions

---

## 10.7 Fuzz / adversarial tests

特に patch 系は壊れやすいので、Phase 2 以降は次を fuzz で見る価値があります。

- duplicate IDs
- malformed op lists
- remove_node with existing edges
- conflicting state changes
- invalid extension payloads
- huge notes / metadata

---

## 10.8 Manual acceptance scenarios

Phase 0 では自動テストだけでなく、人手の acceptance scenario も必要です。

### シナリオ例
1. release case を作る
2. 初期 `frontier` が `{task_run_regression, task_update_notes}` になることを確認する
3. release case で prerequisite task を完了し、`task_submit_store` が frontier に入ることを確認する
4. move case で `blockers` が decision / event 由来の理由を返すことを確認する
5. `cg validate storage` と `cg events verify` を実行する
6. cache を削除して `cg cache rebuild` する
7. rebuild 後に `frontier` / `blockers` の結果が維持されることを確認する

この一連が破綻しないことを確認する。

---

## 10.9 成功基準

- 凍結対象 CLI の回帰が自動化されている
- storage recovery command の回帰が自動化されている
- reducer が event log から再構築できる
- release case と move case の golden fixture が通る
