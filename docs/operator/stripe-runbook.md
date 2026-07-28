# Stripe 運用チェックリスト（接続後・誤課金防止）

決定の正: [`docs/decisions/0005-monetization-kofi-stripe-adsense.md`](../decisions/0005-monetization-kofi-stripe-adsense.md)  
OWASP 対応表: [`docs/security/OWASP-billing.md`](../security/OWASP-billing.md)  
実装スコープ: Checkout + Portal + Webhook のみ。SKU ¥480 / Flash 150/日 + deep 30/月。

## 絶対ルール

1. **最初は Test mode だけ**（`sk_test_…` / test Price / test webhook secret）
2. Edge は `sk_live_` を **`STRIPE_ALLOW_LIVE=1` 無しでは拒否**する（`_shared/stripeHttp.ts`）
3. Webhook 署名検証必須。`STRIPE_WEBHOOK_SECRET` 未設定なら 503
4. `profiles.plan` は **webhook だけが書く**（クライアント UPDATE GRANT なし）
5. **`SITE_URL=https://…` 必須**（Checkout/Portal の return URL。リクエスト Origin は使わない）
6. 本番 live 切替前に: test で Checkout→webhook→`plan=pro`→Portal 解約→`plan=free` を通す
7. DB: `0020_profiles_stripe_plan` + `0021_stripe_webhook_events`（冪等）適用済みであること

## Dashboard 手順（Test）

1. Product「Chess-Japan Pro」+ Price **¥480 / month** → `price_…` を控える
2. Customer Portal を有効化（解約・カード更新）
3. Webhook endpoint:
   - URL: `https://vpbixcwxjhmapcyaarbq.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Signing secret → `STRIPE_WEBHOOK_SECRET`
4. Supabase secrets（**test キー**）:

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_ID=price_... \
  SITE_URL=https://chess-japan.pages.dev \
  --project-ref vpbixcwxjhmapcyaarbq
# STRIPE_ALLOW_LIVE は付けない
```

5. Deploy（**webhook は JWT 検証オフ**）:

```bash
supabase functions deploy stripe-checkout --project-ref vpbixcwxjhmapcyaarbq
supabase functions deploy stripe-portal --project-ref vpbixcwxjhmapcyaarbq
supabase functions deploy stripe-webhook --project-ref vpbixcwxjhmapcyaarbq --no-verify-jwt
supabase functions deploy explain --project-ref vpbixcwxjhmapcyaarbq
```

## Live 切替（人間承認）

- [ ] Test E2E 完了
- [ ] live Price ID / live webhook endpoint 新規作成（test と混ぜない）
- [ ] secrets を live に差し替え + `STRIPE_ALLOW_LIVE=1`
- [ ] 少額実課金→即 Portal 解約で確認

## 障害時

| 症状 | 確認 |
|---|---|
| 503 billing not configured | secrets / live ブロック |
| 401 on checkout | ログイン・email confirmed |
| plan が pro にならない | webhook 署名・events・`--no-verify-jwt` |
| 深掘り 402 | Pro 未契約 or past_due |
