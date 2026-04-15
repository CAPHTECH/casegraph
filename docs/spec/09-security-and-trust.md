# 09. Security and Trust

## 9.1 前提

CaseGraph は一般タスクも扱うため、次のような情報を含みます。

- 個人情報
- 契約や支払いに関する情報
- private repository への参照
- notes, attachments, evidence
- 外部サービスの認証情報

したがって、設計段階から trust boundary を明確にする必要があります。

---

## 9.2 基本原則

1. **local-first**
2. **least privilege**
3. **explicit approval for effectful actions**
4. **audit by default**
5. **AI does not own state**
6. **plugin isolation**

---

## 9.3 データの分類

### Core graph data
比較的構造化されているが、内容次第で秘匿性が高い。

### Attachments / evidence
もっとも機微になりやすい。

### Secrets
API keys, tokens, credentials。event log に入れてはいけない。

### External artifacts
worker が生成した diff, logs, temp files。保存期間と保存場所を制御すべき。

---

## 9.4 Secrets 管理

v0.1 では次を推奨します。

- secret は `config.yaml` に直接書かない
- 環境変数または OS keychain を利用
- adapter / worker には必要最小限だけ渡す
- event log には redacted identifier だけ残す

### 例
- `TODOIST_TOKEN` environment variable
- worker ごとの env allowlist

---

## 9.5 Plugin trust boundary

adapter / worker は out-of-process で実行します。これは拡張性だけでなく安全性のためです。

### 利点
- crash isolation
- capability declaration
- monitoring しやすい
- access scope を限定しやすい

### リスク
- 任意コード実行
- data exfiltration
- external side effect

そのため plugin 登録時に capability と trust level を明示します。

---

## 9.6 Capability 例

```json
{
  "read_workspace": true,
  "write_workspace": false,
  "network_access": true,
  "shell_access": false,
  "secret_requirements": ["TODOIST_TOKEN"]
}
```

CLI は worker / adapter 実行前に capability を表示できます。

---

## 9.7 Approval policy

特に危険なのは effectful worker です。

### デフォルト policy
- read-only importer: allow
- local pure worker: allow
- file write worker: require approval
- networked effectful sink: require approval on first use, then configurable
- shell worker: require approval

### 実装形
- `config.yaml` に policy
- コマンド引数 `--approve`
- interactive prompt or non-interactive fail

---

## 9.8 Audit trail

event log はセキュリティ上も重要です。

記録すべき項目:
- 誰が
- いつ
- 何を
- どの plugin / worker 経由で
- どの approval policy のもとで

これにより、AI や外部 plugin の挙動を後から追えます。

---

## 9.9 Data minimization

Worker へ渡す context は最小にするべきです。

### 悪い例
- workspace 全体を毎回丸ごと渡す
- 無関係な attachment を全部共有する
- sink API key を無差別に配る

### 良い例
- task 近傍サブグラフのみ渡す
- 指定された attachment のみ渡す
- secret は plugin 単位で注入

---

## 9.10 Redaction

将来の logging / analytics を見据え、redaction 機構を持てる余地を残します。

### v0.1 の最低限
- event log 出力時に secret を落とす
- CLI error で token を出さない
- plugin stderr をそのまま保存しすぎない
