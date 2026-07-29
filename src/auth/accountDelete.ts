/**
 * accountDelete.ts — 退会 Edge 呼び出し
 *
 * service_role は触らない。JWT + confirm: "DELETE" のみ。
 */
import { getSupabase, isAuthConfigured } from './supabaseClient';

export function isAccountDeleteConfigured(): boolean {
  return (
    isAuthConfigured() &&
    Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)
  );
}

export async function deleteMyAccount(): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anon) throw new Error('退会機能が未設定です');

  const supabase = await getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('ログインが必要です');

  const res = await fetch(`${url}/functions/v1/account-delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
  if (!res.ok) {
    const map: Record<string, string> = {
      unauthorized: 'ログインが必要です',
      'rate limited': 'しばらく待ってから再度お試しください',
      'confirmation required': '確認フレーズが一致しません',
      'delete failed': '退会処理に失敗しました',
      'service unavailable': 'しばらくしてから再度お試しください',
      'origin not allowed': 'この環境からは退会できません',
    };
    throw new Error(map[body.error ?? ''] ?? '退会に失敗しました');
  }
}
