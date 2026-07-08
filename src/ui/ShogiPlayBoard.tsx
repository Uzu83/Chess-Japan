import { useEffect, useRef, useState } from 'react';
import { Shogiground } from 'shogiground';
import type { Api } from 'shogiground/api';
import type { Config } from 'shogiground/config';
import type { Color } from 'shogiground/types';
import type { ShogiColor } from '../core/shogiPlayGame';
import { buildShogiPlayConfig, splitSfenBoardHands } from './shogigroundConfig';
import './shogiBoard.css';

/*
 * ShogiPlayBoard — 対局用の「操作できる」将棋盤（shogiground ラッパ）
 *
 * WHY 閲覧用 ShogiBoard.tsx と分けるか（PlayBoard/Board の分離と同じ思想）:
 *   ShogiBoard.tsx は viewOnly:true の振り返り専用で ReviewView が依存している。そこへ
 *   movable/droppable/成りピッカーを足すと閲覧用の不変条件を壊すリスクがある。対局は
 *   「合法手ハイライト・着手・駒台打ち・成り選択」という別責務なので独立させ、ShogiBoard.tsx は
 *   一切触らない（将来の担当者へ: 対局機能を ShogiBoard.tsx に混ぜないこと）。
 *
 * WHY 動的ロード前提か（1バイト不変条件）:
 *   このコンポーネントは ShogiPlaySession から React.lazy 経由で読み込まれる。static import すると
 *   shogiground がチェス利用者のメインバンドルへ漏れる。将棋対局に入ったときだけ読ませる。
 *
 * shogiground との接続（ShogiBoard/PlayBoard と同じ「初期化1回 + api.set() 差分」）:
 *   - 初期化は一度だけ。以降 props 変化は api.set() で差分反映。
 *   - 着手/打ちハンドラ(movable/droppable の events.after)は初期化時に1つだけ登録し、中身は
 *     ref 経由で最新のコールバックを呼ぶ（stale closure 回避）。
 *
 * 成り（プロモーション）:
 *   shogiground には内蔵の成りダイアログがあるが、PlayBoard(チェス) と同じモーダルイディオムへ
 *   統一するため **内蔵ダイアログは全て無効化**（promotion.*Dialog を false）し、自前の
 *   「成る/不成」ピッカーを出す。強制成り（行き所のない駒）は core が自動成りにするので選択を出さない。
 *   駒台打ちは成りが存在しない（打った駒は必ず不成）ので、打ちにピッカーは不要。
 */

interface ShogiPlayBoardProps {
  /** 現在局面（SFEN）。 */
  sfen: string;
  /** 盤の向き（sente=先手が下）。 */
  orientation: ShogiColor;
  /** 現在の手番。 */
  turnColor: ShogiColor;
  /** 手番側が王手されているか（玉のハイライト用）。 */
  inCheck: boolean;
  /** 直近手 USI（ハイライト用）。 */
  lastMoveUsi: string | null;
  /** 盤上の合法手 dests（from USI → to[] USI）。 */
  legalDests: Map<string, string[]>;
  /** 持ち駒打ちの dests（ロール名 → 打てる to[] USI）。 */
  dropDests: Map<string, string[]>;
  /**
   * 人間が操作できるか（自分の手番・AI 思考中でない・続行中）。
   * false のとき activeColor を外して盤をロックする（誤操作防止）。
   */
  movable: boolean;
  /** from→to が成り/不成の選択を要するか（親=ShogiPlayGame の needsPromotionChoice）。 */
  needsPromotionChoice: (from: string, to: string) => boolean;
  /** 盤上の着手を確定したときに呼ばれる。 */
  onUserMove: (from: string, to: string, promote?: boolean) => void;
  /** 持ち駒打ちを確定したときに呼ばれる（role=shogiground の役名 "pawn" 等）。 */
  onUserDrop: (role: string, to: string) => void;
}

export function ShogiPlayBoard({
  sfen,
  orientation,
  turnColor,
  inCheck,
  lastMoveUsi,
  legalDests,
  dropDests,
  movable,
  needsPromotionChoice,
  onUserMove,
  onUserDrop,
}: ShogiPlayBoardProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  // 成り待ち（from/to を保持し、成る/不成の選択後に確定）。
  const [pending, setPending] = useState<{ from: string; to: string } | null>(null);

  // ── stale closure 回避用 ref ────────────────────────────────
  // events.after は初期化時に一度だけ登録するので、最新のコールバック/判定を ref 越しに呼ぶ。
  const needsPromoRef = useRef(needsPromotionChoice);
  needsPromoRef.current = needsPromotionChoice;
  const onUserMoveRef = useRef(onUserMove);
  onUserMoveRef.current = onUserMove;
  const onUserDropRef = useRef(onUserDrop);
  onUserDropRef.current = onUserDrop;

  // 現在 props から shogiground 設定を組む（初期化・更新で共用）。設定の中身は module-level の
  // pure 関数 buildShogiPlayConfig に切り出し（テスト可能化・見た目不変条件の回帰ガード）、
  // ここでは event body（ref 越しに最新コールバックを呼ぶ = stale closure 回避）だけ与える。
  // ※ events は初期化時のみ渡す（set で毎回上書きすると多重登録の懸念があるため withEvents で制御）。
  const buildConfig = (withEvents: boolean): Config =>
    buildShogiPlayConfig({
      sfen,
      orientation,
      turnColor,
      inCheck,
      lastMoveUsi,
      legalDests,
      dropDests,
      movable,
      withEvents,
      onMoveAfter: (orig, dest) => {
        const from = orig as string;
        const to = dest as string;
        // 成り/不成の選択が要るならピッカーを出す。強制成り・不成不要は即着手を確定
        // （promote 未指定で core が自動成り/不成を決める）。
        if (needsPromoRef.current(from, to)) setPending({ from, to });
        else onUserMoveRef.current(from, to);
      },
      onDropAfter: (piece, key) => {
        onUserDropRef.current(piece.role, key as string);
      },
    });

  // ── 初期化（一度だけ） ─────────────────────────────────────
  useEffect(() => {
    if (!elRef.current) return;
    apiRef.current = Shogiground(buildConfig(true), { board: elRef.current });
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // 初期化は一度だけ。props 反映は下の effect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── props 変化を盤へ反映 ────────────────────────────────────
  useEffect(() => {
    apiRef.current?.set(buildConfig(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sfen, orientation, turnColor, inCheck, lastMoveUsi, legalDests, dropDests, movable]);

  // 盤がロックされたら（AI手番/終局）、開きっぱなしの成りピッカーを閉じる（PlayBoard と同じ防御）。
  useEffect(() => {
    if (!movable && pending) setPending(null);
  }, [movable, pending]);

  // 成りをキャンセルしたら、着手前 sfen で盤を元に戻す（shogiground の楽観移動を巻き戻す）。
  const cancelPromotion = () => {
    setPending(null);
    const { board, hands } = splitSfenBoardHands(sfen);
    apiRef.current?.set({ sfen: { board, hands }, turnColor: turnColor as Color });
  };

  // 成る/不成を確定 → 親に着手を伝える（親が新 sfen を返して盤が同期される）。
  const confirmPromotion = (promote: boolean) => {
    if (!pending) return;
    const { from, to } = pending;
    setPending(null);
    onUserMoveRef.current(from, to, promote);
  };

  return (
    <div className="relative w-full">
      <div ref={elRef} className="w-full" />

      {/* ── 成り/不成ピッカー ──
          PlayBoard(チェス) の成りピッカーと同じモーダルイディオム:
            - 開いたら先頭ボタンへフォーカス(autoFocus)
            - Escape でキャンセル(onKeyDown)
            - 背景クリックでキャンセル。内側は stopPropagation で誤爆を防ぐ */}
      {pending && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-label="成るか選択"
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
            <p className="text-sm font-medium text-on-surface">成りますか？</p>
            <div className="flex gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => confirmPromotion(true)}
                className="focus-ai flex h-14 w-20 items-center justify-center rounded-xl border border-border bg-surface-2 text-lg font-bold text-[#b3452b] transition-colors hover:border-ai hover:bg-ai-bg"
              >
                成る
              </button>
              <button
                type="button"
                onClick={() => confirmPromotion(false)}
                className="focus-ai flex h-14 w-20 items-center justify-center rounded-xl border border-border bg-surface-2 text-lg font-bold text-on-surface transition-colors hover:border-ai hover:bg-ai-bg"
              >
                不成
              </button>
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
