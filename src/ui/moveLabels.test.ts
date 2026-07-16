import { describe, it, expect } from 'vitest';
import { withMoveLabels, enrichStoredChessContexts } from './moveLabels';
import type { ExplanationContext } from '../core/types';

/*
 * moveLabels.test.ts
 *
 * chess/shogi 対称の withMoveLabels を検証する。期待値は既存の notation.test.ts /
 * shogiNotation.test.ts の変換結果に準拠する（変換ロジック自体はそちらでテスト済みなので、
 * ここでは「ExplanationContext への付与の仕方」——どのフィールドから何を作るか・undefined 規律——
 * を確認する）。
 */

const CHESS_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SHOGI_INITIAL_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('withMoveLabels: chess', () => {
  it('movePlayed/bestMove を SAN ラベルとして付与する', async () => {
    const ctx: ExplanationContext = {
      fenOrSfen: CHESS_START,
      movePlayed: 'e2e4',
      bestMove: 'g1f3',
      pv: ['g1f3', 'g8f6'],
    };
    const enriched = await withMoveLabels(ctx, 'chess');
    expect(enriched.movePlayedLabel).toBe('e4');
    expect(enriched.bestMoveLabel).toBe('Nf3');
    expect(enriched.pvLabels).toEqual(['Nf3', 'Nf6']);
  });

  it('pv 変換結果が空なら pvLabels は undefined（フォールバック経路を殺さない・F001）', async () => {
    const ctx: ExplanationContext = {
      fenOrSfen: CHESS_START,
      movePlayed: 'e2e4',
      bestMove: 'g1f3',
      pv: [], // 空PV
    };
    const enriched = await withMoveLabels(ctx, 'chess');
    expect(enriched.pvLabels).toBeUndefined();
  });

  it('movePlayed/bestMove が両方無ければ付与せず ctx をそのまま返す', async () => {
    const ctx: ExplanationContext = { fenOrSfen: CHESS_START };
    const enriched = await withMoveLabels(ctx, 'chess');
    expect(enriched).toEqual(ctx);
    expect(enriched.movePlayedLabel).toBeUndefined();
  });

  it('変換不能な手はラベルを付けず undefined にする（情報を失うが破壊しない）', async () => {
    const ctx: ExplanationContext = {
      fenOrSfen: CHESS_START,
      movePlayed: 'e2e5', // 非合法
      bestMove: 'g1f3',
    };
    const enriched = await withMoveLabels(ctx, 'chess');
    expect(enriched.movePlayedLabel).toBeUndefined();
    expect(enriched.bestMoveLabel).toBe('Nf3');
  });
});

describe('withMoveLabels: shogi', () => {
  it('movePlayed/bestMove を日本語ラベルとして付与する', async () => {
    // movePlayed/bestMove は「開始局面(fenOrSfen)から直接指せる1手」でなければならない
    // (usiToJapanese は指定局面からの合法手判定を内部で行うため)。pv は開始局面から順に
    // 適用される読み筋で、実バグの再現局面（▲２二角成 型の誤命名）に合わせている:
    // 7g7f, 3c3d, 8h2b+ → 最終手は「▲８八角成」ではなく「☗２二角成」が正解（usiLineToJapanese の
    // 既存テスト shogiNotation.test.ts と同じ期待値）。
    const ctx: ExplanationContext = {
      fenOrSfen: SHOGI_INITIAL_SFEN,
      movePlayed: '7g7f',
      bestMove: '2g2f',
      pv: ['7g7f', '3c3d', '8h2b+'],
    };
    const enriched = await withMoveLabels(ctx, 'shogi');
    expect(enriched.movePlayedLabel).toBe('☗７六歩');
    expect(enriched.bestMoveLabel).toBe('☗２六歩');
    expect(enriched.pvLabels).toEqual(['☗７六歩', '☖３四歩', '☗２二角成']); // 誤命名バグの正解
  });

  it('pv 変換結果が空なら pvLabels は undefined（F001。chess 分岐と同一規律）', async () => {
    const ctx: ExplanationContext = {
      fenOrSfen: SHOGI_INITIAL_SFEN,
      movePlayed: '7g7f',
      bestMove: '2g2f',
      pv: [],
    };
    const enriched = await withMoveLabels(ctx, 'shogi');
    expect(enriched.pvLabels).toBeUndefined();
  });

  it('movePlayed/bestMove が両方無ければ付与せず ctx をそのまま返す', async () => {
    const ctx: ExplanationContext = { fenOrSfen: SHOGI_INITIAL_SFEN };
    const enriched = await withMoveLabels(ctx, 'shogi');
    expect(enriched).toEqual(ctx);
    expect(enriched.movePlayedLabel).toBeUndefined();
  });
});

// ゲート② codex 異モデルレビュー F001（2026-07-16 accept）: ラベル機能追加より前に
// localStorage(cj:ctx:<pgnHash>)に保存された旧キャッシュにはラベルが無い。ReviewView.loadPgn は
// 復元直後に enrichStoredChessContexts を通すことで、既存ユーザーのローカルキャッシュにも
// ラベルを行き渡らせる（SCHEMA_VERSION は他データと共有のため不変。moveLabels.ts のコメント参照）。
describe('enrichStoredChessContexts', () => {
  it('ラベル無しの保存済み context を SAN ラベル付きに補完する', () => {
    const stored: Record<number, ExplanationContext> = {
      0: {
        fenOrSfen: CHESS_START,
        movePlayed: 'e2e4',
        bestMove: 'g1f3',
        pv: ['g1f3', 'g8f6'],
      },
    };
    const enriched = enrichStoredChessContexts(stored);
    expect(enriched[0].movePlayedLabel).toBe('e4');
    expect(enriched[0].bestMoveLabel).toBe('Nf3');
    expect(enriched[0].pvLabels).toEqual(['Nf3', 'Nf6']);
  });

  it('既にラベルがある context は値を変えない（冪等）', () => {
    const already: ExplanationContext = {
      fenOrSfen: CHESS_START,
      movePlayed: 'e2e4',
      movePlayedLabel: 'e4',
      bestMove: 'g1f3',
      bestMoveLabel: 'Nf3',
      pv: ['g1f3', 'g8f6'],
      pvLabels: ['Nf3', 'Nf6'],
    };
    const enriched = enrichStoredChessContexts({ 0: already });
    expect(enriched[0]).toEqual(already);
  });

  it('movePlayed も bestMove も無い context は素通しする', () => {
    const empty: ExplanationContext = { fenOrSfen: CHESS_START };
    const enriched = enrichStoredChessContexts({ 0: empty });
    expect(enriched[0]).toEqual(empty);
  });

  it('不正 UCI（変換不能）はラベル undefined のまま壊れない', () => {
    const broken: Record<number, ExplanationContext> = {
      0: {
        fenOrSfen: CHESS_START,
        movePlayed: 'e2e5', // 非合法
        bestMove: 'z9z9', // 不正座標
      },
    };
    const enriched = enrichStoredChessContexts(broken);
    expect(enriched[0].movePlayedLabel).toBeUndefined();
    expect(enriched[0].bestMoveLabel).toBeUndefined();
  });

  it('複数エントリを ply キーを保ったまま補完する', () => {
    const stored: Record<number, ExplanationContext> = {
      0: { fenOrSfen: CHESS_START, movePlayed: 'e2e4', bestMove: 'g1f3' },
      2: {
        fenOrSfen: CHESS_START,
        movePlayed: 'e2e4',
        movePlayedLabel: 'e4', // 既に補完済み(新仕様で保存された分)
        bestMove: 'g1f3',
      },
    };
    const enriched = enrichStoredChessContexts(stored);
    expect(Object.keys(enriched).sort()).toEqual(['0', '2']);
    expect(enriched[0].movePlayedLabel).toBe('e4');
    expect(enriched[2]).toEqual(stored[2]); // 冪等
  });
});
