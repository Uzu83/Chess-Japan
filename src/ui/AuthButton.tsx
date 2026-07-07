/*
 * AuthButton.tsx — ヘッダー右上のログイン/アカウント UI
 *
 * 表示規則:
 *   disabled  → 何も描画しない(App の見た目が従来と完全同一 = 必須要件)
 *   anonymous → 「ログイン」ボタン(Google OAuth へ)
 *   loading   → 無効化した同ボタン(点滅などの演出は不要 — 一瞬なので静かに)
 *   signedIn  → 表示名 + クラウドレートのコンパクトなメニュー(ログアウト)
 *
 * 【2C-1 の意図的な制約 — 未来の担当者へ】
 * クラウドレートの表示はこのメニュー内だけ。PlayView の表示レートはローカルのまま
 * 一切触っていない。WHY: 2C-1 ではレート戦の結果はまだローカルにしか反映されない
 * (クラウド反映の配線は 2C-2)。PlayView の表示をクラウド値に切り替えると
 * 「表示はクラウド・更新はローカル」の嘘 UX になるため、あえて分離した。
 * 2C-2 でクラウド同期が入った時に初めて PlayView をクラウド値に切り替えること。
 */
import { useState } from 'react';
import { useAuth } from '../auth/authState';

export function AuthButton() {
  const { status, profile, signInWithGoogle, signOut, error } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  if (status === 'disabled') return null;

  if (status === 'anonymous' || status === 'loading') {
    return (
      <div className="flex items-center gap-2">
        {/* auth 操作の失敗(プロバイダ未設定・ネットワーク等)は静かにテキストで示す。
            title に全文(視覚的には省略されても hover/SR で読める)。 */}
        {error && (
          <span className="max-w-32 truncate text-xs text-red-600 dark:text-red-400" title={error}>
            ログイン失敗
          </span>
        )}
        <button
          type="button"
          disabled={status === 'loading'}
          onClick={() => void signInWithGoogle()}
          className="focus-ai min-h-9 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:border-ai hover:text-on-surface disabled:opacity-50"
        >
          {status === 'loading' ? '確認中…' : 'ログイン'}
        </button>
      </div>
    );
  }

  // signedIn
  const name = profile?.display_name ?? 'プレイヤー';
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => setMenuOpen((v) => !v)}
        className="focus-ai flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-on-surface transition-colors hover:border-ai"
      >
        {/* 名前は長くても崩れないよう truncate(サーバー側でも40字上限) */}
        <span className="max-w-28 truncate font-medium">{name}</span>
        {profile && (
          <span className="text-xs text-muted" title="クラウドに保存された内部レート">
            {profile.rating}
          </span>
        )}
      </button>

      {/* 外クリックで閉じる透明バックドロップ(監査ワークフロー指摘)。
          メニューより下(z-30 < z-40)に敷き、画面のどこを触っても閉じる。 */}
      {menuOpen && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 cursor-default"
        />
      )}
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 flex w-56 flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-xl"
        >
          <div className="text-xs text-muted">
            <p className="truncate font-medium text-on-surface">{name}</p>
            {profile && (
              <p className="mt-0.5">
                クラウドレート: <span className="font-semibold text-ai">{profile.rating}</span>
                <span className="ml-1">({profile.games}局)</span>
              </p>
            )}
            {/* 2C-2 までの正直な注記: 対局結果はまだ端末レートにのみ反映される */}
            <p className="mt-1 text-[11px] leading-relaxed text-subtle">
              対局結果の自動反映(クラウド同期)は次のアップデートで対応予定
            </p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void signOut();
            }}
            className="focus-ai min-h-9 rounded-lg border border-border px-3 text-left text-sm text-muted transition-colors hover:border-ai hover:text-on-surface"
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
