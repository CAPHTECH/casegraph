# Example: Release Case

この例は、モバイルアプリのリリース運営を CaseGraph でどう表現するかを示します。
Phase 0 では narrative example であると同時に、**acceptance fixture** として扱います。

## ケース

- `case_id`: `release-1.8.0`
- `title`: `Release 1.8.0`

## Canonical Initial Graph

初期 fixture では次を graph に含めます。

- `goal_release_ready`
- `task_run_regression` (`state=todo`)
- `task_update_notes` (`state=todo`)
- `task_submit_store` (`state=todo`)
- `task_monitor_post_release` (`state=todo`)
- `event_release_live` (`state=todo`)

次の識別子は後続フローで利用してよい参照 ID ですが、初期 acceptance では必須にしません。

- `event_store_review_approved`
- `evidence_submission_screenshot`
- `evidence_release_notes_link`

## Goals

- `goal_release_ready`: Release 1.8.0 ready

## Tasks

- `task_run_regression`: 回帰テスト実行
- `task_update_notes`: リリースノート更新
- `task_submit_store`: ストア申請
- `task_monitor_post_release`: リリース後監視

## Events

- `event_store_review_approved`: ストア審査通過
- `event_release_live`: 公開反映

## Evidence

- `evidence_submission_screenshot`
- `evidence_release_notes_link`

## Edges

```text
task_submit_store depends_on task_run_regression
task_submit_store depends_on task_update_notes
task_monitor_post_release waits_for event_release_live
evidence_submission_screenshot verifies task_submit_store
evidence_release_notes_link verifies task_update_notes

task_run_regression contributes_to goal_release_ready
task_update_notes contributes_to goal_release_ready
task_submit_store contributes_to goal_release_ready
task_monitor_post_release contributes_to goal_release_ready
```

## 運用のポイント

### 1. frontier
初期 frontier は通常、`task_run_regression` と `task_update_notes` になる。  
`task_submit_store` は blocker を持つため出ない。

### 2. 待機
`task_monitor_post_release` は `event_release_live` 待ち。  
event が発生するまで ready ではない。

### 3. 証跡
ストア申請後、スクリーンショットや submission URL を evidence として添付できる。

### 4. projection
- Todoist には ready な tasks のみ出す
- Markdown summary には goals / waiting events も出す

## Normative Acceptance

frontier は **集合として評価** します。
priority metadata を明示しない限り、出力順は acceptance 条件に含めません。

### Initial frontier

初期 `frontier` は次の集合であること。

- `task_run_regression`
- `task_update_notes`

### Initial blockers

初期 `blockers` には少なくとも次が含まれること。

- `task_submit_store`: `task_run_regression` と `task_update_notes` への `depends_on` が未充足
- `task_monitor_post_release`: `event_release_live` への `waits_for` が未充足

### Transition scenario

次の 2 つの遷移が成立すること。

1. `task_run_regression` と `task_update_notes` を `done` にした後、`task_submit_store` が frontier に入る
2. `event_release_live` を記録した後、`task_monitor_post_release` が frontier に入る

## 例示コマンド

```bash
cg case new --id release-1.8.0 --title "Release 1.8.0"
cg node add --case release-1.8.0 --id goal_release_ready --kind goal --title "Release 1.8.0 ready"
cg node add --case release-1.8.0 --id task_run_regression --kind task --title "Run regression test" --state todo
cg node add --case release-1.8.0 --id task_update_notes --kind task --title "Update release notes" --state todo
cg node add --case release-1.8.0 --id task_submit_store --kind task --title "Submit to App Store" --state todo
cg node add --case release-1.8.0 --id task_monitor_post_release --kind task --title "Monitor post-release" --state todo
cg node add --case release-1.8.0 --id event_release_live --kind event --title "Release live" --state todo
cg edge add --case release-1.8.0 --id e1 --type depends_on --from task_submit_store --to task_run_regression
cg edge add --case release-1.8.0 --id e2 --type depends_on --from task_submit_store --to task_update_notes
cg edge add --case release-1.8.0 --id e3 --type waits_for --from task_monitor_post_release --to event_release_live
cg frontier --case release-1.8.0
cg task done --case release-1.8.0 task_run_regression
cg task done --case release-1.8.0 task_update_notes
cg event record --case release-1.8.0 event_release_live
```
