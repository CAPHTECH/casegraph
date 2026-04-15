# Spec Index

**Spec version:** 0.1-draft

このディレクトリは CaseGraph の仕様書です。  
実装言語に依存しない中核仕様を先に固定し、その上に参照実装を載せる前提で書かれています。

## 仕様一覧
1. [00-overview.md](00-overview.md)
2. [01-domain-model.md](01-domain-model.md)
3. [02-storage.md](02-storage.md)
4. [03-state-and-frontier.md](03-state-and-frontier.md)
5. [04-graphpatch.md](04-graphpatch.md)
6. [05-cli.md](05-cli.md)
7. [06-adapter-protocol.md](06-adapter-protocol.md)
8. [07-worker-protocol.md](07-worker-protocol.md)
9. [08-projections.md](08-projections.md)
10. [09-security-and-trust.md](09-security-and-trust.md)
11. [10-testing-strategy.md](10-testing-strategy.md)
12. [11-schema-reference.md](11-schema-reference.md)

## 前提
- source of truth は内部の event log
- SQLite は再構築可能な cache
- AI は patch を提案する補助層
- 外部ツールは projection sink または importer
- worker は task を実行するが、graph を直接 mutate しない

## 非目標
- 特定ベンダーに最適化した閉じた設計
- GUI を前提にしたモデルの単純化
- 完全自律型の agent platform
- multi-tenant SaaS としての初期設計
