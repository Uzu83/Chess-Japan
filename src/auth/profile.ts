/*
 * profile.ts — profiles テーブル / rating RPC の型付きラッパ
 *
 * サーバー側の契約(supabase/migrations/0004・0005)と 1:1 対応:
 *   - profiles の SELECT は RLS で本人の行のみ(.single() で自分の行を取る)
 *   - rating/games/rating_initialized/rating_source は client から UPDATE 不可
 *     (列 GRANT 外)。変更は RPC set_initial_rating / apply_rated_result のみ。
 *   - RATING_SOURCES は 0004 の check 制約 whitelist と一致させる義務。
 *     片方だけ変えると RPC がチェック違反例外を返すようになる。
 */
import { getSupabase } from './supabaseClient';

/** 0004 の rating_source check 制約と一致(変更時は migration とセットで)。 */
export const RATING_SOURCES = [
  'default',
  'self_beginner',
  'self_intermediate',
  'self_advanced',
  'self_custom',
  'local_migrated',
] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

/** profiles 1 行(0004 + 0006 の列定義と一致)。 */
export interface Profile {
  id: string;
  display_name: string | null;
  rating: number;
  games: number;
  rating_initialized: boolean;
  rating_source: RatingSource | null;
  /** 0006: 公開プレイ分析の可視性。欠落時は private 扱い。 */
  strength_visibility?: 'private' | 'public';
  /** 0006: 公開ハンドル。非公開時は null。 */
  public_handle?: string | null;
  created_at: string;
  updated_at: string;
}

/** DB 行を Profile に正規化（migration 未適用・古い行の欠落列を吸収）。 */
export function normalizeProfile(row: Record<string, unknown> | null): Profile | null {
  if (!row || typeof row.id !== 'string') return null;
  const vis = row.strength_visibility;
  return {
    ...(row as unknown as Profile),
    strength_visibility: vis === 'public' ? 'public' : 'private',
    public_handle: typeof row.public_handle === 'string' ? row.public_handle : null,
  };
}

/**
 * 自分の profile を取得。RLS(owner-only SELECT)により自分の行しか返らない。
 * 行が無い(トリガ失敗等の異常系)は null — その場合も set_initial_rating が
 * 自己修復で行を作るので、呼び出し側はオンボーディングへ誘導すればよい。
 */
export async function getMyProfile(): Promise<Profile | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('profiles').select('*').maybeSingle();
  if (error) throw new Error(`profile 取得に失敗: ${error.message}`);
  return normalizeProfile(data as Record<string, unknown> | null);
}

/**
 * 初期レート設定(オンボーディング/ローカル移行)。サーバー側で [100,3000] クランプ・
 * 未初期化のときだけ適用・2回目以降は現状を返す(冪等)。
 */
export async function setInitialRating(rating: number, source: RatingSource): Promise<Profile> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('set_initial_rating', {
    p_rating: Math.round(rating),
    p_source: source,
  });
  if (error) throw new Error(`初期レート設定に失敗: ${error.message}`);
  return data as Profile;
}

/**
 * レート戦結果の反映(Elo はサーバーが再計算)。
 * 【ADR 0002 / Codex F002】GRANT されていない。クライアントから呼んでも失敗する。
 * サーバー発行 challenge + 棋譜検証が揃うまで配線しない。型契約のため関数は残す。
 */
export async function applyRatedResult(oppElo: number, score: 0 | 0.5 | 1): Promise<Profile> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('apply_rated_result', {
    p_opp_elo: oppElo,
    p_score: score,
  });
  if (error) throw new Error(`レート反映に失敗: ${error.message}`);
  return data as Profile;
}

/** 表示名の変更(client が直接書ける唯一の列)。40字は 0004 の check と一致。 */
export async function updateDisplayName(name: string): Promise<void> {
  const supabase = await getSupabase();
  // セッションからローカルに user id を取る(getUser() と違いネットワークを叩かない)。
  // 【境界の明確化 — 監査ワークフロー指摘への回答】この uid は「絞り込みの意図表明」
  // であり認可の根拠ではない。認可は常にサーバー側 RLS の auth.uid()(署名済み JWT 由来)。
  // localStorage を改竄して他人の uid を入れても WHERE id=改竄値 AND auth.uid()=本人 が
  // 0 行になり何も起きない。**認可判断を client の identity に依存させる箇所では
  // getSession() でなく getUser()(サーバー検証)を使うこと** — が今後のガイドライン。
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user.id;
  if (!uid) throw new Error('未ログインです');
  const trimmed = name.trim().slice(0, 40);
  // .eq で明示的に本人の行を指定(RLS でも守られるが、意図をコードに残す)。
  const { error } = await supabase
    .from('profiles')
    .update({ display_name: trimmed.length > 0 ? trimmed : null })
    .eq('id', uid);
  if (error) throw new Error(`表示名の変更に失敗: ${error.message}`);
}
