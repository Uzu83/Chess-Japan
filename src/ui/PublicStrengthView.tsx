/*
 * PublicStrengthView.tsx — 公開プロフィール（?strength=handle）
 *
 * RPC は粗いバケットのみ返す（F007）。accuracy_bucket 等はプレースホルダのため
 * 「準備中」と明示し、活動量バケットだけ見せる。
 */
import { useEffect, useState } from 'react';
import { getPublicStrength, type PublicStrengthSummary } from '../auth/games';

function isDetailPending(summary: PublicStrengthSummary): boolean {
  if (!summary.accuracy_bucket || summary.accuracy_bucket === 'not_available') return true;
  if (summary.top_strengths.length === 0 && summary.top_weaknesses.length === 0) return true;
  return false;
}

export function PublicStrengthView({ handle, onBack }: { handle: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<PublicStrengthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getPublicStrength(handle);
        if (!cancelled) setSummary(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handle]);

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ai">公開プレイ分析</h2>
        <button
          type="button"
          onClick={onBack}
          className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm text-muted hover:border-ai hover:text-on-surface"
        >
          戻る
        </button>
      </div>

      <p className="mb-4 text-xs text-muted">
        ハンドル: <span className="font-medium text-on-surface">{handle}</span>
      </p>

      {loading && <p className="text-sm text-muted">読み込み中…</p>}

      {!loading && error && (
        <p className="text-sm text-[var(--q-miss-fg)]" role="status">
          {error}
        </p>
      )}

      {!loading && !error && !summary && (
        <p className="text-sm text-muted">このハンドルは見つからないか、非公開です。</p>
      )}

      {summary && (
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-border p-4">
            <h3 className="mb-2 text-sm font-semibold text-on-surface">活動量</h3>
            <p className="text-sm text-on-surface">
              対局数バケット: <span className="font-semibold text-ai">{summary.games_bucket}</span>
            </p>
          </section>

          {isDetailPending(summary) ? (
            <p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
              準備中（公開中は活動量バケットのみ）
            </p>
          ) : (
            <section className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-on-surface">得意（参考）</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-on-surface">
                  {summary.top_strengths.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-on-surface">苦手（参考）</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-on-surface">
                  {summary.top_weaknesses.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
