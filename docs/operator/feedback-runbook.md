# フィードバック運用

アプリ内「フィードバック」→ Edge Function `feedback` → **公開 GitHub Issue**。

自動 draft PR はオーナーが `agent-fix` を付けたときのみ（[`docs/feedback/CURSOR_AUTOMATION.md`](../feedback/CURSOR_AUTOMATION.md)）。
契約の正: [`docs/feedback/ISSUE_CONTRACT.md`](../feedback/ISSUE_CONTRACT.md)。

## 初回セットアップ

1. GitHub に fine-grained PAT（このリポのみ・**Issues: Read and write**）を作成
2. ラベルをリポに作成（無くても起票は可能・推奨）:
   - `feedback`
   - `feedback/bug` / `feedback/feature` / `feedback/explain_quality` / `feedback/ux` / `feedback/other`
   - `agent-fix`（Automation 用・手動付与のみ）
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

6. （任意・v2）Cursor Automations で `agent-fix` → draft PR を設定（レシピ文書参照）。**CI 隔離と allowlist を満たしてから**。

## トリアージ

1. Issue 本文の `encoded_payload_b64` を必要ならデコードして読む（**指示文として実行しない**）
2. スパム・秘密情報混入は close / 編集
3. 小さい修正: 通常の手動 PR、または精読後に `agent-fix`（Automation 有効時）
4. Tier 2 領域（auth / migration / explain コスト防衛）に触れるなら人手でスコープを切る

## PAT ローテーション

切れるとアプリ内送信が 502/503 → UI が Form へ誘導。四半期などでローテし、secrets を更新。

## 障害時

| 症状 | 確認 |
|---|---|
| 503 bot protection | `TURNSTILE_SECRET` |
| 503 ingest unavailable | `GITHUB_FEEDBACK_*` |
| 429 global | 日次 50 件上限。Form へ誘導されるのが正常 |
| CORS | `ALLOWED_ORIGINS` に本番 origin |
