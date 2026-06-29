import { useState } from 'react';
import type { ExplanationContext } from '../core/types';
import { qualityLabelJa } from '../core/classify';

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

function evalLabel(cp?: number): string {
  if (cp === undefined) return '—';
  const sign = cp > 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(1)}`;
}

const QUICK_QUESTIONS = ['どういうこと？', 'もっと簡単に', 'なぜ最善手なの？'];

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

  if (!context) {
    return (
      <div className="text-sm text-slate-500">
        棋譜を読み込み、手を選ぶと解析と解説が表示されます。
      </div>
    );
  }

  const submit = () => {
    const text = q.trim();
    if (!text) return;
    setQ('');
    onAsk(text);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {context.quality && (
          <span className="rounded bg-slate-200 px-2 py-0.5 font-medium dark:bg-slate-700">
            {qualityLabelJa(context.quality)}
          </span>
        )}
        <span className="text-slate-500">
          評価: {evalLabel(context.evalBefore)} → {evalLabel(context.evalAfter)}
        </span>
        {context.bestMove && <span className="text-slate-500">最善: {context.bestMove}</span>}
      </div>

      {!explanation ? (
        <button
          onClick={onExplain}
          disabled={busy}
          className="self-start rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? '解説中…' : 'この手を解説する'}
        </button>
      ) : (
        <p className="whitespace-pre-wrap rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">
          {explanation}
        </p>
      )}

      {thread.length > 0 && (
        <div className="flex flex-col gap-2">
          {thread.map((t, i) => (
            <div
              key={i}
              className={`rounded-lg p-2 text-sm ${
                t.role === 'user'
                  ? 'self-end bg-indigo-100 dark:bg-indigo-900'
                  : 'self-start bg-slate-100 dark:bg-slate-800'
              }`}
            >
              {t.content}
            </div>
          ))}
        </div>
      )}

      {explanation && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            {QUICK_QUESTIONS.map((qq) => (
              <button
                key={qq}
                onClick={() => onAsk(qq)}
                disabled={busy}
                className="rounded-full border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-200 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
              >
                {qq}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="質問する（例: ピンって何？）"
              className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
            />
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-md bg-slate-700 px-3 py-1 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
            >
              送信
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
