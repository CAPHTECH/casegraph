# Example: Move Case

この例は、一般タスクとしての引っ越しを CaseGraph でどう表現するかを示します。

## ケース

- `case_id`: `move-2026-05`
- `title`: `Move in May 2026`

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

## 例示コマンド

```bash
cg case new --id move-2026-05 --title "Move in May 2026"
cg node add --case move-2026-05 --id decision_pick_move_date --kind decision --title "Pick move date" --state todo
cg node add --case move-2026-05 --id event_mover_quote_returned --kind event --title "Mover quote returned" --state todo
cg node add --case move-2026-05 --id task_book_mover --kind task --title "Book moving company" --state todo
cg edge add --case move-2026-05 --id e1 --type depends_on --from task_book_mover --to decision_pick_move_date
cg edge add --case move-2026-05 --id e2 --type waits_for --from task_book_mover --to event_mover_quote_returned
cg blockers --case move-2026-05
```
