import { useState } from 'react';
import type { ExplanationContext } from '../core/types';
import { qualityLabelJa } from '../core/classify';

/*
 * ExplanationPanel — 解説・対話パネル
 *
 * 状態の網羅:
 *   1. context なし(手を選んでいない)  → EmptyState: 誘導メッセージ
 *   2. context あり・解説未取得        → 「解説する」ボタン
 *   3. busy(取得中)                   → スケルトンシマー
 *   4. 解説あり                       → 本文表示 + 追問UI
 *   5. エラー(explanation が "解説の取得に失敗:" で始まる) → エラー表示
 *
 * チャット吹き出し:
 *   user:      右寄せ / 藍サーフェス
 *   assistant: 左寄せ / surface-2
 *
 * a11y:
 *   - busy 中は aria-busy / aria-label で状態を伝える
 *   - エラーは role="alert"
 *   - 解説本文は role="article" で読み上げ単位を明示
 *
 * 追問チップ:
 *   min-h-9 でタップ領域確保。disabled 時はポインタイベントなし。
 *
 * モーション:
 *   スケルトンシマーは motion-safe のみ animate-pulse。
 *   prefers-reduced-motion: reduce で自動停止(Tailwind の motion-safe: 対応)。
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ExplanationPanelProps {
  context: ExplanationContext | null;
  explanation: string | null;
  thread: ChatTurn[];
  busy: boolean;
  onExplain: () => void;
  onAsk: (question: string) => void;
}

/** センチポーン → 表示用文字列。+/-符号付き。 */
function evalLabel(cp?: number): string {
  if (cp === undefined) return '—';
  if (Math.abs(cp) >= 99000) return cp > 0 ? '白詰み' : '黒詰み';
  const sign = cp > 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(1)}`;
}

/** 解説テキストがエラーメッセージかどうかを判定。 */
function isError(text: string): boolean {
  return text.startsWith('解説の取得に失敗');
}

const QUICK_QUESTIONS = ['どういうこと？', 'もっと簡単に', 'なぜ最善手なの？'];

/* ── サブコンポーネント ─────────────────────────────────── */

/** 手が選ばれていないときの誘導メッセージ。 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      {/* 将棋/チェスのシンボル的な装飾文字 */}
      <span className="text-3xl" aria-hidden="true">
        ♟
      </span>
      <p className="text-sm text-muted">
        棋譜を読み込み、手順表から手を選んで
        <br />
        「解説する」を押してください。
      </p>
    </div>
  );
}

/** 解説取得中のスケルトン。prefers-reduced-motion に配慮した animate-pulse 使用。 */
function SkeletonLoader() {
  return (
    <div role="status" aria-label="解説を取得中" aria-busy="true" className="flex flex-col gap-2">
      {[80, 100, 60, 90].map((w, i) => (
        <div
          key={i}
          /* motion-safe: で reduced-motion のユーザーにはシマーなし */
          className="h-3.5 rounded-full bg-washi-muted motion-safe:animate-pulse dark:bg-sumi-border"
          style={{ width: `${w}%` }}
          aria-hidden="true"
        />
      ))}
      <span className="sr-only">AI が解説を生成中です…</span>
    </div>
  );
}

/** 手の質バッジ(ExplanationPanel ヘッダー用に少し大きめ)。 */
function QualityBadge({ quality }: { quality: NonNullable<ExplanationContext['quality']> }) {
  const cls = {
    best: 'badge-best',
    good: 'badge-good',
    inaccuracy: 'badge-inaccuracy',
    mistake: 'badge-mistake',
    blunder: 'badge-blunder',
  }[quality];

  return (
    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {qualityLabelJa(quality)}
    </span>
  );
}

/* ── メインコンポーネント ─────────────────────────────── */

/** 現在の手の解説・対話パネル。 */
export function ExplanationPanel({
  context,
  explanation,
  thread,
  busy,
  onExplain,
  onAsk,
}: ExplanationPanelProps) {
  const [q, setQ] = useState('');

  /* 状態 1: context なし */
  if (!context) {
    return <EmptyState />;
  }

  const submit = () => {
    const text = q.trim();
    if (!text || busy) return;
    setQ('');
    onAsk(text);
  };

  const hasExplanation = Boolean(explanation);
  const showError = hasExplanation && isError(explanation!);

  return (
    <div className="flex flex-col gap-3">
      {/* ── 評価メタ情報 ── */}
      <div className="flex flex-wrap items-center gap-2">
        {context.quality && <QualityBadge quality={context.quality} />}

        <span className="text-xs text-muted">
          {evalLabel(context.evalBefore)} → {evalLabel(context.evalAfter)}
        </span>

        {context.bestMove && (
          <span className="text-xs text-subtle">
            最善: <span className="font-mono">{context.bestMove}</span>
          </span>
        )}
      </div>

      {/* ── 解説本文 / ローディング / アクションボタン ── */}
      {busy && !hasExplanation ? (
        /* 状態 3: 初回取得中 → スケルトン */
        <SkeletonLoader />
      ) : !hasExplanation ? (
        /* 状態 2: 未取得 → 解説ボタン */
        <button
          type="button"
          onClick={onExplain}
          disabled={busy}
          className="focus-ai self-start rounded-lg bg-ai px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ai-hover disabled:cursor-not-allowed disabled:opacity-50 dark:bg-ai-dim dark:hover:bg-ai"
        >
          この手を解説する
        </button>
      ) : showError ? (
        /* 状態 5: エラー
           q-miss-* 変数は @theme 外の CSS 変数のため Tailwind 任意値で参照する。
           落ち着いた柿色(kaki)で非常事態感を抑えた表現に。                       */
        <div
          role="alert"
          className="rounded-lg p-3 text-sm"
          style={{
            backgroundColor: 'var(--q-miss-bg)',
            color: 'var(--q-miss-fg)',
          }}
        >
          <p className="font-medium">解説を取得できませんでした</p>
          <p className="mt-1 text-xs opacity-80">
            しばらく経ってから「この手を解説する」を再試行してください。
          </p>
        </div>
      ) : (
        /* 状態 4: 解説あり */
        <div
          role="article"
          aria-label="AI解説"
          /* 解説テキストは主役 — 読みやすさ最優先のタイポ設定:
             leading-relaxed: 行間を広め(日本語の可読性向上)
             tracking-wide: 字間を少し広げる(ゆったりした印象)
             max-w: 解説パネルの幅内で行長を適切に収める             */
          className="whitespace-pre-wrap rounded-xl bg-surface p-4 text-sm leading-relaxed tracking-wide text-on-surface"
        >
          {explanation}
        </div>
      )}

      {/* ── チャットスレッド(追問の吹き出し) ── */}
      {thread.length > 0 && (
        <div className="flex flex-col gap-2">
          {thread.map((t, i) => (
            <div
              key={i}
              className={[
                'max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed',
                t.role === 'user'
                  ? /* ユーザー: 右寄せ / 藍サーフェス */
                    'self-end bg-ai-bg text-ai'
                  : /* アシスタント: 左寄せ / surface-2 */
                    'self-start bg-surface text-on-surface',
              ].join(' ')}
            >
              {t.content}
            </div>
          ))}

          {/* 追問取得中: 吹き出し内スケルトン */}
          {busy && (
            <div className="self-start max-w-[85%] rounded-xl bg-surface p-3">
              <SkeletonLoader />
            </div>
          )}
        </div>
      )}

      {/* ── 追問 UI(解説取得後のみ表示) ── */}
      {hasExplanation && !showError && (
        <div className="flex flex-col gap-2 pt-1">
          {/* クイック質問チップ */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_QUESTIONS.map((qq) => (
              <button
                key={qq}
                type="button"
                onClick={() => onAsk(qq)}
                disabled={busy}
                /* min-h-9: 36px タップ領域。チップは小さいが間隔で補う。 */
                className="focus-ai min-h-9 rounded-full border border-border px-3 text-xs text-muted transition-colors hover:border-ai hover:text-ai disabled:pointer-events-none disabled:opacity-40"
              >
                {qq}
              </button>
            ))}
          </div>

          {/* 自由入力フォーム */}
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="質問する（例: ピンって何？）"
              disabled={busy}
              aria-label="追加の質問を入力"
              className="min-h-10 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-on-surface placeholder:text-subtle focus:border-ai focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={submit}
              disabled={busy || !q.trim()}
              aria-label="質問を送信"
              className="focus-ai min-h-10 min-w-10 rounded-lg border border-border px-3 text-sm font-medium text-on-surface transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
            >
              送信
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
