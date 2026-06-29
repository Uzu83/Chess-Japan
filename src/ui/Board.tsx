import { useEffect, useRef } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';

interface BoardProps {
  fen: string;
  orientation?: 'white' | 'black';
  /** 直前の手(UCI、例: "e2e4")。ハイライト表示に使う。 */
  lastMoveUci?: string | null;
}

/** chessground を React でラップした閲覧用の盤(レスポンシブ・タッチ対応)。 */
export function Board({ fen, orientation = 'white', lastMoveUci }: BoardProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    apiRef.current = Chessground(elRef.current, {
      fen,
      orientation,
      viewOnly: true,
      coordinates: true,
    });
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // 初期化は一度だけ。以降の更新は下の effect で行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const lastMove: Key[] | undefined =
      lastMoveUci && lastMoveUci.length >= 4
        ? [lastMoveUci.slice(0, 2) as Key, lastMoveUci.slice(2, 4) as Key]
        : undefined;
    apiRef.current?.set({ fen, orientation, lastMove });
  }, [fen, orientation, lastMoveUci]);

  return <div ref={elRef} className="aspect-square w-full" />;
}
