import { useEffect, useRef, useState } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Color, Key } from 'chessground/types';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import type { PieceColor, PromotionPiece } from '../core/playGame';

/*
 * PlayBoard — 対局用の「操作できる」盤
 *
 * WHY 閲覧用 Board.tsx と分けるか:
 *   Board.tsx は viewOnly:true の振り返り専用で、ReviewView が依存している。
 *   そこに movable/ドラッグ/成りピッカーを足すと閲覧用の不変条件を壊すリスクがある。
 *   対局は「合法手ハイライト・着手・成り選択」という別の責務なので、独立コンポーネントにして
 *   Board.tsx を一切触らない(将来の担当者へ: 対局機能を Board.tsx に混ぜないこと)。
 *
 * chessground との接続:
 *   - 初期化は一度だけ。以降 props 変化は api.set() で差分反映(Board.tsx と同じ設計)。
 *   - 着手ハンドラ(events.after)は初期化時に1つだけ登録し、中身は ref 経由で最新の
 *     コールバックを呼ぶ(stale closure 回避)。set() で events を毎回渡す設計より安全。
 *
 * 成り(プロモーション):
 *   chessground の after はどの駒に成るかを知らせないため、成りが必要な手を検出したら
 *   ピッカーを出して駒種を選ばせ、その後に onUserMove(from,to,piece) を確定させる。
 *   キャンセル時は「まだ着手を親に伝えていない」ので、現在の fen(=着手前)で盤を元に戻す。
 */

interface PlayBoardProps {
  /** 現在局面の FEN。 */
  fen: string;
  /** 盤の向き。 */
  orientation: PieceColor;
  /** 現在の手番(chessground の turnColor)。 */
  turnColor: PieceColor;
  /** 手番側が王手されているか(王のハイライト用)。 */
  inCheck: boolean;
  /** 直近手 UCI(ハイライト用)。 */
  lastMoveUci: string | null;
  /** 合法手 dests(from → to[])。 */
  dests: Map<string, string[]>;
  /**
   * 操作可能な色。人間の手番のみ自分の色を渡す。
   * AI 思考中・終局後は undefined を渡して盤をロックする(誤操作防止)。
   */
  movableColor?: PieceColor;
  /** from→to が成りを要するか(親=PlayGame の needsPromotion を渡す)。 */
  isPromotion: (from: string, to: string) => boolean;
  /** ユーザーが着手を確定したときに呼ばれる。 */
  onUserMove: (from: string, to: string, promotion?: PromotionPiece) => void;
}

/** 成りピッカーに出す駒グリフ(色別)。視覚的にどちらの駒か分かるようにする。 */
const PROMOTION_GLYPH: Record<PieceColor, Record<PromotionPiece, string>> = {
  white: { q: '♕', r: '♖', b: '♗', n: '♘' },
  black: { q: '♛', r: '♜', b: '♝', n: '♞' },
};

const PROMOTION_LABEL: Record<PromotionPiece, string> = {
  q: 'クイーン',
  r: 'ルーク',
  b: 'ビショップ',
  n: 'ナイト',
};

/** UCI 文字列 "e2e4" → [from, to] の Key ペア(ハイライト用)。 */
function uciToKeys(uci: string | null): Key[] | undefined {
  if (!uci || uci.length < 4) return undefined;
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key];
}

export function PlayBoard({
  fen,
  orientation,
  turnColor,
  inCheck,
  lastMoveUci,
  dests,
  movableColor,
  isPromotion,
  onUserMove,
}: PlayBoardProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  // 成り待ち(from/to を保持し、駒種選択後に確定)。
  const [pending, setPending] = useState<{ from: string; to: string } | null>(null);

  // ── stale closure 回避用 ref ────────────────────────────────
  // events.after は初期化時に一度だけ登録するので、最新のコールバック/判定を ref 越しに呼ぶ。
  const isPromotionRef = useRef(isPromotion);
  isPromotionRef.current = isPromotion;
  const onUserMoveRef = useRef(onUserMove);
  onUserMoveRef.current = onUserMove;

  // ── 初期化(一度だけ) ───────────────────────────────────────
  useEffect(() => {
    if (!elRef.current) return;

    const afterMove = (orig: Key, dest: Key) => {
      const from = orig as string;
      const to = dest as string;
      // 成りが必要なら駒種を選ばせる。そうでなければ即着手を確定。
      if (isPromotionRef.current(from, to)) {
        setPending({ from, to });
      } else {
        onUserMoveRef.current(from, to);
      }
    };

    apiRef.current = Chessground(elRef.current, {
      fen,
      orientation,
      turnColor,
      coordinates: true,
      // premove は Phase A では無効(思考中の先行入力は複雑さに見合わない)。
      premovable: { enabled: false },
      draggable: { enabled: true, showGhost: true },
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false, // 合法手のみ許可
        color: movableColor as Color | undefined,
        dests: dests as Map<Key, Key[]>,
        showDests: true,
        events: { after: afterMove },
      },
    });

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // 初期化は一度だけ。props 反映は下の effect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── props 変化を盤へ反映 ────────────────────────────────────
  useEffect(() => {
    apiRef.current?.set({
      fen,
      orientation,
      turnColor,
      check: inCheck ? (turnColor as Color) : undefined,
      lastMove: uciToKeys(lastMoveUci),
      movable: {
        color: movableColor as Color | undefined,
        dests: dests as Map<Key, Key[]>,
      },
    });
  }, [fen, orientation, turnColor, inCheck, lastMoveUci, dests, movableColor]);

  // 盤がロックされたら(AI手番/終局)、開きっぱなしの成りピッカーを閉じる。
  // WHY(Codex 指摘の防御): 成りピッカー表示中に投了などで終局すると、ピッカーが残って
  // 終局後に駒を選べてしまう。ロック(movableColor=undefined)を検知して pending を解除する。
  useEffect(() => {
    if (movableColor === undefined && pending) setPending(null);
  }, [movableColor, pending]);

  // 成りをキャンセルしたら、着手前 fen で盤を元に戻す(chessground の楽観移動を巻き戻す)。
  const cancelPromotion = () => {
    setPending(null);
    apiRef.current?.set({ fen });
  };

  // 成り駒を確定 → 親に着手を伝える(親が新 fen を返して盤が同期される)。
  const confirmPromotion = (piece: PromotionPiece) => {
    if (!pending) return;
    const { from, to } = pending;
    setPending(null);
    onUserMoveRef.current(from, to, piece);
  };

  return (
    <div className="relative aspect-square w-full">
      <div ref={elRef} className="aspect-square w-full" />

      {/* ── 成りピッカー ──
          成り待ちのときだけ盤に半透明オーバーレイを重ね、駒種4つを大きく提示する。
          正確なマス上への配置(幾何計算)は Phase A では過剰なので中央提示にとどめる。

          a11y(reviewer 指摘・aria-modal を名乗る以上の最低要件):
            - 開いたら先頭の駒ボタンへフォーカス(autoFocus)。
            - Escape でキャンセル(onKeyDown、フォーカスは内部ボタンにあるので div まで冒泡する)。
            - 背景(バックドロップ)クリックでキャンセル。内側 content は stopPropagation で誤爆を防ぐ。 */}
      {pending && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-label="成る駒を選択"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              cancelPromotion();
            }
          }}
          onClick={cancelPromotion}
        >
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium text-on-surface">成る駒を選択</p>
            <div className="flex gap-2">
              {(['q', 'r', 'b', 'n'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  // モーダル要件: 開いたら最初の選択肢(クイーン)へフォーカスを移す
                  autoFocus={p === 'q'}
                  onClick={() => confirmPromotion(p)}
                  aria-label={PROMOTION_LABEL[p]}
                  title={PROMOTION_LABEL[p]}
                  className="focus-ai flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-surface-2 text-4xl leading-none text-on-surface transition-colors hover:border-ai hover:bg-ai-bg"
                >
                  {PROMOTION_GLYPH[turnColor][p]}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={cancelPromotion}
              className="focus-ai min-h-9 rounded px-3 py-1 text-xs text-muted transition-colors hover:text-on-surface"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
