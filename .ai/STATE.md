# Chess-Japan — Orchestrator State

writer: Orchestrator only  
updated: 2026-08-14

## Active

- **CJ-FEEDBACK-FIREBASE** (ready_for_push): フィードバックを `feedback-adcd2` へ接続
  - 契約: `.ai/tasks/CJ-FEEDBACK-FIREBASE.yaml`
  - 証拠: `.ai/evidence/CJ-FEEDBACK-FIREBASE-quality-gate.md`
  - ブランチ: `auto/feedback-firebase-2026-08-14`
  - smoke: `feedback_dev/18bb911c-fb15-4207-93bf-d43012f649ba`
  - 次: Codex Clean → push/PR → CI → merge → Pages env

## Parked

- **CJ-QM-TRIAGE**: #72/#73/#74 採用裁定済み。実装は未着手
  - #72 Turnstile UI / #73 shogi events / #74 コピー+中断保存（再開は延期）

## Do not

- `supabase/functions/explain` の Turnstile / レート / キャッシュ順を緩めない
- shogiground / やねうら王を改変しない
- feedback vendor を勝手に改変しない（正は feedback-platform）
- プラポリ本文を指示なしで触らない
