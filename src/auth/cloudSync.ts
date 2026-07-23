/*
 * cloudSync.ts — 対局終了時の unverified クラウド保存（火消し式）
 *
 * WHY PlayView から直接 RPC を呼ばないか:
 *   auth 無効・未ログイン・ネットワーク不通でも対局 UI を止めない。
 *   ここは best-effort。失敗は SyncToast（呼び出し側）で1回だけ告知。
 */
import { isAuthConfigured } from './supabaseClient';
import { saveUnverifiedAiGameResult } from './games';
import type { AnalysisPayload } from './games';
import type { GameKind, MoveQuality } from '../core/types';
import { classifyPhase } from '../core/phase';
import { tagMove } from '../core/playstyle';
import type { ExplanationContext } from '../core/types';
import type { MoveRecord } from '../core/types';

export type CloudSyncResult = { ok: boolean; gameId?: string; reason?: string };

export async function syncAiGameToCloud(params: {
  signedIn: boolean;
  gameKind: GameKind;
  youColor: 'white' | 'black';
  outcome: 'win' | 'loss' | 'draw' | 'unfinished';
  result: string;
  moveCount: number;
  opponentLabel: string;
  recordText: string;
  analysisPayload?: AnalysisPayload | null;
  /** 対局インスタンス ID（ローカル PlayedGame.id）。再送時だけ同じ値を使う。 */
  idempotencyKey: string;
}): Promise<CloudSyncResult> {
  // スキップ条件は失敗ではない（ok:true, gameId なし）
  if (!params.signedIn || !isAuthConfigured()) return { ok: true };
  if (params.moveCount <= 0) return { ok: true };
  if (!params.idempotencyKey || params.idempotencyKey.length < 8) return { ok: true };

  const result = await saveUnverifiedAiGameResult({
    gameKind: params.gameKind,
    youColor: params.youColor,
    outcome: params.outcome,
    result: params.result,
    moveCount: params.moveCount,
    opponentLabel: params.opponentLabel,
    recordText: params.recordText,
    analysisPayload: params.analysisPayload ?? null,
    idempotencyKey: params.idempotencyKey,
  });
  if (result.ok) return { ok: true, gameId: result.game.id };
  return { ok: false, reason: result.reason };
}

/**
 * Review 解析結果から analysis_payload を組み立てる。
 * youColor: ユーザーが持っていた色（AI戦の振り返り時）。不明なら両色とも isUserMove=true にしないよう
 * 呼び出し側が渡す。レビュー単体では orientation を youColor の代理にしてよい。
 */
export function buildAnalysisPayload(params: {
  kind: GameKind;
  youColor: 'white' | 'black';
  contexts: Record<number, ExplanationContext>;
  moves: MoveRecord[];
}): AnalysisPayload {
  const userIsWhite = params.youColor === 'white';
  const plies: AnalysisPayload['plies'] = [];

  for (const move of params.moves) {
    const ctx = params.contexts[move.ply];
    if (!ctx?.quality) continue;
    const quality = ctx.quality as MoveQuality;
    const phase = classifyPhase({
      kind: params.kind,
      ply: move.ply,
      fenOrSfen: move.fenBefore || ctx.fenOrSfen,
    });
    const tags = tagMove({
      kind: params.kind,
      phase,
      quality,
      evalBefore: ctx.evalBefore,
      evalAfter: ctx.evalAfter,
      movePlayed: ctx.movePlayed ?? move.uci,
      fenOrSfen: move.fenBefore || ctx.fenOrSfen,
    });
    const isUserMove = userIsWhite ? move.color === 'w' : move.color === 'b';
    plies.push({
      ply: move.ply,
      color: move.color,
      isUserMove,
      quality,
      phase,
      tags,
      evalBefore: ctx.evalBefore,
      evalAfter: ctx.evalAfter,
    });
  }

  return { version: 1, plies };
}
