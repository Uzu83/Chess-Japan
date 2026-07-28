/**
 * rateCheck.ts — rate_check RPC 呼び出し（fail-closed）
 *
 * OWASP A04: 濫用時は拒否。DB/RPC 失敗も allow=false。
 */

export async function rateCheck(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ allow: boolean; count: number }> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/rate_check`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: windowSec }),
    });
    if (!res.ok) return { allow: false, count: -1 };
    const row = (await res.json()) as { allow?: boolean; count?: number } | null;
    if (!row || typeof row.allow !== 'boolean') return { allow: false, count: -1 };
    return { allow: row.allow, count: typeof row.count === 'number' ? row.count : -1 };
  } catch {
    return { allow: false, count: -1 };
  }
}
