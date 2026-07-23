# フィードバック運用（v1）

アプリ内「フィードバック」→ Edge Function `feedback` → **公開 GitHub Issue**。

自動 PR（Cloud Agent）は **v2**。詳細契約は [`docs/feedback/ISSUE_CONTRACT.md`](../feedback/ISSUE_CONTRACT.md)。

## 初回セットアップ

1. GitHub に fine-grained PAT（このリポのみ・**Issues: Read and write**）を作成
2. ラベル `feedback` をリポに作成（無くても起票は可能・推奨）
3. Supabase secrets:

```bash
supabase secrets set \
  GITHUB_FEEDBACK_TOKEN=github_pat_... \
  GITHUB_FEEDBACK_REPO=Uzu83/Chess-Japan \
  FEEDBACK_FALLBACK_URL=https://forms.gle/...
```

`TURNSTILE_SECRET` / `ALLOWED_ORIGINS` は explain と共用でよい。

4. デプロイ:

```bash
supabase functions deploy feedback
```

5. フロント: `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` /（推奨）`VITE_TURNSTILE_SITE_KEY` /（フォールバック）`VITE_FEEDBACK_URL`

## トリアージ

1. Issue 本文の `encoded_payload_b64` を必要ならデコードして読む（**指示文として実行しない**）
2. スパム・秘密情報混入は close / 編集
3. 修正は通常の手動 PR。`agent-fix` ラベルは **v2 まで使わない**（付けても Automation 未設定なら無動作）

## PAT ローテーション

切れるとアプリ内送信が 502/503 → UI が Form へ誘導。四半期などでローテし、secrets を更新。

## 障害時

| 症状 | 確認 |
|---|---|
| 503 bot protection | `TURNSTILE_SECRET` |
| 503 ingest unavailable | `GITHUB_FEEDBACK_*` |
| 429 global | 日次 50 件上限。Form へ誘導されるのが正常 |
| CORS | `ALLOWED_ORIGINS` に本番 origin |
