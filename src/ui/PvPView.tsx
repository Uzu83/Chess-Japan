/*
 * PvPView.tsx — カジュアル対人戦（チェス・サーバー権威）
 *
 * 合法性: Edge + chess.js。終局: resign / 詰み自動 / タイムアウト。
 * 履歴: pvp_record_game（verified・サーバー生成棋譜）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { useAuth } from '../auth/authState';
import { isAuthConfigured } from '../auth/supabaseClient';
import {
  pvpAbort,
  pvpFetchRoom,
  pvpHeartbeat,
  pvpJoinQueue,
  pvpRecordGame,
  pvpResign,
  pvpSubmitMove,
  subscribePvpRoom,
  type PvpRoom,
} from '../pvp/client';
import { PlayBoard } from './PlayBoard';

function movesToFen(sans: string[], fallbackFen?: string): string {
  if (fallbackFen) {
    try {
      // fen 優先（サーバー権威）。不正なら moves 再生へ。
      new Chess(fallbackFen);
      return fallbackFen;
    } catch {
      /* fall through */
    }
  }
  const c = new Chess();
  for (const san of sans) {
    try {
      c.move(san);
    } catch {
      break;
    }
  }
  return c.fen();
}

function destsFromFen(fen: string): Map<string, string[]> {
  const c = new Chess(fen);
  const map = new Map<string, string[]>();
  for (const m of c.moves({ verbose: true })) {
    const from = m.from;
    const list = map.get(from) ?? [];
    list.push(m.to);
    map.set(from, list);
  }
  return map;
}

function needsPromotion(fen: string, from: string, to: string): boolean {
  const c = new Chess(fen);
  const moves = c.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
  return moves.some((m) => m.promotion);
}

export function PvPView({ onBack }: { onBack: () => void }) {
  const { status, profile } = useAuth();
  const [room, setRoom] = useState<PvpRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peerHint, setPeerHint] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const recordedRef = useRef<string | null>(null);
  const myId = profile?.id ?? null;

  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, []);

  const myColor = useMemo(() => {
    if (!room || !myId) return null;
    if (room.white_user_id === myId) return 'white' as const;
    if (room.black_user_id === myId) return 'black' as const;
    return null;
  }, [room, myId]);

  const fen = useMemo(() => movesToFen(room?.moves ?? [], room?.fen), [room?.moves, room?.fen]);
  const turn: 'white' | 'black' = fen.includes(' w ') ? 'white' : 'black';
  const canMove = room?.status === 'active' && myColor !== null && turn === myColor && !busy;
  const inCheck = useMemo(() => {
    try {
      return new Chess(fen).inCheck();
    } catch {
      return false;
    }
  }, [fen]);
  const lastMoveUci = useMemo(() => {
    const sans = room?.moves ?? [];
    if (sans.length === 0) return null;
    const c = new Chess();
    let last: { from: string; to: string; promotion?: string } | null = null;
    for (const san of sans) {
      try {
        const m = c.move(san);
        if (m) last = { from: m.from, to: m.to, promotion: m.promotion };
      } catch {
        break;
      }
    }
    if (!last) return null;
    return `${last.from}${last.to}${last.promotion ?? ''}`;
  }, [room?.moves]);

  // finished → 本人履歴をサーバー生成で冪等保存
  // WHY recordedRef は成功後のみ立てるか（Codex data cycle-22）:
  //   失敗前に立てると同一マウント中の再試行が永久に抑止される。
  useEffect(() => {
    if (!room || room.status !== 'finished' || !myColor) return;
    if (recordedRef.current === room.id) return;
    const id = room.id;
    void pvpRecordGame(id)
      .then((r) => {
        recordedRef.current = id;
        setRoom(r);
      })
      .catch(() => {
        // 一時失敗は再試行可。冪等 RPC なので成功後の重複は無害。
      });
  }, [room, myColor]);

  // heartbeat（15s）。相手無応答ヒント用。
  // deps は id/status/myColor のみ（room 全体を入れると毎更新で interval 再生成になる）。
  const roomId = room?.id;
  const roomStatus = room?.status;
  useEffect(() => {
    if (!roomId || roomStatus !== 'active') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await pvpHeartbeat(roomId);
        if (cancelled) return;
        setRoom(r);
        if (r.status === 'finished') {
          setPeerHint(
            r.finish_reason === 'timeout'
              ? '時間切れで終局しました'
              : r.finish_reason === 'abandon'
                ? '双方無応答のため終局しました'
                : null,
          );
        } else if (myColor) {
          const oppSeen = myColor === 'white' ? r.black_last_seen : r.white_last_seen;
          if (oppSeen) {
            const age = Date.now() - new Date(oppSeen).getTime();
            setPeerHint(age > 45_000 ? '相手が応答していない可能性があります…' : null);
          }
        }
      } catch {
        // 一時失敗は無視。次 tick で再試行
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [roomId, roomStatus, myColor]);

  const attachRealtime = useCallback(async (roomId: string) => {
    unsubRef.current?.();
    unsubRef.current = await subscribePvpRoom(roomId, (r) => {
      setRoom(r);
      // desync 緩和: fen 欠落時は再取得
      if (!r.fen && r.status === 'active') {
        void pvpFetchRoom(roomId).then((fresh) => {
          if (fresh) setRoom(fresh);
        });
      }
    });
  }, []);

  const join = async () => {
    setError(null);
    setBusy(true);
    recordedRef.current = null;
    try {
      const r = await pvpJoinQueue('chess');
      setRoom(r);
      await attachRealtime(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUserMove = async (from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') => {
    if (!room || !canMove) return;
    setBusy(true);
    setError(null);
    try {
      const c = new Chess(fen);
      const moved = c.move({
        from,
        to,
        promotion: promotion ?? 'q',
      });
      if (!moved) throw new Error('非合法手');
      const next = await pvpSubmitMove(room.id, moved.san);
      setRoom(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 失敗時はサーバー状態を再取得
      const fresh = await pvpFetchRoom(room.id);
      if (fresh) setRoom(fresh);
    } finally {
      setBusy(false);
    }
  };

  const resign = async () => {
    if (!room || !myColor) return;
    setBusy(true);
    try {
      const finalized = await pvpResign(room.id);
      setRoom(finalized);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (!room) return;
    setBusy(true);
    try {
      const r = await pvpAbort(room.id);
      setRoom(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status !== 'signedIn' || !isAuthConfigured()) {
    return (
      <div className="mx-auto max-w-xl px-5 py-8">
        <p className="text-sm text-muted">対人戦にはログインが必要です。</p>
        <button
          type="button"
          onClick={onBack}
          className="focus-ai mt-4 min-h-11 rounded-lg border border-border px-3 text-sm"
        >
          戻る
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ai">対人戦（カジュアル）</h2>
        <button
          type="button"
          onClick={onBack}
          className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm text-muted"
        >
          戻る
        </button>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        チェスのみ。レート変動なし。着手はサーバー検証。終局（詰み・投了・時間切れ）はサーバーが確定し、
        本人の履歴に verified として保存します。接続断約90秒・手番約5分で時間切れになります。
      </p>

      {!room && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void join()}
          className="focus-ai min-h-11 rounded-lg bg-ai px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-ai-dim"
        >
          マッチング開始
        </button>
      )}

      {room && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            状態: <span className="font-medium text-on-surface">{room.status}</span>
            {myColor && (
              <>
                {' '}
                / あなたは <span className="font-medium text-ai">{myColor}</span>
              </>
            )}
          </p>
          {room.status === 'waiting' && <p className="text-sm text-muted">相手を待っています…</p>}
          {peerHint && <p className="text-sm text-muted">{peerHint}</p>}
          {(room.status === 'active' || room.status === 'finished') && (
            <div className="mx-auto w-full max-w-md">
              <PlayBoard
                fen={fen}
                orientation={myColor ?? 'white'}
                turnColor={turn}
                inCheck={inCheck}
                lastMoveUci={lastMoveUci}
                dests={canMove ? destsFromFen(fen) : new Map()}
                movableColor={canMove ? (myColor ?? undefined) : undefined}
                isPromotion={(from, to) => needsPromotion(fen, from, to)}
                onUserMove={(from, to, promo) => void onUserMove(from, to, promo)}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {room.status === 'active' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void resign()}
                className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm"
              >
                投了
              </button>
            )}
            {room.status === 'waiting' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void abort()}
                className="focus-ai min-h-11 rounded-lg border border-border px-3 text-sm"
              >
                キャンセル
              </button>
            )}
          </div>
          {room.status === 'finished' && (
            <p className="text-sm text-on-surface">
              終局: {room.result}
              {room.finish_reason ? `（${room.finish_reason}）` : ''}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-[var(--q-miss-fg)]" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
