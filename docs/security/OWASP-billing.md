# OWASP Top 10（2021）× Chess-Japan 課金レーン

対象: Stripe Checkout / Portal / Webhook / explain の Pro entitlement。  
運用: [`stripe-runbook.md`](../operator/stripe-runbook.md)。Cloudflare / Stripe live は人間承認後のみ。

| ID | リスク | 本リポの対策 | 実装箇所 |
|---|---|---|---|
| **A01** Broken Access Control | 他人の plan 書き換え・オープンリダイレクト | `plan`/`stripe_*` は client UPDATE GRANT なし。Checkout/Portal は本人 JWT + email confirmed。return URL は **SITE_URL のみ**（Origin 不使用） | `0020` migration, `billingSite.ts`, checkout/portal |
| **A02** Cryptographic Failures | 鍵漏洩・平文秘密 | 秘密は Supabase secrets のみ。`VITE_` に Stripe 秘密を出さない。live 鍵は `STRIPE_ALLOW_LIVE=1` 必須 | `.env.example`, `stripeHttp.ts` |
| **A03** Injection | SQL/コマンド注入 | PostgREST 経由 + encodeURIComponent。Stripe は form API。ユーザー文字列を system prompt に入れない（既存 explain） | `stripeProfile.ts`, `validate.ts` |
| **A04** Insecure Design | 原価割れ・濫用 | Pro deep 月30・Flash 日150・匿名日50。past_due→free。Checkout/Portal uid レート | `billingPlans.ts`, `explain`, checkout/portal |
| **A05** Security Misconfiguration | CORS `*` + Origin 信頼、JWT 誤設定 | Billing return URL は `*` を無視。webhook のみ `--no-verify-jwt`（署名で代替）。checkout/portal は JWT 必須 | `billingSite.ts`, stripe-runbook |
| **A06** Vulnerable Components | 依存の既知脆弱性 | GHAS: CodeQL(+extended) / Trivy / Dependabot / secret scanning+push protection。週次 Dependabot | `security.yml`, `dependabot.yml` |
| **A07** Auth Failures | 匿名での課金開始 | Checkout/Portal: Bearer user JWT。anon/service_role key 拒否。email confirmed 必須 | `authUser.ts`, checkout/portal |
| **A08** Software/Data Integrity | 偽 webhook | Stripe-Signature HMAC 検証 + 時刻許容。`stripe_webhook_events` で event_id 冪等。body 256KB 上限 | `stripeHttp.ts`, `0021`, webhook |
| **A09** Logging Failures | 秘密・PII のログ | event type/id のみ。email / カード / raw body をログしない | webhook/checkout |
| **A10** SSRF | ユーザー URL へサーバ fetch | Stripe API 固定ホストのみ。SITE_URL は env の https オリジン | `stripeHttp.ts`, `billingSite.ts` |

## 課金固有の追加規律

1. Test mode 完走まで live 鍵を入れない  
2. Cloudflare production デプロイは合意後のみ  
3. Webhook 再送は 200 を返しつつ DB 冪等で無視  
4. Tier 2 ゲート（authz/cost/data）を push 前に通す  

## 残課題（意図的に Week-1 外）

- Checkout/Portal の IP 単位レート（現状は uid 単位 `bill:co|po`）  
- 運営用コストダッシュボード（GCP/Stripe UI で代替）
