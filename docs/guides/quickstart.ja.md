# クイックスタート

English: [quickstart.en.md](quickstart.en.md)

このガイドでは、新しい workspace を作成し、小さな case を登録し、markdown projection を push して、その変更を patch として pull するところまでを最短で確認します。

## 前提

- Node.js 22 以上（`node:sqlite` が必要）
- `@caphtech/casegraph-cli` をグローバルにインストール: `npm install -g @caphtech/casegraph-cli`
- 書き込み可能な作業ディレクトリ
- （リポジトリのコントリビューターがソースから実行する場合は、`pnpm install && pnpm build` のうえで `cg` の代わりに `pnpm run cg` を使ってもかまいません。）

## 1. workspace ディレクトリを準備する

```bash
export WORKSPACE="$(mktemp -d /tmp/casegraph-demo.XXXXXX)"
```

以下のコマンドは、空の workspace を `WORKSPACE` で指定して実行します。このガイドで使う CLI 起動方法は `cg --workspace "$WORKSPACE"` です。

## 2. workspace を初期化する

```bash
cg --workspace "$WORKSPACE" init --title "CaseGraph Demo"
```

`"$WORKSPACE"` 配下に `.casegraph/` が作られます。

## 3. 小さな release case を作る

```bash
cg --workspace "$WORKSPACE" case new --id release-demo --title "Release demo" --description "Quickstart case"

cg --workspace "$WORKSPACE" node add --case release-demo --id goal_release_demo --kind goal --title "Release demo ready"
cg --workspace "$WORKSPACE" node add --case release-demo --id task_write_notes --kind task --title "Write release notes" --state todo
cg --workspace "$WORKSPACE" node add --case release-demo --id task_publish --kind task --title "Publish build" --state todo

cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_publish_depends_notes --type depends_on --from task_publish --to task_write_notes
cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_notes_goal --type contributes_to --from task_write_notes --to goal_release_demo
cg --workspace "$WORKSPACE" edge add --case release-demo --id edge_publish_goal --type contributes_to --from task_publish --to goal_release_demo
```

## 4. 初期状態を見る

```bash
cg --workspace "$WORKSPACE" frontier --case release-demo
cg --workspace "$WORKSPACE" blockers --case release-demo
```

期待結果:

- `task_write_notes` が着手可能
- `task_publish` は `task_write_notes` にブロックされる

## 5. markdown projection を push する

```bash
cg --workspace "$WORKSPACE" sync push --sink markdown --case release-demo --apply
```

次のファイルが出力されます。

```text
$WORKSPACE/.casegraph/cases/release-demo/projections/markdown.md
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
cg --workspace "$WORKSPACE" sync pull --sink markdown --case release-demo --output "$WORKSPACE/release-demo-sync.patch.json"
cg --workspace "$WORKSPACE" patch review --file "$WORKSPACE/release-demo-sync.patch.json"
cg --workspace "$WORKSPACE" patch apply --file "$WORKSPACE/release-demo-sync.patch.json"
```

## 8. 次の着手可能 task を確認する

```bash
cg --workspace "$WORKSPACE" frontier --case release-demo
cg --workspace "$WORKSPACE" case view --case release-demo
```

期待結果:

- `task_publish` が着手可能になる
- case view 上で `task_write_notes` が完了になり、`task_publish` が残タスクとして見える

## 9. 任意で分析コマンドを試す

```bash
cg --workspace "$WORKSPACE" analyze critical-path --case release-demo --goal goal_release_demo
cg --workspace "$WORKSPACE" analyze slack --case release-demo --goal goal_release_demo
cg --workspace "$WORKSPACE" analyze bottlenecks --case release-demo --goal goal_release_demo
```

## 10. 完了として記録する

```bash
cg --workspace "$WORKSPACE" task done --case release-demo task_publish
cg --workspace "$WORKSPACE" evidence add --case release-demo \
  --id evidence_publish_receipt \
  --title "Published build receipt" \
  --target task_publish \
  --url "https://example.invalid/releases/demo"
cg --workspace "$WORKSPACE" task done --case release-demo goal_release_demo
cg --workspace "$WORKSPACE" frontier --case release-demo
cg --workspace "$WORKSPACE" validate --case release-demo
cg --workspace "$WORKSPACE" case show --case release-demo
```

期待結果:

- `frontier` は空になる
- `validate` は success を返す
- `case show` の `state` は、この時点では `open` のままでもよい

これが現行参照実装での completion pattern です。
goal / evidence / frontier / validate の組み合わせで completion を表し、その後に必要なら case を close します。

## 11. 必要なら case を close する

```bash
cg --workspace "$WORKSPACE" case close --case release-demo
cg --workspace "$WORKSPACE" case show --case release-demo
```

期待結果:

- `case show` の `state` が `closed` になる

## 関連ガイド

- [v0.1 Release Checklist (JA)](release-checklist.ja.md)
- [Manual Acceptance (JA)](manual-acceptance.ja.md)
