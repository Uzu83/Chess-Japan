/*
 * usi.ts — USI（将棋エンジンプロトコル）の行パーサ
 *
 * WHY uci.ts を fork するか（Codex ゲート① #5）:
 *   USI は UCI（チェス）を将棋向けに焼き直したほぼ同型のプロトコル。`info ... score cp/mate ... pv ...`
 *   の行は座標語彙が違うだけで構造は同一なので、info 行パースは uci.ts の parseInfoLine を **そのまま
 *   共有**する（DRY・二重メンテ回避）。USI の pv 手（"7g7f" / "P*5e" / "7g7f+"）も空白区切りトークンとして
 *   問題なく通る。
 *
 * WHY bestmove だけ結果型を分離するか（Codex ゲート① #5 の核心）:
 *   UCI の bestmove は「手 or (none)」の 2 値だが、USI は将棋特有で
 *     bestmove <usi> / bestmove resign(投了) / bestmove win(入玉宣言勝ち) / bestmove (none)
 *   の 4 状態を返しうる。これを UCI と同じ「string | null」に潰すと、"resign"/"win" が
 *   あたかも指し手文字列として下流に流れて事故る（例: 盤に "resign" を着手しようとする）。
 *   よって USI 専用に UsiBestMove 判別 union を切り、呼び出し側（yaneuraou.ts / 将来の AI対局）に
 *   「投了・宣言勝ち・手なし・実手」を型で強制的に区別させる。
 */

// info 行は UCI と同型のため parseInfoLine を共有（USI 用に別名エクスポートも用意）。
import { parseInfoLine } from './uci';
export { parseInfoLine };
export { parseInfoLine as parseUsiInfoLine } from './uci';

/**
 * USI の bestmove 行の判別 union。
 *   - move:   実際の指し手（usi = "7g7f" 等）
 *   - resign: 投了（エンジンが負けを認めた）
 *   - win:    入玉宣言勝ち
 *   - none:   合法手なし/該当なし（"(none)" や空）
 */
export type UsiBestMove =
  { kind: 'move'; usi: string } | { kind: 'resign' } | { kind: 'win' } | { kind: 'none' };

/**
 * USI の `bestmove ...` 行を判別 union に解析する。bestmove 行でなければ null。
 *
 * 例:
 *   "bestmove 7g7f ponder 3c3d" → { kind:'move', usi:'7g7f' }
 *   "bestmove resign"           → { kind:'resign' }
 *   "bestmove win"              → { kind:'win' }
 *   "bestmove (none)"           → { kind:'none' }
 */
export function parseUsiBestMove(line: string): UsiBestMove | null {
  if (!line.startsWith('bestmove')) return null;
  const token = line.split(/\s+/)[1];
  if (!token || token === '(none)') return { kind: 'none' };
  if (token === 'resign') return { kind: 'resign' };
  if (token === 'win') return { kind: 'win' };
  return { kind: 'move', usi: token };
}
