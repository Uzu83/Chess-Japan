/*
 * pvp/client.ts — カジュアル PvP（Hybrid: 着手=Edge、resign/heartbeat/record=RPC）
 *
 * WHY 着手だけ Edge か: Postgres に chess.js が無く、合法手検証は Deno Edge が担う。
 * 旧 pvp_submit_move / pvp_finalize は migration 0010 で DROP 済み。
 */
import { getSupabase } from '../auth/supabaseClient';

export interface PvpRoom {
  id: string;
  game_kind: 'chess' | 'shogi';
  status: 'waiting' | 'active' | 'finished' | 'aborted';
  white_user_id: string | null;
  black_user_id: string | null;
  moves: string[];
  fen?: string;
  result: string;
  winner_color: 'white' | 'black' | null;
  finish_reason?: string | null;
  white_last_seen?: string | null;
  black_last_seen?: string | null;
  turn_started_at?: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeRoom(raw: Record<string, unknown>): PvpRoom {
  const moves = raw['moves'];
  return {
    id: String(raw['id']),
    game_kind: raw['game_kind'] === 'shogi' ? 'shogi' : 'chess',
    status: raw['status'] as PvpRoom['status'],
    white_user_id: (raw['white_user_id'] as string) ?? null,
    black_user_id: (raw['black_user_id'] as string) ?? null,
    moves: Array.isArray(moves) ? (moves as string[]) : [],
    fen: typeof raw['fen'] === 'string' ? raw['fen'] : undefined,
    result: String(raw['result'] ?? '*'),
    winner_color: (raw['winner_color'] as PvpRoom['winner_color']) ?? null,
    finish_reason: (raw['finish_reason'] as string | null) ?? null,
    white_last_seen: (raw['white_last_seen'] as string | null) ?? null,
    black_last_seen: (raw['black_last_seen'] as string | null) ?? null,
    turn_started_at: (raw['turn_started_at'] as string | null) ?? null,
    created_at: String(raw['created_at'] ?? ''),
    updated_at: String(raw['updated_at'] ?? ''),
  };
}

export async function pvpJoinQueue(gameKind: 'chess' | 'shogi' = 'chess'): Promise<PvpRoom> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('pvp_join_queue', { p_game_kind: gameKind });
  if (error) throw new Error(error.message);
  return normalizeRoom(data as Record<string, unknown>);
}

/** 着手: Edge /functions/v1/pvp（JWT 必須）。 */
export async function pvpSubmitMove(roomId: string, san: string): Promise<PvpRoom> {
  const supabase = await getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('未ログインです');

  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anon) throw new Error('Supabase 未設定');

  const res = await fetch(`${url}/functions/v1/pvp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: JSON.stringify({ roomId, san }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    room?: Record<string, unknown>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `着手に失敗 (${res.status})`);
  }
  if (!body.room) throw new Error('空の応答');
  return normalizeRoom(body.room);
}

export async function pvpResign(roomId: string): Promise<PvpRoom> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('pvp_resign', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return normalizeRoom(data as Record<string, unknown>);
}

export async function pvpHeartbeat(roomId: string): Promise<PvpRoom> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('pvp_heartbeat', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return normalizeRoom(data as Record<string, unknown>);
}

/** finished 後に本人履歴へ冪等保存（result/record はサーバー生成）。 */
export async function pvpRecordGame(roomId: string): Promise<PvpRoom> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('pvp_record_game', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return normalizeRoom(data as Record<string, unknown>);
}

export async function pvpAbort(roomId: string): Promise<PvpRoom> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('pvp_abort', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return normalizeRoom(data as Record<string, unknown>);
}

/** Realtime 購読。チャンネル解除関数を返す。 */
export async function subscribePvpRoom(
  roomId: string,
  onUpdate: (room: PvpRoom) => void,
): Promise<() => void> {
  const supabase = await getSupabase();
  const channel = supabase
    .channel(`pvp:${roomId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pvp_rooms', filter: `id=eq.${roomId}` },
      (payload) => {
        if (payload.new && typeof payload.new === 'object') {
          onUpdate(normalizeRoom(payload.new as Record<string, unknown>));
        }
      },
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Realtime 欠落時の再取得。 */
export async function pvpFetchRoom(roomId: string): Promise<PvpRoom | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pvp_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeRoom(data as Record<string, unknown>);
}
