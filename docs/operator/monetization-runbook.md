# 収益化運用（Ko-fi → Stripe → AdSense）

決定の正: [`docs/decisions/0005-monetization-kofi-stripe-adsense.md`](../decisions/0005-monetization-kofi-stripe-adsense.md)

## 1. Ko-fi（いま・必須）

アプリヘッダーの「支援する」は Ko-fi URL があるとき出る（`src/App.tsx`）。
`VITE_KOFI_URL` 未設定時は **https://ko-fi.com/uz_u83** にフォールバック（オーナー確定 2026-07-27）。

### 手順

1. main へマージ／push → Cloudflare Pages が再ビルド（フォールバックで「支援する」表示）
2. （任意）Pages → Environment variables → Production に上書き:

   ```
   VITE_KOFI_URL=https://ko-fi.com/uz_u83
   ```

3. https://chess-japan.pages.dev で「支援する」→ Ko-fi を確認

ローカルは `.env.local` でも可。

## 2. Stripe サブスク（次・まだ実装しない）

目標（PLAN 案）: 月額 ¥400〜500 前後 → Pro 解説枠（例 100/日）・サーバー側で Gemini Pro。

### 実装前チェックリスト（人間）

- [ ] Stripe アカウント（日本・消費税の扱い確認）
- [ ] Product + Price（月額）を Dashboard で作成 → Price ID 控える
- [ ] Customer Portal 有効化
- [ ] Webhook endpoint 設計（`checkout.session.completed` / `customer.subscription.*`）
- [ ] Supabase: `profiles` または別表に `plan` / `stripe_customer_id`（RLS ロック設計）
- [ ] Edge `explain`: JWT → plan → model（Flash/Pro）。**クライアント model 指定禁止**
- [ ] 無料 IP 枠は維持（有料でも濫用防壁）。account quota は [0001](../decisions/0001-free-quota-account-abuse-defense.md)
- [ ] secrets: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / Price ID（**手動承認**）
- [ ] Tier 2 品質ゲート（authz / cost / data）

### 触ってよい範囲（実装フェーズ開始後）

- `src/**` のプラン表示 UI
- Edge Function（checkout / webhook / explain のプラン分岐）
- migration（追記のみ）

### 触らない

- 本番 Stripe キーの自動投入
- AdSense 同時導入
- `validate.ts` へのクライアント `model` フィールド

## 3. AdSense（後回し）

再検討ライン: **月間数千 PV** かつ COEP 方針を決めたあと。

検討時の最低条件:

- `COEP: credentialless` またはエンジン別オリジン隔離
- CSP に広告ドメインを最小追加
- 同意バナー（必要な法域）
- 表示位置はフッター1枠のみ
