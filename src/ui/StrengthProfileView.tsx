/*
 * StrengthProfileView.tsx — 自分用の得意/苦手プレイ分析（非公開・未検証）
 *
 * データは端末解析 + 任意のクラウド自己履歴（trust_level=unverified）。
 * 公開・レートには使わない（ADR 0002 / Codex F001）。
 */
import { useEffect, useMemo, useState } from 'react';
import { listMyCloudGames, type AnalysisPayload, type CloudGame } from '../auth/games';
import { isAuthConfigured } from '../auth/supabaseClient';
import { useAuth } from '../auth/authState';
import { loadPlayedGames, loadContextsFromStorage, hashPgn, playedGameKind } from '../core/storage';
import { ChessGame } from '../core/game';
import { buildAnalysisPayload } from '../auth/cloudSync';
import {
  aggregateStrength,
  type AnalyzedPly,
  type StrengthReport,
} from '../core/strengthAggregator';
import type { MoveQuality } from '../core/types';
import type { GamePhase } from '../core/phase';
import type { PlaystyleTag } from '../core/playstyle';
import { phaseLabelJa } from '../core/phase';
import { PrivacySettings } from './PrivacySettings';

function payloadToPlies(payload: AnalysisPayload | null | undefined): AnalyzedPly[] {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.plies)) return [];
  const out: AnalyzedPly[] = [];
  for (const p of payload.plies) {
    if (!p || typeof p.ply !== 'number' || !p.quality) continue;
    out.push({
      ply: p.ply,
      color: p.color === 'b' ? 'b' : 'w',
      isUserMove: Boolean(p.isUserMove),
      quality: p.quality as MoveQuality,
      phase: (p.phase as GamePhase) || 'middlegame',
      tags: Array.isArray(p.tags) ? (p.tags as PlaystyleTag[]) : [],
      evalBefore: p.evalBefore,
      evalAfter: p.evalAfter,
    });
  }
  return out;
}

async function collectLocalPlies(): Promise<AnalyzedPly[]> {
  const games = loadPlayedGames();
  const all: AnalyzedPly[] = [];
  for (const g of games) {
    if (g.moveCount <= 0) continue;
    const kind = playedGameKind(g);
    // 将棋の KIF→moves は動的 import が必要。初版はチェス履歴のみローカル集計。
    if (kind !== 'chess') continue;
    try {
      const model = ChessGame.fromPgn(g.pgn);
      const ctx = loadContextsFromStorage(hashPgn(g.pgn));
      if (!ctx || Object.keys(ctx).length === 0) continue;
      const payload = buildAnalysisPayload({
        kind: 'chess',
        youColor: g.youColor,
        contexts: ctx,
        moves: model.moves,
      });
      all.push(...payloadToPlies(payload));
    } catch {
      // 壊れた棋譜はスキップ
    }
  }
  return all;
}

export function StrengthProfileView({ onBack }: { onBack: () => void }) {
  const { status } = useAuth();
  const [cloud, setCloud] = useState<CloudGame[]>([]);
  const [localPlies, setLocalPlies] = useState<AnalyzedPly[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const local = await collectLocalPlies();
      if (cancelled) return;
      setLocalPlies(local);
      if (status === 'signedIn' && isAuthConfigured()) {
        const rows = await listMyCloudGames(100);
        if (!cancelled) setCloud(rows);
      } else {
        setCloud([]);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const report: StrengthReport | null = useMemo(() => {
    const fromCloud: AnalyzedPly[] = [];
    for (const g of cloud) {
      fromCloud.push(...payloadToPlies(g.analysis_payload as AnalysisPayload | null));
    }
    // クラウドとローカルを結合（ローカル消失より二重計上の方がマシ）
    const plies = [...fromCloud, ...localPlies];
    if (plies.length === 0) return null;
    return aggregateStrength(plies);
  }, [cloud, localPlies]);

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ai">プレイ分析</h2>
        <button
          type="button"
          onClick={onBack}
          className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm text-muted hover:border-ai hover:text-on-surface"
        >
          戻る
        </button>
      </div>

      <p className="mb-4 rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
        この分析は端末のエンジン解析に基づく
        <strong className="font-medium text-on-surface">自己用の参考記録</strong>
        です。改ざん可能な未検証データのため、公開ランキングやレートには使いません。
      </p>

      {loading && <p className="text-sm text-muted">読み込み中…</p>}

      {!loading && !report && (
        <p className="text-sm text-muted">
          まだ集計できる解析がありません。AI戦のあとレビューで全手解析するとここに反映されます（チェス）。
        </p>
      )}

      {report && (
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-on-surface">概要</h3>
            <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <li className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted">解析手数</p>
                <p className="text-lg font-semibold text-ai">{report.userMoveCount}</p>
              </li>
              <li className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted">精度スコア</p>
                <p className="text-lg font-semibold text-ai">{report.accuracyScore}</p>
              </li>
              <li className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted">悪手率</p>
                <p className="text-lg font-semibold text-ai">
                  {Math.round(report.blunderRate * 100)}%
                </p>
              </li>
              <li className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted">クラウド局</p>
                <p className="text-lg font-semibold text-ai">{cloud.length}</p>
              </li>
            </ul>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-on-surface">得意（参考）</h3>
              {report.strengths.length === 0 ? (
                <p className="text-xs text-muted">まだ十分な標本がありません</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm text-on-surface">
                  {report.strengths.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-on-surface">苦手（参考）</h3>
              {report.weaknesses.length === 0 ? (
                <p className="text-xs text-muted">まだ十分な標本がありません</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm text-on-surface">
                  {report.weaknesses.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-on-surface">局面フェーズ別</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[20rem] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-1 pr-2">フェーズ</th>
                    <th className="py-1 pr-2">手数</th>
                    <th className="py-1 pr-2">精度</th>
                    <th className="py-1">悪手率</th>
                  </tr>
                </thead>
                <tbody>
                  {(['opening', 'middlegame', 'endgame'] as const).map((ph) => {
                    const s = report.byPhase[ph];
                    return (
                      <tr key={ph} className="border-t border-border">
                        <td className="py-2 pr-2">{phaseLabelJa(ph)}</td>
                        <td className="py-2 pr-2">{s.moveCount}</td>
                        <td className="py-2 pr-2">{s.accuracyScore}</td>
                        <td className="py-2">{Math.round(s.blunderRate * 100)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {status === 'signedIn' && (
        <div className="mt-8 border-t border-border pt-6">
          <PrivacySettings />
        </div>
      )}
    </div>
  );
}
