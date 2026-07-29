/**
 * turnstile.ts — siteverify + hostname 拘束（OWASP A04/A07）
 *
 * TURNSTILE_ALLOWED_HOSTNAMES: カンマ区切り。未設定時は ALLOWED_ORIGINS の host から導出。
 * どちらも空なら success のみ（dev）。hosted + 課金キー環境では呼び出し側が secret 必須。
 */

export async function verifyTurnstileToken(opts: {
  secret: string | undefined;
  token: string | null;
  ip: string;
  allowedHostnames: string[];
}): Promise<boolean> {
  if (!opts.secret) return true;
  if (!opts.token) return false;
  try {
    const form = new FormData();
    form.append('secret', opts.secret);
    form.append('response', opts.token);
    if (opts.ip && opts.ip !== 'unknown') form.append('remoteip', opts.ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean; hostname?: string };
    if (data.success !== true) return false;
    if (opts.allowedHostnames.length === 0) return true;
    const host = typeof data.hostname === 'string' ? data.hostname.toLowerCase() : '';
    return Boolean(host && opts.allowedHostnames.includes(host));
  } catch {
    return false;
  }
}

/** ALLOWED_ORIGINS（https://host）と TURNSTILE_ALLOWED_HOSTNAMES から hostname 一覧を作る。 */
export function resolveTurnstileHostnames(
  turnstileHostsEnv: string | undefined,
  allowedOriginsEnv: string | undefined,
): string[] {
  const fromEnv = (turnstileHostsEnv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  return (allowedOriginsEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*')
    .map((origin) => {
      try {
        return new URL(origin).hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/** explain と同じ IP 解決順: cf-connecting-ip → XFF 先頭 → unknown */
export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
