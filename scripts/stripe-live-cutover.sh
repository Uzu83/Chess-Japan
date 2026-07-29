#!/usr/bin/env bash
# stripe-live-cutover.sh — sk_live を渡して本番課金へ切替（値はログに出さない）
#
# 前提: live Product/Price/Webhook は作成済み
#   Price: price_1TyXaWKCiN6d8Aij9O3Wl7VZ (lookup chess_japan_pro_monthly_live)
#   Webhook: Chess-Japan production billing → stripe-webhook
#
# 使い方:
#   export STRIPE_SECRET_KEY=sk_live_...
#   # 任意: STRIPE_WEBHOOK_SECRET=whsec_... （未指定なら /tmp/cj-stripe-live-partial.env）
#   bash scripts/stripe-live-cutover.sh
#
set -euo pipefail
PROJECT_REF="${SUPABASE_PROJECT_REF:-vpbixcwxjhmapcyaarbq}"
LIVE_PRICE_ID="${STRIPE_PRICE_ID:-price_1TyXaWKCiN6d8Aij9O3Wl7VZ}"
SITE_URL="${SITE_URL:-https://chess-japan.pages.dev}"

if [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  echo "MISSING: STRIPE_SECRET_KEY (sk_live_...)" >&2
  exit 1
fi
case "$STRIPE_SECRET_KEY" in
  sk_live_*) ;;
  *)
    echo "REFUSING: STRIPE_SECRET_KEY must be sk_live_ for cutover" >&2
    exit 1
    ;;
esac

if [ -z "${STRIPE_WEBHOOK_SECRET:-}" ] && [ -f /tmp/cj-stripe-live-partial.env ]; then
  # shellcheck disable=SC1091
  source /tmp/cj-stripe-live-partial.env
fi
if [ -z "${STRIPE_WEBHOOK_SECRET:-}" ] || [[ "$STRIPE_WEBHOOK_SECRET" != whsec_* ]]; then
  echo "MISSING: STRIPE_WEBHOOK_SECRET (live endpoint signing secret)" >&2
  exit 1
fi

echo "==> Setting live Stripe secrets (names only)"
supabase secrets set \
  "STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY" \
  "STRIPE_WEBHOOK_SECRET=$STRIPE_WEBHOOK_SECRET" \
  "STRIPE_PRICE_ID=$LIVE_PRICE_ID" \
  "STRIPE_ALLOW_LIVE=1" \
  "SITE_URL=$SITE_URL" \
  --project-ref "$PROJECT_REF"

echo "==> Redeploy billing functions"
supabase functions deploy stripe-checkout --project-ref "$PROJECT_REF"
supabase functions deploy stripe-portal --project-ref "$PROJECT_REF"
supabase functions deploy stripe-webhook --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy explain --project-ref "$PROJECT_REF"
supabase functions deploy account-delete --project-ref "$PROJECT_REF"

echo "OK: live cutover done. Verify with real card → Portal cancel."
