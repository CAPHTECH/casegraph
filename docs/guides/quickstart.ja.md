# クイックスタート

English: [quickstart.en.md](quickstart.en.md)

このガイドでは、新しい workspace を作成し、小さな case を登録し、markdown projection を push して、その変更を patch として pull するところまでを最短で確認します。

## 前提

- Node.js 24 以上を推奨
- `pnpm` 10 以上
- 書き込み可能な作業ディレクトリ

## 1. 依存を入れて build する

```bash
pnpm install
pnpm build
```

このガイドでは CLI の起動に `pnpm cg` を使います。

## 2. workspace を初期化する

```bash
pnpm cg init --title "CaseGraph Demo"
```

カレントディレクトリに `.casegraph/` が作られます。

## 3. 小さな release case を作る

```bash
pnpm cg case new --id release-demo --title "Release demo" --description "Quickstart case"

pnpm cg node add --case release-demo --id goal_release_demo --kind goal --title "Release demo ready"
pnpm cg node add --case release-demo --id task_write_notes --kind task --title "Write release notes" --state todo
pnpm cg node add --case release-demo --id task_publish --kind task --title "Publish build" --state todo

pnpm cg edge add --case release-demo --id edge_publish_depends_notes --type depends_on --from task_publish --to task_write_notes
pnpm cg edge add --case release-demo --id edge_notes_goal --type contributes_to --from task_write_notes --to goal_release_demo
pnpm cg edge add --case release-demo --id edge_publish_goal --type contributes_to --from task_publish --to goal_release_demo
```

## 4. 初期状態を見る

```bash
pnpm cg frontier --case release-demo
pnpm cg blockers --case release-demo
```

期待結果:

- `task_write_notes` が着手可能
- `task_publish` は `task_write_notes` にブロックされる

## 5. markdown projection を push する

```bash
pnpm cg sync push --sink markdown --case release-demo --apply
```

次のファイルが出力されます。

```text
.casegraph/cases/release-demo/projections/markdown.md
```

built-in の markdown sync は v0.1 の required reference integration なので、追加設定なしで使えます。

## 6. markdown 上で完了にする

生成された markdown を開き、次の行を:

```text
- [ ] Write release notes <!-- node: task_write_notes -->
```

次のように変更します。

```text
- [x] Write release notes <!-- node: task_write_notes -->
```

## 7. 変更を patch として pull する

```bash
pnpm cg sync pull --sink markdown --case release-demo --output ./release-demo-sync.patch.json
pnpm cg patch review --file ./release-demo-sync.patch.json
pnpm cg patch apply --file ./release-demo-sync.patch.json
```

## 8. 次の着手可能 task を確認する

```bash
pnpm cg frontier --case release-demo
pnpm cg case view --case release-demo
```

期待結果:

- `task_publish` が着手可能になる
- case view 上で `task_write_notes` が完了になり、`task_publish` が残タスクとして見える

## 9. 任意で分析コマンドを試す

```bash
pnpm cg analyze critical-path --case release-demo --goal goal_release_demo
pnpm cg analyze slack --case release-demo --goal goal_release_demo
pnpm cg analyze bottlenecks --case release-demo --goal goal_release_demo
```

## 関連ガイド

- [v0.1 Release Checklist (JA)](release-checklist.ja.md)
- [Manual Acceptance (JA)](manual-acceptance.ja.md)
