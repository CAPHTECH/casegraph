# 11. Schema Reference

この文書は v0.1-draft の主要構造を、実装向けにまとめた参照です。  
正式な JSON Schema ファイルを置く前段階の仕様として使います。

---

## 11.1 Workspace

```yaml
workspace_id: ws_01J...
title: My Workspace
spec_version: 0.1-draft
created_at: 2026-04-15T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
```

---

## 11.2 Case

```yaml
case_id: release-1.8.0
title: Release 1.8.0
description: May release
state: open
labels: [release, mobile]
metadata: {}
extensions: {}
created_at: 2026-04-15T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
```

---

## 11.3 Node

```yaml
node_id: task_run_regression
kind: task
title: Run regression test
description: Execute core regression scenarios
state: todo
labels: [qa]
acceptance:
  - 主要導線が通る
metadata:
  priority: high
  estimate_minutes: 45
extensions: {}
created_at: 2026-04-15T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
```

### `kind`
- goal
- task
- decision
- event
- evidence

### `state`
- proposed
- todo
- doing
- waiting
- done
- cancelled
- failed

### 代表 metadata
- `priority`: `high` / `medium` / `low` または数値
- `due_date`: ISO8601 date/time string
- `estimate_minutes`: non-event node では `integer >= 0`、event は実装上 zero-duration とみなす

---

## 11.4 Edge

```yaml
edge_id: edge_submit_depends_regression
type: depends_on
source_id: task_submit_store
target_id: task_run_regression
metadata: {}
extensions: {}
created_at: 2026-04-15T00:00:00Z
```

### `type`
- depends_on
- waits_for
- alternative_to
- verifies
- contributes_to

---

## 11.5 Event envelope

```yaml
event_id: evt_01J...
spec_version: 0.1-draft
case_id: release-1.8.0
timestamp: 2026-04-15T00:01:00Z
actor:
  kind: user
  id: local-user
  display_name: riz
type: node.added
source: cli
payload:
  node:
    node_id: task_run_regression
    kind: task
    title: Run regression test
    state: todo
```

### `type` の代表例
- case.created
- case.updated
- node.added
- node.updated
- node.state_changed
- edge.added
- edge.removed
- event.recorded
- evidence.attached
- patch.applied
- projection.pushed
- projection.pulled
- worker.dispatched
- worker.finished

---

## 11.6 GraphPatch

```yaml
patch_id: patch_01J...
spec_version: 0.1-draft
case_id: release-1.8.0
base_revision: 42
summary: Add store submission tasks
generator:
  kind: planner
  name: local-llm
  version: 0.1.0
operations:
  - op: add_node
    node:
      node_id: task_submit_store
      kind: task
      title: Submit to App Store
      state: todo
  - op: add_edge
    edge:
      edge_id: edge_submit_depends_regression
      type: depends_on
      source_id: task_submit_store
      target_id: task_run_regression
notes:
  - store review event is not yet defined
risks:
  - submission may need approval
```

---

## 11.7 Projection mapping

```yaml
sink_name: todoist
internal_node_id: task_submit_store
external_item_id: "987654321"
last_pushed_at: 2026-04-15T12:00:00Z
last_pulled_at: 2026-04-15T13:00:00Z
last_known_external_hash: abc123
sync_policy:
  allow_reverse_completion: true
```

---

## 11.8 Config

```yaml
default_format: text

approval_policy:
  shell_worker: require
  effectful_worker: require
  sink_push_first_use: require

workers:
  local-llm:
    command: ["casegraph-worker-local-llm"]
    env_allowlist: ["OLLAMA_HOST"]
  shell:
    command: ["casegraph-worker-shell"]

importers:
  markdown:
    command: ["casegraph-importer-markdown"]

sinks:
  markdown:
    command: ["casegraph-sink-markdown"]
  todoist:
    command: ["casegraph-sink-todoist"]
    env_allowlist: ["TODOIST_TOKEN"]
```

---

## 11.9 Derived state snapshot

```yaml
node_id: task_submit_store
is_ready: false
is_blocked: true
blockers:
  - kind: depends_on
    ref: task_run_regression
    message: task_run_regression is not done
waiting_for: []
dependency_satisfied_ratio: 0.0
has_unverified_completion: false
```

## 11.10 Impact analysis result

```yaml
case_id: release-1.8.0
revision:
  current: 14
  last_event_id: evt_01J...
source_node_id: task_run_regression
hard_impact:
  - node_id: task_submit_store
    kind: task
    state: todo
    title: Submit to App Store
    distance: 1
    via_node_ids: [task_run_regression, task_submit_store]
    via_edge_ids: [edge_submit_depends_regression]
context_impact:
  - node_id: goal_release_ready
    kind: goal
    state: todo
    title: Release 1.8.0 ready
    distance: 1
    via_node_ids: [task_run_regression, goal_release_ready]
    via_edge_ids: [edge_regression_goal]
frontier_invalidations: []
warnings: []
```

---

## 11.11 Critical path analysis result

```yaml
case_id: release-1.8.0
revision:
  current: 14
  last_event_id: evt_01J...
goal_node_id: goal_release_ready
depth_path:
  node_ids: [task_run_regression, task_submit_store]
  edge_ids: [edge_submit_depends_regression]
  hop_count: 1
  total_estimate_minutes: 65
  steps:
    - node_id: task_run_regression
      kind: task
      state: todo
      title: Run regression test
      estimate_minutes: 45
    - node_id: task_submit_store
      kind: task
      state: todo
      title: Submit to App Store
      estimate_minutes: 20
duration_path:
  node_ids: [task_run_regression, task_submit_store]
  edge_ids: [edge_submit_depends_regression]
  hop_count: 1
  total_estimate_minutes: 65
  steps:
    - node_id: task_run_regression
      kind: task
      state: todo
      title: Run regression test
      estimate_minutes: 45
    - node_id: task_submit_store
      kind: task
      state: todo
      title: Submit to App Store
      estimate_minutes: 20
missing_estimate_node_ids: []
warnings: []
```

---

## 11.12 Slack analysis result

```yaml
case_id: release-1.8.0
revision:
  current: 14
  last_event_id: evt_01J...
goal_node_id: goal_release_ready
projected_duration_minutes: 65
nodes:
  - node_id: task_run_regression
    kind: task
    state: todo
    title: Run regression test
    estimate_minutes: 45
    earliest_start_minutes: 0
    earliest_finish_minutes: 45
    latest_start_minutes: 0
    latest_finish_minutes: 45
    slack_minutes: 0
    is_critical: true
missing_estimate_node_ids: []
warnings: []
```

---

## 11.13 Bottleneck analysis result

```yaml
case_id: release-1.8.0
revision:
  current: 14
  last_event_id: evt_01J...
goal_node_id: goal_release_ready
nodes:
  - node_id: task_run_regression
    kind: task
    state: todo
    title: Run regression test
    downstream_node_ids: [task_submit_store]
    downstream_count: 1
    frontier_invalidation_node_ids: []
    frontier_invalidation_count: 0
    goal_context_node_ids: [goal_release_ready]
    goal_context_count: 1
    max_distance: 1
warnings: []
```

---

## 11.14 Minimal unblock set result

```yaml
case_id: release-1.8.0
revision:
  current: 14
  last_event_id: evt_01J...
target_node_id: task_submit_store
actionable_leaf_node_ids: [task_run_regression, task_update_notes]
blockers:
  - node_id: task_run_regression
    kind: actionable_leaf
    node_kind: task
    state: todo
    title: Run regression test
    distance: 1
    via_node_ids: [task_run_regression, task_submit_store]
    via_edge_ids: [edge_submit_depends_regression]
    actionable: true
warnings: []
```

---

## 11.15 Revision model

CaseGraph は patch apply の整合性のため、case revision を持つことを推奨します。

```yaml
case_revision:
  current: 42
  last_event_id: evt_01J...
```

### 原則
- event append ごとに revision を増やす
- patch は `base_revision` を持つ
- stale patch は既定で reject

---

## 11.16 Extension namespacing

拡張は namespace を切ることを推奨します。

```yaml
extensions:
  org.example.approval:
    approver: alice
    status: pending
  com.example.location:
    place_id: station-west-exit
```

理由は、OSS ecosystem で key collision を避けるためです。
