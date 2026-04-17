# v0.1 リリースチェックリスト

English: [release-checklist.en.md](release-checklist.en.md)

現在の tree を `v0.1` の release candidate と呼ぶ前に、このチェックリストを使います。

repository root から一時 workspace を検証する場合は、`WORKSPACE=/path/to/temp-dir` を設定し、`pnpm run cg --workspace "$WORKSPACE" ...` を使います。

## スコープと surface

- [ ] stable core が Phase 1 の CLI surface と storage recovery/admin command のままである
- [ ] markdown sync が required reference integration のままである
- [ ] 外部 sink は optional integration のままである
- [ ] deferred topics を release blocker として扱っていない

## 自動検証

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:e2e`
- [ ] `pnpm pack:release`
- [ ] `pnpm publish:release:dry-run`

障害解析用の補助コマンド:

- [ ] `pnpm test:analysis-golden`
- [ ] `pnpm test:analysis-eval`

## 手動検証

- [ ] [Quickstart](quickstart.ja.md) が end-to-end で通る
- [ ] [Manual Acceptance](manual-acceptance.ja.md) が end-to-end で通る
- [ ] 検証対象 workspace に対して `pnpm run cg --workspace "$WORKSPACE" migrate check` が期待どおりの状態を返す
- [ ] release example に対して `pnpm run cg --workspace "$WORKSPACE" case view --case release-1.8.0` が空でない tree を返す

## ドキュメント確認

- [ ] `docs/README.md` から現在の guides に辿れる
- [ ] 英語版と日本語版の guide が同じ流れを説明している
- [ ] `docs/spec/00-overview.md` の成功条件が実装と一致している
- [ ] `docs/spec/10-testing-strategy.md` が実際の回帰スイートと一致している

## リリース記録

- [ ] release candidate に使った commit hash を残す
- [ ] 検証日を残す
- [ ] 通過したコマンドをそのまま残す
- [ ] optional surface と deferred item を明示する
- [ ] npm scope が `@caphtech` であることを確認する
- [ ] publish 順序が [npm Release Guide](npm-release.ja.md) と一致していることを確認する

## 最低限のリリース宣言

公開前に、次を留保なく言える状態にします。

- 決定論的 core の full regression suite が通っている
- markdown sync の happy-path と edge-case 回帰が通っている
- documented CLI flow に対する black-box E2E が通っている
- docs が stable / optional の境界を正しく説明している
