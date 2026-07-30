/*
 * ProUpgradeDialog.tsx — Pro の価格納得感（塾・コーチング比較）
 *
 * 相場の根拠（目安・2025–26 公開料金から）:
 *   - チェス個人レッスン: だいたい 1回 ¥1,500〜3,000（30–60分）
 *   - 将棋オンライン個人: 体験〜単発 ¥1,000〜2,000、月4回で数千〜1万円台も
 * Pro ¥480/月は「先生の代わり」ではなく「いつでも棋譜を振り返る補助」として安さを伝える。
 * 誇大比較を避けるため具体校名・「◯倍安い」断定は出さない。
 */
import { createPortal } from 'react-dom';

export function ProUpgradeDialog({
  open,
  onClose,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain">
      <div className="flex min-h-full items-center justify-center p-4 py-8">
        <button
          type="button"
          aria-label="閉じる"
          className="absolute inset-0 bg-[color:color-mix(in_oklab,var(--color-ink)_50%,transparent)] backdrop-blur-[3px]"
          onClick={onClose}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pro-upgrade-title"
          className="relative z-10 w-full max-w-md animate-[fade-rise_220ms_ease-out] rounded-3xl border border-border bg-surface p-6 shadow-card-hover"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="font-display text-[11px] tracking-[0.18em] text-subtle uppercase">
                Chess-Japan Pro
              </p>
              <h2
                id="pro-upgrade-title"
                className="mt-1 font-display text-xl tracking-tight text-on-surface"
              >
                月額 ¥480 で、いつでも1手解説
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="focus-ai rounded-lg px-2 py-1 text-sm text-muted hover:text-on-surface"
            >
              閉じる
            </button>
          </div>

          <p className="text-sm leading-relaxed text-muted">
            オンラインの個人レッスンは、チェス・将棋ともだいたい
            <span className="font-medium text-on-surface"> 1回 ¥1,500〜3,000 </span>
            が目安。月に数回通うと数千〜1万円台になりがちです。
          </p>

          <div className="mt-4 rounded-2xl border border-border bg-surface-2 px-4 py-3">
            <p className="text-xs text-muted">Chess-Japan Pro</p>
            <p className="mt-0.5 font-display text-2xl tracking-tight text-on-surface">
              ¥480
              <span className="ml-1 text-sm font-sans font-normal text-muted">/ 月</span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-subtle">
              レッスン1回分より安く、毎日の振り返りに使える感覚です。
            </p>
          </div>

          <ul className="mt-4 space-y-2 text-sm text-on-surface">
            <li className="flex gap-2">
              <span className="text-ai" aria-hidden="true">
                ·
              </span>
              <span>深掘り解説 月30回（より詳しい一手解説）</span>
            </li>
            <li className="flex gap-2">
              <span className="text-ai" aria-hidden="true">
                ·
              </span>
              <span>通常解説の Flash 枠が厚め（毎日の復習向け）</span>
            </li>
            <li className="flex gap-2">
              <span className="text-ai" aria-hidden="true">
                ·
              </span>
              <span>いつでも解約可（Customer Portal）</span>
            </li>
          </ul>

          <p className="mt-4 text-[11px] leading-relaxed text-subtle">
            人間の先生の対局指導やカリキュラムの代わりではありません。自分の棋譜を、すきま時間で振り返るためのプランです。
          </p>

          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="focus-ai mt-5 min-h-11 w-full rounded-xl bg-ai px-3 text-sm font-medium text-white shadow-btn transition hover:bg-ai-hover disabled:opacity-50"
          >
            {busy ? '決済ページへ…' : 'とりあえず始めてみる'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="focus-ai mt-2 min-h-11 w-full rounded-xl text-sm text-muted hover:text-on-surface"
          >
            今は無料のまま続ける
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
