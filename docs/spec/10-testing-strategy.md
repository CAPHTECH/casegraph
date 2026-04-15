# 10. Testing Strategy

## 10.1 方針

CaseGraph は「便利そう」では足りません。  
local-first で event log を正本にする以上、テストで保証すべき中心は次です。

- reducer の決定論性
- graph invariant
- frontier / blockers の正しさ
- patch apply の安全性
- plugin protocol の相互運用性

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
CLI 出力や patch preview の安定性確認。

### 4. Integration tests
adapter / worker との JSON-RPC 疎通。

### 5. Property tests
graph invariant の一般性確認。

---

## 10.3 最低限の property tests

- add_node 後は一意 ID が壊れない
- dangling edge は validation error
- `depends_on` cycle は reject
- `frontier` は `blocked` な task を返さない
- reducer の replay は idempotent
- patch apply 前後で case_id が変わらない

---

## 10.4 Golden fixture の推奨対象

- simple release case
- move case
- waiting event case
- evidence required case
- projection plan to markdown
- projection plan to todoist-like sink

---

## 10.5 Protocol conformance tests

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
以下は回帰テスト必須です。

- event order differences
- stale patch rejection
- rebuild from log after cache deletion
- mixed patch / sync / worker events
- migration across spec versions

---

## 10.7 Fuzz / adversarial tests

特に patch 系は壊れやすいので、次を fuzz で見る価値があります。

- duplicate IDs
- malformed op lists
- remove_node with existing edges
- conflicting state changes
- invalid extension payloads
- huge notes / metadata

---

## 10.8 Manual acceptance scenarios

v0.1 では自動テストだけでなく、人手の acceptance scenario も必要です。

### シナリオ例
1. release case を作る
2. importer で notes から patch を作る
3. patch をレビューして apply
4. frontier を確認
5. markdown sink に push
6. task 完了を reverse sync で提案
7. evidence を添付
8. cache を削除して rebuild

この一連が破綻しないことを確認する。

---

## 10.9 成功基準

- CLI 主要コマンドの回帰が自動化されている
- plugin protocol の conformance fixture がある
- reducer が event log から再構築できる
- release case と move case の golden fixture が通る
