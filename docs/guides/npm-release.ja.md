# npm Release Guide

English: [npm-release.en.md](npm-release.en.md)

CaseGraph の scoped npm release を準備するときに使うガイドです。

## Scope

公開対象パッケージはすべて `@caphtech` scope を使います。

- `@caphtech/casegraph-core`
- `@caphtech/casegraph-cli`
- `@caphtech/casegraph-importer-markdown`
- `@caphtech/casegraph-sink-markdown`
- `@caphtech/casegraph-worker-shell`
- `@caphtech/casegraph-worker-code-agent`
- `@caphtech/casegraph-worker-local-llm`

## 前提条件

- npm に `@caphtech` への publish 権限付きでログインしている
- repository root の状態から release commit を特定できる
- 現在の workspace metadata で `pnpm install` を実行済みである

## 検証

repository root で次を実行します。

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm pack:release
pnpm publish:release:dry-run
```

`pnpm pack:release` は各 package tarball に必要な build 出力と metadata が入っているかを確認します。  
`pnpm publish:release:dry-run` は publish 順序と registry metadata を公開なしで確認します。

## Publish 順序

CLI が依存パッケージを解決できるよう、依存順で公開します。

```bash
pnpm --filter @caphtech/casegraph-core publish --access public
pnpm --filter @caphtech/casegraph-importer-markdown publish --access public
pnpm --filter @caphtech/casegraph-sink-markdown publish --access public
pnpm --filter @caphtech/casegraph-worker-shell publish --access public
pnpm --filter @caphtech/casegraph-worker-code-agent publish --access public
pnpm --filter @caphtech/casegraph-worker-local-llm publish --access public
pnpm --filter @caphtech/casegraph-cli publish --access public
```

失敗後に再公開が必要になった場合は、同じ version を再利用せず version を上げてからやり直します。

## 公開後チェック

公開後は public install 経路を確認します。

```bash
npm install -g @caphtech/casegraph-cli
cg --help
```
