# Cursor Automation（feedback → draft PR）— **v2 予定**

v1 では **Issue 起票まで**。本ドキュメントは v2 実装時のレシピ。

## なぜ v1 でやらないか（Codex reject）

- 公開 Issue のユーザー文を Agent に渡すと prompt injection になりうる
- denylist（`.github` 等）だけでは `package.json` / `scripts/**` 経由で `auto/**` CI を動かせる
- 安全な自動 PR には **変更 allowlist** と **Agent ブランチ用 CI 隔離（secrets なし）** が必要

## v2 要件（実装前チェックリスト）

- [ ] Issue ごと（またはラベル）で変更 **allowlist** を指定できる
- [ ] `auto/feedback-*` ブランチの CI は secrets なし・最小権限
- [ ] Automation 指示でユーザー payload を untrusted / 符号化ブロックのみ参照と明記
- [ ] 禁止（最低）: `.github/**`, `package*.json`, `scripts/**`, `supabase/migrations/**`, `supabase/functions/explain/**`
- [ ] draft PR のみ・auto-merge なし
- [ ] 同一 Issue の再ラベルで多重起動しない（冪等）運用確認
- [ ] オーナーが Issue を精読してから `agent-fix` を付ける

## 想定トリガー（v2）

- GitHub Issue に `agent-fix` が付いたとき
- Cloud Agent → branch `auto/feedback-<issue番号>` → **draft** PR
- `npm run verify` まで。Tier 2 領域に触れるなら手を広げず PR 本文に明記

## v1 での人手フロー

1. Issue をトリアージ
2. 必要ならローカル / Cursor で手動修正 → 通常の PR（`auto/` でも可）
3. Tier に応じて quality gate
