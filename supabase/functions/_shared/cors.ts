/**
 * cors.ts — Edge Function 共通 CORS（補助策。主防壁はレート/Turnstile/検証）
 *
 * OWASP A05: ALLOWED_ORIGINS 空＋hosted は fail-closed。任意 Origin を反射しない。
 */

export function resolveCors(opts: {
  origin: string | null;
  allowedOrigins: string[];
  isHosted: boolean;
  allowHeaders?: string;
}): { allowed: boolean; headers: Record<string, string> } {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      opts.allowHeaders ?? 'authorization, content-type, apikey, x-turnstile-token',
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
