/*
 * PrivacySettings.tsx — プレイ分析の公開設定（既定: 非公開）
 *
 * 公開 RPC は粗い要約のみ（F007）。20局未満はサーバーが拒否。
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/authState';
import { getMyProfile } from '../auth/profile';
import { getSupabase } from '../auth/supabaseClient';

export function PrivacySettings() {
  const { profile } = useAuth();
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [handle, setHandle] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setVisibility(profile.strength_visibility === 'public' ? 'public' : 'private');
    setHandle(profile.public_handle ?? '');
  }, [profile]);

  const publicUrl =
    visibility === 'public' && handle.trim()
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}?strength=${encodeURIComponent(handle.trim().toLowerCase())}`
      : null;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const supabase = await getSupabase();
      const { error } = await supabase.rpc('set_strength_visibility', {
        p_visibility: visibility,
        p_handle: visibility === 'public' ? handle.trim().toLowerCase() : null,
      });
      if (error) throw new Error(error.message);
      // AuthContext に refresh が無いので再取得してローカル state を同期
      const refreshed = await getMyProfile();
      if (refreshed) {
        setVisibility(refreshed.strength_visibility === 'public' ? 'public' : 'private');
        setHandle(refreshed.public_handle ?? '');
      }
      setMsg(visibility === 'public' ? '公開設定を保存しました' : '非公開にしました');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-on-surface">公開設定</h3>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        既定は非公開です。公開しても user_id・棋譜・相手情報は出ません。粗い活動量バケットのみ。
        公開には確認済みメールと、サーバー検証済み（verified）対局がおおよそ20局以上必要です。
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name="vis"
            checked={visibility === 'private'}
            onChange={() => setVisibility('private')}
          />
          非公開
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name="vis"
            checked={visibility === 'public'}
            onChange={() => setVisibility('public')}
          />
          公開
        </label>
      </div>
      {visibility === 'public' && (
        <label className="mt-2 block text-xs text-muted">
          公開ハンドル（英小文字・数字・_ / 3–24字）
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            className="focus-ai mt-1 min-h-11 w-full max-w-xs rounded-lg border border-border px-3 text-sm text-on-surface"
            placeholder="e.g. yane_fan"
          />
        </label>
      )}
      {publicUrl && (
        <p className="mt-2 text-xs text-muted">
          公開 URL:{' '}
          <a href={publicUrl} className="text-ai underline break-all">
            {publicUrl}
          </a>
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        className="focus-ai mt-3 min-h-11 rounded-lg border border-border px-3 text-sm font-medium text-muted hover:border-ai hover:text-on-surface disabled:opacity-50"
      >
        設定を保存
      </button>
      {msg && (
        <p className="mt-2 text-xs text-muted" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
