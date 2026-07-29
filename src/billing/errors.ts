/*
 * Stripe Checkout / Portal Edge の error → ユーザー向け日本語。
 */

const BODY_JA: Record<string, string> = {
  'rate limited': 'アクセスが集中しています。しばらくしてから再試行してください',
  'rate limiter unavailable': '一時的に利用できません。しばらくしてから再試行してください',
  unauthorized: 'ログインが必要です',
  'email not confirmed': 'メールアドレスの確認が完了していません。確認メールをご確認ください',
  'billing not configured': '決済の準備中です。しばらくお待ちください',
  'SITE_URL not configured': '決済の準備中です。しばらくお待ちください',
  'service unavailable': '決済サービスが一時的に利用できません',
  'profile missing': 'プロフィールの準備ができていません。一度ログアウトして再ログインしてください',
  'already subscribed': 'すでに Pro に登録済みです',
  'origin not allowed': 'このページからの決済は許可されていません',
  'method not allowed': '不正なリクエストです',
  'checkout session missing url': '決済ページの作成に失敗しました',
  'no stripe customer': 'サブスク管理の準備ができていません。先に Pro 登録してください',
  'portal session missing url': '管理ページの作成に失敗しました',
};

export function formatBillingApiError(status: number, bodyError?: string | null): string {
  const trimmed = bodyError?.trim();
  if (trimmed) {
    const mapped = BODY_JA[trimmed];
    if (mapped) return mapped;
    if (trimmed.length <= 200) return trimmed;
  }
  if (status === 401) return BODY_JA.unauthorized!;
  if (status === 429) return BODY_JA['rate limited']!;
  if (status === 409) return BODY_JA['already subscribed']!;
  if (status === 503) return BODY_JA['service unavailable']!;
  return `決済処理に失敗しました（${status}）`;
}
