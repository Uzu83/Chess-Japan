/**
 * billingSite.ts — Checkout/Portal の return URL 解決（オープンリダイレクト防止）
 *
 * OWASP A01: success_url / cancel_url / return_url にリクエスト Origin を使わない。
 * 許可は SITE_URL（必須・本番）または ALLOWED_ORIGINS の明示エントリのみ。
 */

export function resolveBillingSiteUrl(opts: {
  siteUrlEnv: string | undefined;
  allowedOriginsEnv: string | undefined;
  isHosted: boolean;
}): string | null {
  const fromSite = (opts.siteUrlEnv ?? '').trim().replace(/\/$/, '');
  if (fromSite && isHttpsOrigin(fromSite)) return fromSite;

  const allowed = (opts.allowedOriginsEnv ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter((s) => s.length > 0 && s !== '*');

  // 先頭の https オリジンのみ（ワイルドカード禁止）
  const first = allowed.find((o) => isHttpsOrigin(o));
  if (first) return first;

  // ローカル開発のみ http://localhost を許可
  if (!opts.isHosted) {
    const local = allowed.find((o) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o));
    if (local) return local;
    if (fromSite && /^http:\/\/(localhost|127\.0\.0\.1)/i.test(fromSite)) return fromSite;
  }

  return null;
}

function isHttpsOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}
