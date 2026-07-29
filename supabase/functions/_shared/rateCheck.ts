/**
 * rateCheck.ts — rate_check RPC 呼び出し（fail-closed）
 *
 * RPC 契約（0003）: `rate_check(...) returns boolean`（オブジェクトではない）。
 * explain/index.ts のローカル実装と同型。
 */

export type RateCheckResult = 'ok' | 'limited' | 'error';

export async function rateCheck(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateCheckResult> {
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
    if (!res.ok) return 'error';
    const allowed = await res.json();
    return allowed === true ? 'ok' : 'limited';
  } catch {
    return 'error';
  }
}
