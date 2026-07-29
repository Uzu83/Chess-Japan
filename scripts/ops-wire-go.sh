#!/usr/bin/env bash
# ops-wire-go.sh — GO 後の secrets 投入 + Edge デプロイ（値は環境変数から。ログに出さない）
#
# 使い方:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export STRIPE_SECRET_KEY=sk_test_...
#   export STRIPE_WEBHOOK_SECRET=whsec_...
#   export STRIPE_PRICE_ID=price_...
#   export GITHUB_FEEDBACK_TOKEN=github_pat_...   # または一時的に gh auth token
#   export FEEDBACK_FALLBACK_URL=https://forms.gle/...   # 任意
#   # TURNSTILE_SECRET / ALLOWED_ORIGINS は本番に既にあれば不要
#   bash scripts/ops-wire-go.sh
#
set -euo pipefail
PROJECT_REF="${SUPABASE_PROJECT_REF:-vpbixcwxjhmapcyaarbq}"
SITE_URL="${SITE_URL:-https://chess-japan.pages.dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() {
  local n="$1"
  if [ -z "${!n-}" ]; then
    echo "MISSING: $n" >&2
    exit 1
  fi
}

need SUPABASE_ACCESS_TOKEN
need STRIPE_SECRET_KEY
need STRIPE_WEBHOOK_SECRET
need STRIPE_PRICE_ID
need GITHUB_FEEDBACK_TOKEN

case "$STRIPE_SECRET_KEY" in
  sk_test_*) ;;
  sk_live_*)
    echo "REFUSING live Stripe key in this script. Use test keys; live needs separate STRIPE_ALLOW_LIVE=1 GO." >&2
    exit 1
    ;;
  *)
    echo "STRIPE_SECRET_KEY must start with sk_test_" >&2
    exit 1
    ;;
esac

echo "==> Setting secrets (names only logged)"
ARGS=(
  "STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET=$STRIPE_WEBHOOK_SECRET"
  "STRIPE_PRICE_ID=$STRIPE_PRICE_ID"
  "SITE_URL=$SITE_URL"
  "GITHUB_FEEDBACK_TOKEN=$GITHUB_FEEDBACK_TOKEN"
  "GITHUB_FEEDBACK_REPO=${GITHUB_FEEDBACK_REPO:-Uzu83/Chess-Japan}"
)
if [ -n "${FEEDBACK_FALLBACK_URL-}" ]; then
  ARGS+=("FEEDBACK_FALLBACK_URL=$FEEDBACK_FALLBACK_URL")
fi
if [ -n "${TURNSTILE_SECRET-}" ]; then
  ARGS+=("TURNSTILE_SECRET=$TURNSTILE_SECRET")
fi
if [ -n "${ALLOWED_ORIGINS-}" ]; then
  ARGS+=("ALLOWED_ORIGINS=$ALLOWED_ORIGINS")
else
  ARGS+=("ALLOWED_ORIGINS=https://chess-japan.pages.dev")
fi

supabase secrets set "${ARGS[@]}" --project-ref "$PROJECT_REF"

echo "==> Deploying Edge functions"
supabase functions deploy stripe-checkout --project-ref "$PROJECT_REF"
supabase functions deploy stripe-portal --project-ref "$PROJECT_REF"
supabase functions deploy stripe-webhook --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy explain --project-ref "$PROJECT_REF"
supabase functions deploy feedback --project-ref "$PROJECT_REF"

echo "==> Done. Next: login on production → Pro → Checkout (test card 4242…) → plan=pro"
echo "    Feedback: open dialog → send → GitHub Issue with feedback/<kind>"
