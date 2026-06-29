import type { PvLine, Score } from '../core/types';

/** UCI の `info ...` 行を解析する。解析対象でなければ null。 */
export function parseInfoLine(line: string): (PvLine & { depth: number }) | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;

  const tokens = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let score: Score | null = null;
  let moves: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') {
      depth = Number(tokens[i + 1]) || 0;
    } else if (t === 'multipv') {
      multipv = Number(tokens[i + 1]) || 1;
    } else if (t === 'score') {
      const kind = tokens[i + 1];
      const value = Number(tokens[i + 2]) || 0;
      if (kind === 'cp') score = { type: 'cp', value };
      else if (kind === 'mate') score = { type: 'mate', value };
    } else if (t === 'pv') {
      moves = tokens.slice(i + 1);
      break;
    }
  }

  if (!score || moves.length === 0) return null;
  return { depth, multipv, score, moves };
}

/** UCI の `bestmove e2e4 ponder ...` 行から最善手(UCI)を取り出す。 */
export function parseBestMove(line: string): string | null {
  if (!line.startsWith('bestmove')) return null;
  const m = line.split(/\s+/)[1];
  return m && m !== '(none)' ? m : null;
}
