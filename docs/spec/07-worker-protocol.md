# 07. Worker Protocol

## 7.1 目的

Worker は task を実行するための外部実行器です。例:

- shell command
- local LLM
- cloud LLM
- code agent
- document summarizer

Worker は便利ですが、CaseGraph の source of truth を持ちません。worker は **task context を受け取り、execution result と optional GraphPatch を返す** のが役割です。

---

## 7.2 Worker の分類

### Pure worker
外部状態を変えず、要約・分類・提案だけを返す。

例:
- local LLM summarizer
- graph normalizer

### Effectful worker
外部状態を変える。

例:
- shell script that edits files
- code agent that modifies repo
- API caller that creates records

### なぜ分類するか
approval policy と audit 要件が変わるからです。

---

## 7.3 Protocol transport

worker も v0.1 では **JSON-RPC 2.0 over stdio** を採用します。adapter と同じ transport にすることで実装負担を下げます。

---

## 7.4 `worker.execute` request

```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "method": "worker.execute",
  "params": {
    "case": {
      "case_id": "release-1.8.0",
      "title": "Release 1.8.0"
    },
    "task": {
      "node_id": "task_update_release_notes",
      "kind": "task",
      "title": "Update release notes",
      "description": "Summarize shipped changes",
      "state": "todo",
      "acceptance": ["差分が主要機能を反映している"]
    },
    "context": {
      "related_nodes": [],
      "related_edges": [],
      "attachments": [],
      "metadata": {}
    },
    "execution_policy": {
      "effectful": false,
      "approval": "required_if_effectful",
      "timeout_seconds": 300
    }
  }
}
```

---

## 7.5 `worker.execute` response

```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "result": {
    "status": "succeeded",
    "summary": "Release notes draft generated",
    "artifacts": [
      {
        "kind": "text",
        "path": "/tmp/release-notes.md"
      }
    ],
    "patch": {
      "...": "GraphPatch"
    },
    "observations": [
      "入力情報だけでは App Store submission 状況を確認できない"
    ]
  }
}
```

### `status` の例
- `succeeded`
- `failed`
- `needs_approval`
- `partial`

---

## 7.6 Worker が返してよいもの

- summary
- observations
- artifacts
- GraphPatch
- logs
- metrics

### Worker が返してはいけないもの
- 直接の internal state mutation
- silent side effects の隠蔽
- approval を要する操作の事後報告のみ

---

## 7.7 Task context の最小設計

Worker に渡す context は必要最小限にします。

### 必須
- current task
- related dependency nodes
- related event / evidence
- relevant attachments
- execution policy

### 任意
- projected external IDs
- repository paths
- sink-specific metadata

### 理由
コンテキストを増やしすぎると、cost と leak risk が増えるからです。

---

## 7.8 Approval model

Effectful worker を安全に使うには approval が要ります。

### v0.1 の基本 policy
- pure worker: default allow
- effectful worker: explicit approval
- network / shell / file-write は capability として宣言

### capability 例

```json
{
  "read_files": true,
  "write_files": true,
  "network_access": false,
  "shell_access": false
}
```

CLI は capability を表示し、必要なら `--approve` を要求します。

---

## 7.9 Worker と GraphPatch の関係

Worker は実行結果を patch として返せますが、その patch はあくまで提案です。

### 例
- shell worker が test を実行し、`task_run_tests -> done` の patch を返す
- local LLM worker が docs を要約し、新しい task 候補 patch を返す
- code agent worker が repo を変更し、evidence として diff path を返す

適用は CaseGraph 側で行います。

---

## 7.10 Example workers

### Shell worker
- コマンドを実行
- stdout / stderr を artifact として返す
- exit code を result に含める

### Local LLM worker
- 入力資料を構造化
- task / edge 候補 patch を返す
- effectful ではない

### Code agent worker
- repo context を受け取る
- 実装や修正を行う
- patch と diff artifact を返す
- effectful なので approval 必須

---

## 7.10a Patch extraction convention (code agent / local LLM bridges)

LLM や code agent を worker として組み込むとき、「自由文の出力から GraphPatch を抽出する」ための軽量な規約を設けます。AI の出力は散文と JSON が混在しやすいので、強制的なパーサ契約ではなく **fenced code block による宣言** で解決します。

### Output contract
worker は応答に **ちょうど 1 つ** の fenced code block を含め、ラベルは `casegraph-patch` を推奨します。内側は GraphPatch JSON。

```casegraph-patch
{
  "patch_id": "patch_xxx",
  "spec_version": "0.1-draft",
  "case_id": "<case id>",
  "base_revision": 0,
  "summary": "...",
  "operations": [...]
}
```

`base_revision` は CaseGraph 側 (`cg worker run` / `reviewReturnedPatch`) が worker.finished 追記後の revision に書き換えるので、0 のままで構いません。

### Extraction rule
- 最後に出現する `casegraph-patch` fence を優先。
- なければ最後の `json` fence にフォールバック。
- JSON.parse → `validateGraphPatchDocument` で通ったものだけを GraphPatch として採用。
- fence が 1 つも無い / 壊れている場合は `status: "failed"` (patch なし) として worker.finished を追記する (agent 側で再試行可能にするため、worker_patch_invalid は投げない)。

### Retry with feedback (worker 内ループ)
worker plugin は extraction 失敗時に **plugin 内で 1 回だけ retry** してよい。retry prompt は
`buildRetryPrompt({ originalPrompt, previousResponse, reason })` で構築する — 元のプロンプトに
前回の応答と rejection reason (code + message) を追加した形。Retry は plugin 内で閉じる (JSON-RPC
の `worker.execute` は 1 回のままで、worker-host 側の `worker.dispatched` / `worker.finished` の
対応関係は崩れない)。in-tree `worker-code-agent` / `worker-local-llm` は既定で `MAX_RETRIES = 1`。
observations には `Retry <n> after (<code>): <message>` を追記する。

### In-tree 実装
- shared helper: `packages/core/src/worker-prompt.ts::buildAgentPrompt / extractPatchFromText`。
- `packages/worker-code-agent` — 外部 CLI (default `claude --print`、`CASEGRAPH_CODE_AGENT_CMD` で上書き可) を spawn し prompt を stdin に流す。
- `packages/worker-local-llm` — Ollama `/api/generate` に POST (default `http://localhost:11434`, `llama3.1:8b`、`OLLAMA_HOST` / `CASEGRAPH_LOCAL_LLM_MODEL` で上書き可)。

---

## 7.11 Idempotency

worker は effectful なので重複実行に注意が要ります。

### v0.1 の方針
- `request_id` / `command_id` を渡す
- worker は可能なら idempotency key を利用
- CaseGraph 側は duplicate apply を避ける

---

## 7.12 Observability

event log には少なくとも次を残します。

- worker dispatched
- worker finished
- status
- artifact references
- patch accepted / rejected

これにより、外部実行の追跡が可能になります。
