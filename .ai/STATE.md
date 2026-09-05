# Chess-Japan — Orchestrator State

writer: Orchestrator only  
updated: 2026-08-15

## Active

- **CJ-QM-FIXES**: Open QM Issues #72–#86 を小 PR 分割で修正中（親 #75）
  - 計画: `.cursor/plans/qm_issues_small_prs_0a9fa1fb.plan.md`
  - 順: #85 → #84 → #86 → #81 → #72 → #73 → #74+#83 → #76 → #82 → #77 → #80 → #78+#79 → close #75
  - 各 PR: verify + GPT Review Clean (Sol xhigh blocker 0) → merge

## Done (recent)

- **CJ-FEEDBACK-FIREBASE**: feedback-adcd2 接続完了（PR #87 `efc1f03`）

## Parked

- （なし）

## Do not

- `supabase/functions/explain` の Turnstile / レート / キャッシュ順を緩めない
- shogiground / やねうら王を改変しない
- feedback vendor を勝手に改変しない（正は feedback-platform）
- プラポリ本文を指示なしで触らない
