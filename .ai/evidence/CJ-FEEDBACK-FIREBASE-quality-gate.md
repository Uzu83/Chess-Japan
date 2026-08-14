# CJ-FEEDBACK-FIREBASE — quality gate / verify

date: 2026-08-14
branch: auto/feedback-firebase-2026-08-14

## Static

- `npm run verify` — pass（typecheck / lint / format / 450 tests / build）
- `src/feedback/client.test.ts` — 7 tests pass

## Acceptance (code)

| id | verdict | evidence |
|---|---|---|
| ac-vendor | pass | `vendor/feedback-*` + `FEEDBACK_PLATFORM_COMMIT.txt` + package.json file: deps |
| ac-submit-dev | pass | client.test: TARGET 無し → opts `{}` |
| ac-submit-prod | pass | client.test: TARGET=prod → `{ target: 'prod' }` |
| ac-kind-map | pass | client.test: explain_quality → other + prefix |
| ac-no-public-consent | pass | FeedbackDialog: 公開 Issue 同意なし / Issue URL なし |
| ac-form-fallback | pass | client.test: 未設定・throw → Form URL |
| ac-verify | pass | npm run verify |

## Manual

- `feedback_dev` smoke: **pass** — `feedback_dev/18bb911c-fb15-4207-93bf-d43012f649ba` (product=`chess-japan`, target omit, 2026-08-14)
- lockfile 変更: オーナー合意済み
- Pages `VITE_FEEDBACK_*` + `VITE_FEEDBACK_TARGET=prod`: 後続ステップ
