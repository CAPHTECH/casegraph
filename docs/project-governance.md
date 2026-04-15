# Project Governance

この文書は、CaseGraph を public OSS として運営する前提のガイドラインです。

## 1. 位置づけ

CaseGraph は「新しい Todo アプリ」ではなく、**ケースグラフ基盤** です。  
したがって、個別サービス連携より先に、仕様安定性と ecosystem 形成を優先します。

## 2. 推奨ライセンス

推奨は **Apache-2.0**。理由は次の通りです。

- 商用利用しやすい
- plugin / adapter ecosystem と相性がよい
- patent grant が明確
- public infrastructure project に向いている

## 3. バージョニング

### 別々に version を持つ
- Spec version
- CLI version
- Adapter protocol version
- Worker protocol version

### 原則
- Spec の破壊的変更は最も慎重に扱う
- CLI の UX 変更は deprecation period を設ける
- plugin protocol は capability negotiation を重視する

## 4. リポジトリ方針

推奨構成:

```text
/docs
/packages
/tests
/examples
```

### 重要
- README だけで設計を語らない
- ADR を残す
- examples を仕様の一部として扱う
- conformance test を plugin ecosystem に提供する

## 5. 受け入れ方針

### 受け入れやすい変更
- 新しい sink / importer / worker
- CLI の可観測性改善
- reducer の性能改善
- schema の backward-compatible な追加

### 慎重に扱う変更
- core node/edge type の変更
- source of truth の変更
- full bidirectional sync 要求
- AI が直接 mutate する設計変更

## 6. 互換性ポリシー

v0.x では急激な変更を許容しつつも、次は守るべきです。

- event log の読み込み互換性
- patch apply の基本契約
- JSON-RPC handshake の後方互換性
- examples の動作継続

## 7. 初期 maintainership の焦点

初期段階で守るべき優先順位は次です。

1. core の正しさ
2. CLI の安定性
3. spec の明確さ
4. markdown / todoist / taskwarrior など代表 sink の品質
5. worker protocol の簡潔さ

## 8. やらないこと

- 早期に SaaS 化を前提にする
- 一つのベンダーに最適化しすぎる
- UI 先行で core を歪める
- plugin 乱立で spec が崩れるのを放置する
