# 手動受け入れ確認

English: [manual-acceptance.en.md](manual-acceptance.en.md)

このガイドは、現在の `v0.1` 参照実装に対する人手の end-to-end 確認です。決定論的 core、markdown sync、patch review/apply、analysis surface を一通り通します。

所要時間の目安は 10〜15 分です。

## 前提

- Node.js 22+ (`node:sqlite` が必要)
- `@caphtech/casegraph-cli` をグローバルインストール: `npm install -g @caphtech/casegraph-cli`

```bash
export WORKSPACE="$(mktemp -d /tmp/casegraph-acceptance.XXXXXX)"
```

以下のコマンドは空の一時ディレクトリを `WORKSPACE` で指定して実行してください。repository contributor は `cg` の代わりに `pnpm run cg` を使用できます。

## 1. workspace を初期化する

```bash
cg --workspace "$WORKSPACE" init --title "Acceptance Workspace"
```

## 2. release example を作る

```bash
cg --workspace "$WORKSPACE" case new --id release-1.8.0 --title "Release 1.8.0" --description "May release"

cg --workspace "$WORKSPACE" node add --case release-1.8.0 --id goal_release_ready --kind goal --title "Release 1.8.0 ready"
cg --workspace "$WORKSPACE" node add --case release-1.8.0 --id task_run_regression --kind task --title "Run regression test" --state todo --metadata '{"estimate_minutes":45}'
cg --workspace "$WORKSPACE" node add --case release-1.8.0 --id task_update_notes --kind task --title "Update release notes" --state todo --metadata '{"estimate_minutes":15}'
cg --workspace "$WORKSPACE" node add --case release-1.8.0 --id task_submit_store --kind task --title "Submit to App Store" --state todo --metadata '{"estimate_minutes":20}'
cg --workspace "$WORKSPACE" node add --case release-1.8.0 --id task_monitor_post_release --kind task --title "Monitor post-release" --state todo --metadata '{"estimate_minutes":30}'
cg --workspace "$WORKSPACE" node add --case release-1.8.0 --id event_release_live --kind event --title "Release live" --state todo

cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e1 --type depends_on --from task_submit_store --to task_run_regression
cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e2 --type depends_on --from task_submit_store --to task_update_notes
cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e3 --type waits_for --from task_monitor_post_release --to event_release_live
cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e4 --type contributes_to --from task_run_regression --to goal_release_ready
cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e5 --type contributes_to --from task_update_notes --to goal_release_ready
cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e6 --type contributes_to --from task_submit_store --to goal_release_ready
cg --workspace "$WORKSPACE" edge add --case release-1.8.0 --id e7 --type contributes_to --from task_monitor_post_release --to goal_release_ready
```

## 3. 初期状態を確認する

```bash
cg --workspace "$WORKSPACE" frontier --case release-1.8.0
cg --workspace "$WORKSPACE" blockers --case release-1.8.0
cg --workspace "$WORKSPACE" case view --case release-1.8.0
```

期待結果:

- frontier に `task_run_regression` と `task_update_notes` が含まれる
- blockers に `task_submit_store` と `task_monitor_post_release` が含まれる
- case view が読める tree を返し、着手可能項目は `!`、共有依存の再出現は `= ... (shared)` で表現される

## 4. markdown projection を push する

```bash
cg --workspace "$WORKSPACE" sync push --sink markdown --case release-1.8.0 --apply
```

次のファイルが作られます。

```text
$WORKSPACE/.casegraph/cases/release-1.8.0/projections/markdown.md
```

## 5. markdown 上で 2 つの task を完了にする

projection file を編集して、次の 2 行をチェック済みにします。

```text
- [x] Run regression test <!-- node: task_run_regression -->
- [x] Update release notes <!-- node: task_update_notes -->
```

## 6. sync patch を pull / review / apply する

```bash
cg --workspace "$WORKSPACE" sync pull --sink markdown --case release-1.8.0 --output "$WORKSPACE/release-sync.patch.json"
cg --workspace "$WORKSPACE" patch review --file "$WORKSPACE/release-sync.patch.json"
cg --workspace "$WORKSPACE" patch apply --file "$WORKSPACE/release-sync.patch.json"
```

期待結果:

- patch review が成功する
- patch apply が成功する
- チェックした 2 つの task が `done` になる

## 7. 次の frontier を確認する

```bash
cg --workspace "$WORKSPACE" frontier --case release-1.8.0
```

期待結果:

- `task_submit_store` が着手可能になる

## 8. 残りの release gate を完了する

```bash
cg --workspace "$WORKSPACE" task done --case release-1.8.0 task_submit_store
cg --workspace "$WORKSPACE" event record --case release-1.8.0 event_release_live
cg --workspace "$WORKSPACE" frontier --case release-1.8.0
```

期待結果:

- event 記録後に `task_monitor_post_release` が着手可能になる

## 9. analysis surface を 1 つ以上実行する

```bash
cg --workspace "$WORKSPACE" analyze critical-path --case release-1.8.0 --goal goal_release_ready
cg --workspace "$WORKSPACE" analyze slack --case release-1.8.0 --goal goal_release_ready
```

期待結果:

- どちらもエラーなく structured output を返す
- 未解決 path が `task_monitor_post_release` 周辺に集約される

## 10. storage の整合性を確認する

```bash
cg --workspace "$WORKSPACE" validate storage
cg --workspace "$WORKSPACE" events verify --case release-1.8.0
cg --workspace "$WORKSPACE" cache rebuild
```

期待結果:

- storage validation が成功する
- event verification が成功する
- cache rebuild 後も論理状態が変わらない

## 合格条件

この手動確認は、次をすべて満たした時に合格とします。

- core mutation flow が通る
- markdown sync が end-to-end で通る
- sync 由来の patch に対して review/apply が通る
- その後の storage recovery/admin command も成功する
