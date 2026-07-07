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

/** profiles 1 行(0004 の列定義と一致)。 */
export interface Profile {
  id: string;
  display_name: string | null;
  rating: number;
  games: number;
  rating_initialized: boolean;
  rating_source: RatingSource | null;
  created_at: string;
  updated_at: string;
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
  return (data as Profile | null) ?? null;
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
 * 【2C-1 では未配線】migration に RPC は同梱済みだが、AI 戦結果→クラウド反映の
 * 呼び出しは 2C-2(クラウド同期)で行う。ここに置くのは契約を型で先に固定するため。
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
