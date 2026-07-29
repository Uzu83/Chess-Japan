# OWASP Top 10（2021）× Chess-Japan

対象: SPA + Supabase Edge（explain / feedback / pvp / Stripe）+ Cloudflare Pages。  
課金運用: [`stripe-runbook.md`](../operator/stripe-runbook.md)。

| ID | リスク | 本リポの対策 | 実装箇所 |
|---|---|---|---|
| **A01** Broken Access Control | plan 書き換え・オープンリダイレクト・IDOR | `plan`/`stripe_*` は client UPDATE GRANT なし。Checkout/Portal は本人 JWT。return URL は **SITE_URL のみ**。pvp は body `user_id` 不使用 | migrations `0020`, `billingSite.ts`, checkout/portal/pvp |
| **A02** Cryptographic Failures | 鍵漏洩 | 秘密は Supabase secrets のみ。Gemini は `x-goog-api-key`（URL に載せない）。live Stripe は `STRIPE_ALLOW_LIVE=1` | `stripeHttp.ts`, `explain` Gemini |
| **A03** Injection | SQL / プロンプト注入 | PostgREST + encodeURIComponent。`validate.ts` 厳格検証。user 文字列は DATA 柵 | `validate.ts`, `prompt.ts` |
| **A04** Insecure Design | 原価割れ・濫用・DoS | 日次/月次クォータ、Turnstile(+hostname)、body 上限（webhook 含む）、Checkout uid+IP レート | `billingPlans`, explain/feedback, `readBodyCapped` |
| **A05** Security Misconfiguration | CORS / ヘッダ不足 | hosted で `ALLOWED_ORIGINS` 空は fail-closed。CSP + HSTS + `frame-ancestors 'none'` + COOP/COEP | `_shared/cors.ts`, `public/_headers` |
| **A06** Vulnerable Components | 既知 CVE | CodeQL(+extended) / Trivy / Dependabot / secret scanning+push protection | `security.yml` |
| **A07** Auth Failures | 匿名課金・トークン混同 | `getAuthUser` が anon/service_role を拒否。email confirmed。Turnstile hostname | `authUser.ts`, turnstile |
| **A08** Software/Data Integrity | 偽 webhook | Stripe-Signature + event 冪等 + **Price ID を Stripe retrieve で fail-closed** | webhook, `0021` |
| **A09** Logging Failures | 情報漏洩 | explain/pvp/Stripe は generic エラー。email/raw body 非ログ | explain/pvp/webhook |
| **A10** SSRF | ユーザー URL fetch | Stripe/Gemini/Turnstile/GitHub は固定ホストのみ | Edge fetch 呼び出し |

## 課金固有

1. Test mode 完走まで live 鍵を入れない  
2. Cloudflare production デプロイは合意後のみ  
3. Webhook 再送は 200 + DB 冪等  
4. Tier 2（authz / cost / data）を push 前に通す  

## 意図的に残す / 次

- CSP の `style-src 'unsafe-inline'`（Tailwind/ランタイム style。将来 nonce 化を検討）  
- AdSense 導入時は CSP `script-src` / `frame-src` を最小追加  
- 運営用コストダッシュボード（GCP/Stripe UI で代替）
