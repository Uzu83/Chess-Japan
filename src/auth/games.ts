/*
 * games.ts — AI戦クラウド履歴（unverified）の RPC ラッパ
 *
 * WHY テーブル直 INSERT をしないか（Codex F001 / ADR 0002）:
 *   公開 SPA の anon key で REST 直叩きできる前提では、owner INSERT ポリシーがあっても
 *   「アプリ経由で指した対局」の真正性は証明できない。よって INSERT GRANT は付けず、
 *   SECURITY DEFINER RPC `save_unverified_ai_game` だけが書き込み口。
 *   保存データは trust_level=unverified（自己用）。公開集計・クラウドレートには使わない。
 *
 * 失敗は握って UI を止めない WHY:
 *   オフライン・未確認メール・RPC 未デプロイでも対局体験（localStorage）は無傷に保つ。
 *   呼び出し側は戻り値 null を「クラウド未保存」として静かに扱う。
 */
import { getSupabase } from './supabaseClient';
import type { GameKind } from '../core/types';

/** RPC が返す games 1 行（0006 と一致）。 */
export interface CloudGame {
  id: string;
  user_id: string;
  game_kind: GameKind;
  mode: 'ai' | 'pvp';
  trust_level: 'unverified' | 'verified';
  opponent_label: string;
  opponent_user_id: string | null;
  you_color: 'white' | 'black';
  result: string;
  outcome: 'win' | 'loss' | 'draw' | 'unfinished';
  move_count: number;
  record_text: string;
  analysis_payload: unknown | null;
  rated: boolean;
  created_at: string;
  /** 冪等キー（将来マージ用）。RPC 未返却時は undefined。 */
  idempotency_key?: string;
}

/** RPC 結果（toast 用の reason を保持）。 */
export type CloudGameRpcResult = { ok: true; game: CloudGame } | { ok: false; reason: string };

/** 解析ペイロード（クライアント端末解析。サーバーは権威とみなさない）。 */
export interface AnalysisPayload {
  version: 1;
  plies: Array<{
    ply: number;
    color: 'w' | 'b';
    isUserMove: boolean;
    quality: string;
    phase?: string;
    tags?: string[];
    evalBefore?: number;
    evalAfter?: number;
  }>;
}

export interface SaveUnverifiedAiGameInput {
  gameKind: GameKind;
  youColor: 'white' | 'black';
  outcome: 'win' | 'loss' | 'draw' | 'unfinished';
  result: string;
  moveCount: number;
  opponentLabel: string;
  recordText: string;
  analysisPayload?: AnalysisPayload | null;
  /** 再送冪等キー（8〜128文字）。同一対局の再送で同じ値を渡す。 */
  idempotencyKey: string;
}

/**
 * AI戦を自己用クラウド履歴へ保存（理由付き結果）。
 * ログイン必須・メール確認必須はサーバーが強制。
 */
export async function saveUnverifiedAiGameResult(
  input: SaveUnverifiedAiGameInput,
): Promise<CloudGameRpcResult> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('save_unverified_ai_game', {
      p_game_kind: input.gameKind,
      p_you_color: input.youColor,
      p_outcome: input.outcome,
      p_result: input.result,
      p_move_count: input.moveCount,
      p_opponent_label: input.opponentLabel,
      p_record_text: input.recordText,
      p_analysis_payload: input.analysisPayload ?? null,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      console.warn('[games] save_unverified_ai_game failed:', error.message);
      return { ok: false, reason: error.message };
    }
    return { ok: true, game: data as CloudGame };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn('[games] save_unverified_ai_game error:', e);
    return { ok: false, reason };
  }
}

/**
 * AI戦を自己用クラウド履歴へ保存。失敗時は null（対局 UI は止めない）。
 */
export async function saveUnverifiedAiGame(
  input: SaveUnverifiedAiGameInput,
): Promise<CloudGame | null> {
  const result = await saveUnverifiedAiGameResult(input);
  return result.ok ? result.game : null;
}

/** 既存の自己対局に端末解析を添付（理由付き結果）。 */
export async function attachUnverifiedAnalysisResult(
  gameId: string,
  analysisPayload: AnalysisPayload,
): Promise<CloudGameRpcResult> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('attach_unverified_analysis', {
      p_game_id: gameId,
      p_analysis_payload: analysisPayload,
    });
    if (error) {
      console.warn('[games] attach_unverified_analysis failed:', error.message);
      return { ok: false, reason: error.message };
    }
    return { ok: true, game: data as CloudGame };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn('[games] attach_unverified_analysis error:', e);
    return { ok: false, reason };
  }
}

/** 既存の自己対局に端末解析を添付。失敗時は null。 */
export async function attachUnverifiedAnalysis(
  gameId: string,
  analysisPayload: AnalysisPayload,
): Promise<CloudGame | null> {
  const result = await attachUnverifiedAnalysisResult(gameId, analysisPayload);
  return result.ok ? result.game : null;
}

/** 自分のクラウド対局を新しい順で取得。失敗時は空配列。 */
export async function listMyCloudGames(limit = 50): Promise<CloudGame[]> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('list_my_games', {
      p_limit: Math.max(1, Math.min(100, limit)),
    });
    if (error) {
      console.warn('[games] list_my_games failed:', error.message);
      return [];
    }
    return (data as CloudGame[]) ?? [];
  } catch (e) {
    console.warn('[games] list_my_games error:', e);
    return [];
  }
}

/**
 * 公開プロフィール（粗い要約のみ）。非公開・未存在は null。
 * user_id / 棋譜は返らない（F007）。
 */
export async function getPublicStrength(handle: string): Promise<PublicStrengthSummary | null> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('get_public_strength', {
      p_handle: handle,
    });
    if (error) {
      console.warn('[games] get_public_strength failed:', error.message);
      return null;
    }
    return (data as PublicStrengthSummary | null) ?? null;
  } catch (e) {
    console.warn('[games] get_public_strength error:', e);
    return null;
  }
}

export interface PublicStrengthSummary {
  handle: string;
  accuracy_bucket: string;
  top_strengths: string[];
  top_weaknesses: string[];
  games_bucket: string;
}
