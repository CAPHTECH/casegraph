# Example: Move Case

この例は、一般タスクとしての引っ越しを CaseGraph でどう表現するかを示します。
Phase 0 では narrative example であると同時に、**acceptance fixture** として扱います。

## ケース

- `case_id`: `move-2026-05`
- `title`: `Move in May 2026`

## Canonical Initial Graph

初期 fixture では次を graph に含めます。

- `goal_move_completed`
- `task_choose_mover` (`state=todo`)
- `task_book_mover` (`state=todo`)
- `task_cancel_old_electricity` (`state=todo`)
- `task_start_new_electricity` (`state=todo`)
- `task_change_address` (`state=todo`)
- `decision_pick_move_date` (`state=todo`)
- `event_mover_quote_returned` (`state=todo`)
- `event_lease_confirmed` (`state=todo`)

次の識別子は後続フローで利用してよい参照 ID ですが、初期 acceptance では必須にしません。

- `evidence_utility_receipt`
- `evidence_address_change_receipt`

## Goals

- `goal_move_completed`: 引っ越し完了

## Tasks

- `task_choose_mover`: 引っ越し業者を選ぶ
- `task_book_mover`: 引っ越し日を予約する
- `task_cancel_old_electricity`: 現住所の電気停止連絡
- `task_start_new_electricity`: 新住所の電気開始連絡
- `task_change_address`: 住所変更手続き

## Decisions

- `decision_pick_move_date`: 引っ越し日を決める

## Events

- `event_mover_quote_returned`: 見積もり返信
- `event_lease_confirmed`: 新居契約確定

## Evidence

- `evidence_utility_receipt`
- `evidence_address_change_receipt`

## Edges

```text
task_book_mover depends_on decision_pick_move_date
task_book_mover waits_for event_mover_quote_returned
task_start_new_electricity waits_for event_lease_confirmed
task_change_address waits_for event_lease_confirmed

task_choose_mover contributes_to goal_move_completed
task_book_mover contributes_to goal_move_completed
task_cancel_old_electricity contributes_to goal_move_completed
task_start_new_electricity contributes_to goal_move_completed
task_change_address contributes_to goal_move_completed

evidence_utility_receipt verifies task_start_new_electricity
evidence_address_change_receipt verifies task_change_address
```

## 運用のポイント

### 1. 一般タスクでも同じ核で扱える
コードや PR は出てこないが、依存・待機・証跡という構造は同じ。

### 2. event の重要性
`event_lease_confirmed` が発生しない限り、新住所系の task は ready にならない。

### 3. waiting と blocker を分ける
- 見積もり返信待ちで明示的に hold したいなら `state=waiting`
- 単なる event 未発生なら derived blocker でも足りる

### 4. projection
- daily action list には `task_choose_mover` など ready task だけ出す
- summary 出力では waiting event も見えるようにする

## Normative Acceptance

frontier は **集合として評価** します。
priority metadata を明示しない限り、出力順は acceptance 条件に含めません。

### Initial frontier

初期 `frontier` は次の集合であること。

- `decision_pick_move_date`
- `task_cancel_old_electricity`
- `task_choose_mover`

### Initial blockers

初期 `blockers` には少なくとも次が含まれること。

- `task_book_mover`: `decision_pick_move_date` への `depends_on` と `event_mover_quote_returned` への `waits_for` が未充足
- `task_start_new_electricity`: `event_lease_confirmed` への `waits_for` が未充足
- `task_change_address`: `event_lease_confirmed` への `waits_for` が未充足

### Transition scenario

次の 2 つの遷移が成立すること。

1. `decision_pick_move_date` を確定し、`event_mover_quote_returned` を記録した後、`task_book_mover` が frontier に入る
2. `event_lease_confirmed` を記録した後、`task_start_new_electricity` と `task_change_address` が frontier に入る

## 例示コマンド

```bash
cg case new --id move-2026-05 --title "Move in May 2026"
cg node add --case move-2026-05 --id goal_move_completed --kind goal --title "Move completed" --state todo
cg node add --case move-2026-05 --id task_choose_mover --kind task --title "Choose moving company" --state todo
cg node add --case move-2026-05 --id decision_pick_move_date --kind decision --title "Pick move date" --state todo
cg node add --case move-2026-05 --id event_mover_quote_returned --kind event --title "Mover quote returned" --state todo
cg node add --case move-2026-05 --id event_lease_confirmed --kind event --title "Lease confirmed" --state todo
cg node add --case move-2026-05 --id task_book_mover --kind task --title "Book moving company" --state todo
cg node add --case move-2026-05 --id task_cancel_old_electricity --kind task --title "Cancel old electricity" --state todo
cg node add --case move-2026-05 --id task_start_new_electricity --kind task --title "Start new electricity" --state todo
cg node add --case move-2026-05 --id task_change_address --kind task --title "Change address" --state todo
cg edge add --case move-2026-05 --id e1 --type depends_on --from task_book_mover --to decision_pick_move_date
cg edge add --case move-2026-05 --id e2 --type waits_for --from task_book_mover --to event_mover_quote_returned
cg edge add --case move-2026-05 --id e3 --type waits_for --from task_start_new_electricity --to event_lease_confirmed
cg edge add --case move-2026-05 --id e4 --type waits_for --from task_change_address --to event_lease_confirmed
cg blockers --case move-2026-05
cg decision decide --case move-2026-05 decision_pick_move_date
cg event record --case move-2026-05 event_mover_quote_returned
cg event record --case move-2026-05 event_lease_confirmed
cg frontier --case move-2026-05
```
