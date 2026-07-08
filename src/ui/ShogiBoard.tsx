import { useEffect, useRef } from 'react';
import { Shogiground } from 'shogiground';
import type { Api } from 'shogiground/api';
import { buildShogiReviewConfig, type ShogiReviewConfigParams } from './shogigroundConfig';
import './shogiBoard.css';

/*
 * ShogiBoard — shogiground をラップした閲覧専用の将棋盤（持ち駒表示込み）
 *
 * WHY 動的ロード前提か（1バイト不変条件）:
 *   このコンポーネントは ReviewView から React.lazy 経由で読み込まれる。static import すると
 *   shogiground がチェス利用者のメインバンドルに漏れる。将棋タブを開いたときだけ読ませる。
 *
 * WHY Board.tsx（chessground 版）と同じ「初期化1回 + api.set() 差分反映」パターンか:
 *   盤コンポーネントを毎レンダーで作り直すと重い＆アニメーションが飛ぶ。初期化は 1 回だけ行い、
 *   以降は SFEN / 向き / 直前手の変化を api.set() の差分で反映する（chessground 版と実装方針を統一）。
 *
 * 入力は SFEN（"lnsg... b - 1"）。config の組み立て（見た目不変条件・SFEN 分解・直前手変換）は
 * shogigroundConfig.ts の buildShogiReviewConfig に集約（両盤共有・単体テスト対象）。
 */

type ShogiBoardProps = ShogiReviewConfigParams;

/** shogiground を React でラップした閲覧用の将棋盤（レスポンシブ・持ち駒つき）。 */
export function ShogiBoard(props: ShogiBoardProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    // wrapElements.board に div を渡すと、この div が .sg-wrap になり内部に盤・持ち駒が生える。
    apiRef.current = Shogiground(buildShogiReviewConfig(props), { board: elRef.current });
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // 初期化は一度だけ。以降の更新は下の effect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.set(buildShogiReviewConfig(props));
    // props（sfen/orientation/lastMoveUsi）変化のたびに差分反映。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sfen, props.orientation, props.lastMoveUsi]);

  return <div ref={elRef} className="w-full" />;
}
