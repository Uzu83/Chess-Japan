import { describe, it, expect } from 'vitest';
import { uciToSan, uciLineToSan } from './notation';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('uciToSan', () => {
  it('初期局面の UCI を SAN に変換する', () => {
    expect(uciToSan(START, 'g1f3')).toBe('Nf3');
    expect(uciToSan(START, 'e2e4')).toBe('e4');
  });

  it('成りは =Q などの SAN になる', () => {
    // 白ポーン a7、a8 成り(King は e8 に退避)。a8=Q は黒Kへ王手なので SAN は "a8=Q+"。
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    expect(uciToSan(fen, 'a7a8q')).toContain('a8=Q'); // "+"(王手)が付くため toContain
    expect(uciToSan(fen, 'a7a8n')).toContain('N'); // アンダープロモーション
  });

  it('不正な UCI / 短すぎる入力は null', () => {
    expect(uciToSan(START, 'e2e5')).toBeNull(); // 非合法
    expect(uciToSan(START, 'zz')).toBeNull();
    expect(uciToSan(START, '')).toBeNull();
  });
});

describe('uciLineToSan', () => {
  it('UCI 手順を SAN 列に変換する', () => {
    const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
    expect(uciLineToSan(START, line)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('maxPlies で打ち切る', () => {
    const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
    expect(uciLineToSan(START, line, 3)).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('途中に不正手があればそこまで返す', () => {
    const line = ['e2e4', 'e7e5', 'x9x9', 'g1f3'];
    expect(uciLineToSan(START, line)).toEqual(['e4', 'e5']);
  });

  it('空配列は空を返す', () => {
    expect(uciLineToSan(START, [])).toEqual([]);
  });
});
