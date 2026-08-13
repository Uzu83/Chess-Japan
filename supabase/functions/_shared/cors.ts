/**
 * cors.ts — Edge Function 共通 CORS（補助策。主防壁はレート/Turnstile/検証）
 *
 * OWASP A05: ALLOWED_ORIGINS 空＋hosted は fail-closed。任意 Origin を反射しない。
 */

/*
 * WHY apikey を落とさないか:
 *   ログイン中のクライアントは Authorization（user JWT）に加えて apikey（anon）を付ける
 *   （Pro 枠の解決・Supabase gateway 慣習。billing/pvp/explain が同型）。
 *   Access-Control-Allow-Headers から apikey を外すと、ブラウザの preflight が失敗し、
 *   HTTP 本文（403 等）は隠されて TypeError: Failed to fetch だけが UI に出る。
 *   初回ログイン直後の解説で実害（試合未実施が原因ではない）。上書きする関数は
 *   この定数を使うか、必ず apikey を残すこと。
 */
export const DEFAULT_CORS_ALLOW_HEADERS = 'authorization, content-type, apikey, x-turnstile-token';

export function resolveCors(opts: {
  origin: string | null;
  allowedOrigins: string[];
  isHosted: boolean;
  allowHeaders?: string;
}): { allowed: boolean; headers: Record<string, string> } {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': opts.allowHeaders ?? DEFAULT_CORS_ALLOW_HEADERS,
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  const list = opts.allowedOrigins;
  if (list.includes('*')) {
    return {
      allowed: true,
      headers: { ...base, 'Access-Control-Allow-Origin': opts.origin ?? '*' },
    };
  }
  if (list.length === 0) {
    if (!opts.isHosted) {
      return {
        allowed: true,
        headers: { ...base, 'Access-Control-Allow-Origin': opts.origin ?? '*' },
      };
    }
    return { allowed: false, headers: { ...base, 'Access-Control-Allow-Origin': 'null' } };
  }
  if (opts.origin && list.includes(opts.origin)) {
    return { allowed: true, headers: { ...base, 'Access-Control-Allow-Origin': opts.origin } };
  }
  // Origin 無し（curl 等）は CORS では弾かず、認証・レート側で受ける。
  if (!opts.origin) return { allowed: true, headers: base };
  return { allowed: false, headers: { ...base, 'Access-Control-Allow-Origin': 'null' } };
}
