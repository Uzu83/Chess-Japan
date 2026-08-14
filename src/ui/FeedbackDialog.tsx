/*
 * FeedbackDialog.tsx — アプリ内フィードバック送信
 *
 * 受信箱は feedback-adcd2（非公開 Firestore）。公開 GitHub Issue には載せない。
 * 障害時のみ VITE_FEEDBACK_URL（Google Form）へ誘導。
 * 局面欄は対局/レビューが登録した FEN/SFEN をプリフィル（編集可）。
 */
import { useEffect, useState } from 'react';
import { formatFeedbackBoardPaste, getFeedbackBoardContext } from '../feedback/boardContext';
import {
  CHESS_FEEDBACK_KINDS,
  FEEDBACK_BROWSERS,
  FEEDBACK_DEVICES,
  submitFeedback,
  type ChessFeedbackKind,
  type FeedbackBrowser,
  type FeedbackDevice,
} from '../feedback/client';

const KIND_LABELS: Record<ChessFeedbackKind, string> = {
  bug: 'バグ報告',
  feature: '機能のリクエスト',
  explain_quality: '解説の品質',
  ux: '使いやすさ (UI/UX)',
  other: 'その他',
};

const DEVICE_LABELS: Record<FeedbackDevice, string> = {
  phone: 'スマホ',
  tablet: 'タブレット',
  pc: 'PC',
};

const BROWSER_LABELS: Record<FeedbackBrowser, string> = {
  chrome: 'Chrome',
  safari: 'Safari',
  firefox: 'Firefox',
  edge: 'Edge',
  other: 'その他',
};

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<ChessFeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [repro, setRepro] = useState('');
  const [boardPaste, setBoardPaste] = useState('');
  const [device, setDevice] = useState<FeedbackDevice | ''>('');
  const [browser, setBrowser] = useState<FeedbackBrowser | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  // open のたびに局面スナップショットをプリフィル（前回送信の残骸は捨てる）。
  useEffect(() => {
    if (!open) return;
    setBoardPaste(formatFeedbackBoardPaste(getFeedbackBoardContext()));
    setError(null);
    setSent(false);
    setFallbackUrl(null);
  }, [open]);

  if (!open) return null;

  const disabled = busy || sent;

  const resetAndClose = () => {
    setKind('bug');
    setMessage('');
    setRepro('');
    setBoardPaste('');
    setDevice('');
    setBrowser('');
    setBusy(false);
    setError(null);
    setSent(false);
    setFallbackUrl(null);
    onClose();
  };

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    setFallbackUrl(null);
    try {
      const result = await submitFeedback({
        kind,
        message,
        repro: repro.trim() || undefined,
        boardPaste: boardPaste.trim() || undefined,
        device: device || undefined,
        browser: browser || undefined,
      });
      if (result.ok) {
        setSent(true);
        return;
      }
      setError(result.error);
      if (result.fallbackUrl) setFallbackUrl(result.fallbackUrl);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-black/40"
        onClick={resetAndClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        className="relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 id="feedback-dialog-title" className="text-base font-semibold text-on-surface">
            フィードバック
          </h2>
          <button
            type="button"
            onClick={resetAndClose}
            className="focus-ai rounded px-2 py-1 text-sm text-muted hover:text-on-surface"
          >
            閉じる
          </button>
        </div>

        {sent ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-on-surface">送信しました。ありがとうございます。</p>
            <button
              type="button"
              onClick={resetAndClose}
              className="focus-ai min-h-11 rounded-lg bg-ai px-3 text-sm font-medium text-white"
            >
              閉じる
            </button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
          >
            <p className="text-xs text-muted">
              送信内容は非公開で、オーナーだけが読みます。個人情報や秘密情報は書かないでください。
            </p>

            <label className="block text-xs text-muted">
              種類（必須）
              <select
                value={kind}
                disabled={disabled}
                onChange={(e) => setKind(e.target.value as ChessFeedbackKind)}
                className="focus-ai mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-on-surface"
              >
                {CHESS_FEEDBACK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-muted">
              内容（必須）
              <textarea
                value={message}
                disabled={disabled}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                required
                maxLength={2000}
                className="focus-ai mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
                placeholder="できるだけ具体的に書いてください"
              />
            </label>

            <label className="block text-xs text-muted">
              再現手順（任意・バグ時）
              <textarea
                value={repro}
                disabled={disabled}
                onChange={(e) => setRepro(e.target.value)}
                rows={2}
                maxLength={2000}
                className="focus-ai mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              />
            </label>

            <label className="block text-xs text-muted">
              局面・棋譜（任意・FEN / SFEN / PGN / KIF）
              <textarea
                value={boardPaste}
                disabled={disabled}
                onChange={(e) => setBoardPaste(e.target.value)}
                rows={2}
                maxLength={4000}
                className="focus-ai mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-on-surface"
                placeholder="対局・レビュー中なら自動で入ります。編集・消去して構いません"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-muted">
                端末（任意）
                <select
                  value={device}
                  disabled={disabled}
                  onChange={(e) => setDevice(e.target.value as FeedbackDevice | '')}
                  className="focus-ai mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
                >
                  <option value="">—</option>
                  {FEEDBACK_DEVICES.map((d) => (
                    <option key={d} value={d}>
                      {DEVICE_LABELS[d]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted">
                ブラウザ（任意）
                <select
                  value={browser}
                  disabled={disabled}
                  onChange={(e) => setBrowser(e.target.value as FeedbackBrowser | '')}
                  className="focus-ai mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
                >
                  <option value="">—</option>
                  {FEEDBACK_BROWSERS.map((b) => (
                    <option key={b} value={b}>
                      {BROWSER_LABELS[b]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {error && (
              <div className="flex flex-col gap-2" role="status">
                <p className="text-xs text-[var(--q-miss-fg)]">{error}</p>
                {fallbackUrl && (
                  <a
                    href={fallbackUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ai inline-flex min-h-11 items-center justify-center rounded-lg bg-ai px-3 text-sm font-medium text-white"
                  >
                    Google Formで送る
                  </a>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={disabled || !message.trim()}
              className="focus-ai min-h-11 rounded-lg bg-ai px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? '送信中…' : '送信する'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
