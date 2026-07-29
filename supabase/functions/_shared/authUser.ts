/**
 * authUser.ts — Authorization Bearer から Supabase ユーザーを解決（Deno Edge）
 *
 * WHY: pvp/index.ts の getUser と同型。explain / stripe-checkout / portal で共有。
 */

export type AuthUser = { id: string; email: string | null; emailConfirmed: boolean };

export async function getAuthUser(
  req: Request,
  opts: {
    supabaseUrl: string | undefined;
    anonKey: string | undefined;
    serviceRoleKey: string | undefined;
  },
): Promise<AuthUser | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token || !opts.supabaseUrl) return null;
  // OWASP A07: anon / publishable key を「ユーザー」として通さない。
  if (!looksLikeUserJwt(token, opts.anonKey)) return null;
  if (opts.serviceRoleKey && token === opts.serviceRoleKey) return null;
  // ユーザー JWT の検証には anon でも service_role でも可（Authorization がユーザー JWT）。
  const key = opts.anonKey || opts.serviceRoleKey;
  if (!key) return null;
  try {
    const res = await fetch(`${opts.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      id?: string;
      email?: string | null;
      email_confirmed_at?: string | null;
    };
    if (typeof body.id !== 'string') return null;
    return {
      id: body.id,
      email: typeof body.email === 'string' ? body.email : null,
      emailConfirmed: Boolean(body.email_confirmed_at),
    };
  } catch {
    return null;
  }
}

/** anon key（JWT っぽいがユーザーでない）を除外する補助。 */
export function looksLikeUserJwt(token: string, anonKey: string | undefined): boolean {
  if (!token) return false;
  if (anonKey && token === anonKey) return false;
  // Supabase user JWT は通常 3 セグメント。anon も JWT だが checkout では明示比較する。
  return token.split('.').length === 3 && token !== anonKey;
}
