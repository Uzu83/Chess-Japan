import { beforeEach, vi } from 'vitest';
import {
  hashPgn,
  serializeContexts,
  deserializeContexts,
  serializeSession,
  deserializeSession,
  encodePgnForUrl,
  decodePgnFromUrl,
  encodeShareParam,
  decodeShareParam,
  serializePlayedGames,
  deserializePlayedGames,
  appendPlayedGame,
  savePlayedGame,
  loadPlayedGames,
  deletePlayedGame,
  serializeRating,
  deserializeRating,
  playedGameKind,
  loadRatingFor,
  saveRatingFor,
  loadRating,
  type SessionData,
  type PlayedGame,
  type RatingData,
} from './storage';
import type { ExplanationContext } from './types';

// ── テストヘルパー ────────────────────────────────────────────

function makeCtx(evalAfter: number): ExplanationContext {
  return {
    fenOrSfen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    evalAfter,
    quality: 'good',
  };
}

const BASE_SESSION: SessionData = {
  pgn: '[Event "Test"]\n\n1. e4 e5 *',
  level: 'beginner',
  orientation: 'white',
  hintDismissed: false,
};

// ── hashPgn ──────────────────────────────────────────────────

describe('hashPgn', () => {
  it('同じ文字列は常に同じハッシュを返す(決定論的)', () => {
    const pgn = '[Event "Test"]\n\n1. e4 e5 *';
    expect(hashPgn(pgn)).toBe(hashPgn(pgn));
  });

  it('異なる文字列は異なるハッシュを返す', () => {
    const a = '1. e4 e5 *';
    const b = '1. d4 d5 *';
    expect(hashPgn(a)).not.toBe(hashPgn(b));
  });

  it('CRLF と LF を同一視する(改行コード正規化)', () => {
    const lf = '1. e4 e5\n*';
    const crlf = '1. e4 e5\r\n*';
    expect(hashPgn(lf)).toBe(hashPgn(crlf));
  });

  it('前後の空白・改行をトリムして同一視する', () => {
    const bare = '1. e4 e5 *';
    const padded = '  1. e4 e5 *  \n';
    expect(hashPgn(bare)).toBe(hashPgn(padded));
  });

  it('空文字は決定論的なハッシュを返す(例外を投げない)', () => {
    expect(() => hashPgn('')).not.toThrow();
    expect(typeof hashPgn('')).toBe('string');
  });

  it('16進数文字列(小文字 a-f 0-9)を返す', () => {
    const h = hashPgn('1. e4 *');
    expect(h).toMatch(/^[0-9a-f]+$/);
  });
});

// ── serializeContexts / deserializeContexts ──────────────────

describe('serializeContexts / deserializeContexts', () => {
  it('ラウンドトリップ: 保存して取り出すと元に戻る', () => {
    const data: Record<number, ExplanationContext> = {
      0: makeCtx(100),
      3: makeCtx(-50),
      7: makeCtx(0),
    };
    const json = serializeContexts(data);
    const restored = deserializeContexts(json);
    expect(restored).not.toBeNull();
    expect(restored![0]?.evalAfter).toBe(100);
    expect(restored![3]?.evalAfter).toBe(-50);
    expect(restored![7]?.evalAfter).toBe(0);
  });

  it('バージョン不一致は null を返す', () => {
    const json = JSON.stringify({ version: 999, data: {} });
    expect(deserializeContexts(json)).toBeNull();
  });

  it('JSON 破損は null を返す(例外を投げない)', () => {
    expect(deserializeContexts('not json at all')).toBeNull();
    expect(deserializeContexts('{"version": 1}')).toBeNull(); // data なし
    expect(deserializeContexts('')).toBeNull();
  });

  it('空の contexts はラウンドトリップで空オブジェクトを返す', () => {
    const json = serializeContexts({});
    const restored = deserializeContexts(json);
    expect(restored).toEqual({});
  });

  it('キーが文字列でも数値に変換して返す(JSON の制約)', () => {
    const json = JSON.stringify({ version: 1, data: { '5': makeCtx(42) } });
    const restored = deserializeContexts(json);
    expect(restored).not.toBeNull();
    expect(restored![5]).toBeDefined();
    expect(restored![5]?.evalAfter).toBe(42);
  });
});

// ── serializeSession / deserializeSession ─────────────────────

describe('serializeSession / deserializeSession', () => {
  it('ラウンドトリップ: 保存して取り出すと元に戻る', () => {
    const json = serializeSession(BASE_SESSION);
    const restored = deserializeSession(json);
    expect(restored).not.toBeNull();
    expect(restored).toEqual(BASE_SESSION);
  });

  it('hintDismissed=true も正しく保存/復元できる', () => {
    const data: SessionData = { ...BASE_SESSION, hintDismissed: true };
    const restored = deserializeSession(serializeSession(data));
    expect(restored?.hintDismissed).toBe(true);
  });

  it('全 level 値が正しく往復する', () => {
    for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
      const data: SessionData = { ...BASE_SESSION, level };
      const restored = deserializeSession(serializeSession(data));
      expect(restored?.level).toBe(level);
    }
  });

  it('orientation black も正しく往復する', () => {
    const data: SessionData = { ...BASE_SESSION, orientation: 'black' };
    const restored = deserializeSession(serializeSession(data));
    expect(restored?.orientation).toBe('black');
  });

  it('バージョン不一致は null を返す', () => {
    const json = JSON.stringify({ version: 0, ...BASE_SESSION });
    expect(deserializeSession(json)).toBeNull();
  });

  it('必須フィールド pgn が欠落すると null を返す', () => {
    // pgn を除いたオブジェクトを直接構築(デストラクチャリングで未使用変数を避ける)
    const json = JSON.stringify({
      version: 1,
      level: BASE_SESSION.level,
      orientation: BASE_SESSION.orientation,
      hintDismissed: BASE_SESSION.hintDismissed,
    });
    expect(deserializeSession(json)).toBeNull();
  });

  it('level が不正値のとき null を返す', () => {
    const json = JSON.stringify({ version: 1, ...BASE_SESSION, level: 'expert' });
    expect(deserializeSession(json)).toBeNull();
  });

  it('orientation が不正値のとき null を返す', () => {
    const json = JSON.stringify({ version: 1, ...BASE_SESSION, orientation: 'up' });
    expect(deserializeSession(json)).toBeNull();
  });

  it('JSON 破損は null を返す', () => {
    expect(deserializeSession('broken json')).toBeNull();
    expect(deserializeSession('')).toBeNull();
  });
});

// ── encodePgnForUrl / decodePgnFromUrl ────────────────────────

describe('encodePgnForUrl / decodePgnFromUrl', () => {
  const PGN_ASCII = '[Event "Test"]\n\n1. e4 e5 2. Nf3 *';
  const PGN_UNICODE = '[Comment "テスト棋譜"]\n\n1. e4 e5 *'; // 日本語コメント

  it('ASCII PGN のラウンドトリップ', () => {
    const encoded = encodePgnForUrl(PGN_ASCII);
    expect(decodePgnFromUrl(encoded)).toBe(PGN_ASCII);
  });

  it('Unicode(日本語) PGN のラウンドトリップ', () => {
    const encoded = encodePgnForUrl(PGN_UNICODE);
    expect(decodePgnFromUrl(encoded)).toBe(PGN_UNICODE);
  });

  it('エンコード結果は URL-safe 文字列(+/= を含まない)', () => {
    // base64url は +→-, /→_, = を除去する
    const encoded = encodePgnForUrl(PGN_ASCII);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]*$/);
  });

  it('破損した文字列は null を返す(例外を投げない)', () => {
    expect(decodePgnFromUrl('!!!!invalid!!!!')).toBeNull();
    expect(decodePgnFromUrl('')).toBe(''); // 空は空文字列(デコード成功)
  });

  it('長い PGN もラウンドトリップできる', () => {
    // 100手程度のサンプル PGN
    const longPgn = '[Event "Opera Game"]\n\n' + '1. e4 e5 '.repeat(30) + '*';
    const encoded = encodePgnForUrl(longPgn);
    expect(decodePgnFromUrl(encoded)).toBe(longPgn);
  });
});

// ── encodeShareParam / decodeShareParam（種別つき共有リンク・後方互換） ──

describe('encodeShareParam / decodeShareParam', () => {
  const PGN = '[Event "Test"]\n\n1. e4 e5 *';
  // 日本語を含む KIF（種別プレフィックス + UTF-8 base64 の両方を検証する）
  const KIF = '手数----指手---------消費時間--\n   1 ７六歩(77)   ( 0:00/00:00:00)\n';

  it('チェスは後方互換のためプレフィックス無し（＝生の encodePgnForUrl と同一出力）', () => {
    // 既に配布済みのチェス共有URLを壊さないための最重要不変条件。
    expect(encodeShareParam('chess', PGN)).toBe(encodePgnForUrl(PGN));
  });

  it('旧フォーマット（プレフィックス無し base64url）はチェスとして復号できる', () => {
    const legacy = encodePgnForUrl(PGN); // 旧URLが持っていた形
    expect(decodeShareParam(legacy)).toEqual({ kind: 'chess', text: PGN });
  });

  it('チェスのラウンドトリップ', () => {
    expect(decodeShareParam(encodeShareParam('chess', PGN))).toEqual({ kind: 'chess', text: PGN });
  });

  it('将棋は s~ プレフィックスつきで、日本語 KIF もラウンドトリップする', () => {
    const enc = encodeShareParam('shogi', KIF);
    expect(enc.startsWith('s~')).toBe(true);
    expect(decodeShareParam(enc)).toEqual({ kind: 'shogi', text: KIF });
  });

  it("明示的な 'c~' プレフィックスもチェスとして復号する", () => {
    expect(decodeShareParam(`c~${encodePgnForUrl(PGN)}`)).toEqual({ kind: 'chess', text: PGN });
  });

  it('破損した本体は null（例外を投げない）', () => {
    expect(decodeShareParam('s~!!!invalid!!!')).toBeNull();
    expect(decodeShareParam('!!!invalid!!!')).toBeNull();
  });

  it('チェスとして復号したものが将棋に化けない（種別の取り違え防止）', () => {
    // チェス出力（プレフィックス無し）は必ず kind:chess。将棋は必ず s~。
    const chessEnc = encodeShareParam('chess', PGN);
    const shogiEnc = encodeShareParam('shogi', KIF);
    expect(decodeShareParam(chessEnc)?.kind).toBe('chess');
    expect(decodeShareParam(shogiEnc)?.kind).toBe('shogi');
  });
});

// ── 対局履歴(PlayedGame) ─────────────────────────────────────

/** テスト用の PlayedGame を作る。id/createdAt を明示できるようにして順序検証を安定化。 */
function makeGame(id: string, createdAt = 0): PlayedGame {
  return {
    id,
    createdAt,
    pgn: `[White "You"]\n\n1. e4 e5 *`,
    result: '1-0',
    outcome: 'win',
    youColor: 'white',
    opponent: 'AI (ふつう)',
    moveCount: 2,
  };
}

describe('serializePlayedGames / deserializePlayedGames', () => {
  it('ラウンドトリップできる', () => {
    const games = [makeGame('a', 1), makeGame('b', 2)];
    const json = serializePlayedGames(games);
    expect(deserializePlayedGames(json)).toEqual(games);
  });

  it('バージョン不一致は null', () => {
    const json = JSON.stringify({ version: 999, games: [makeGame('a')] });
    expect(deserializePlayedGames(json)).toBeNull();
  });

  it('games が配列でなければ null', () => {
    expect(deserializePlayedGames(JSON.stringify({ version: 1, games: {} }))).toBeNull();
  });

  it('壊れた要素は除外され、正しい要素だけ残る', () => {
    const json = JSON.stringify({
      version: 1,
      games: [makeGame('ok'), { id: 'broken' /* 必須欠落 */ }, { not: 'a game' }],
    });
    const result = deserializePlayedGames(json);
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe('ok');
  });

  it('破損 JSON は null(例外を投げない)', () => {
    expect(deserializePlayedGames('{{{')).toBeNull();
  });
});

// ── game タグ（chess/shogi 移行）───────────────────────────────

describe('PlayedGame の game タグ（後方互換移行）', () => {
  it('game 欠落レコード（旧チェス履歴）も型ガードを通り、round-trip で欠落のまま保たれる', () => {
    // makeGame は game を持たない = 旧レコード相当。
    const games = [makeGame('legacy', 1)];
    const restored = deserializePlayedGames(serializePlayedGames(games));
    expect(restored).toEqual(games); // game を注入しない（純粋 round-trip）
    expect(restored?.[0].game).toBeUndefined();
  });

  it('game=shogi を明示したレコードは値を保って往復する', () => {
    const g: PlayedGame = { ...makeGame('s'), game: 'shogi', pgn: '手合割：平手\n' };
    const restored = deserializePlayedGames(serializePlayedGames([g]));
    expect(restored?.[0].game).toBe('shogi');
  });

  it('game が不正値のレコードは型ガードで除外される', () => {
    const json = JSON.stringify({
      version: 1,
      games: [makeGame('ok'), { ...makeGame('bad'), game: 'checkers' }],
    });
    const result = deserializePlayedGames(json);
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe('ok');
  });

  it('playedGameKind: 欠落は chess、明示はその値', () => {
    expect(playedGameKind(makeGame('a'))).toBe('chess');
    expect(playedGameKind({ ...makeGame('b'), game: 'chess' })).toBe('chess');
    expect(playedGameKind({ ...makeGame('c'), game: 'shogi' })).toBe('shogi');
  });
});

describe('appendPlayedGame', () => {
  it('新しい対局が先頭に入る', () => {
    const result = appendPlayedGame([makeGame('old')], makeGame('new'));
    expect(result.map((g) => g.id)).toEqual(['new', 'old']);
  });

  it('上限(50件)を超えたら古いものから捨てる', () => {
    // 既存50件 + 新規1件 → 51件になるが 50 に丸められ、最古が落ちる
    const existing = Array.from({ length: 50 }, (_, i) => makeGame(`g${i}`, i));
    const result = appendPlayedGame(existing, makeGame('newest', 100));
    expect(result).toHaveLength(50);
    expect(result[0].id).toBe('newest');
    // appendPlayedGame は [new, ...existing].slice(0,50)。呼び出し側が「新しい順」を保つ前提なので
    // 押し出されるのは末尾(=最古の位置) g49。先頭寄りの g0 は残る。
    expect(result.some((g) => g.id === 'g49')).toBe(false);
    expect(result.some((g) => g.id === 'g0')).toBe(true);
  });
});

/*
 * jsdom の既定オリジン(about:blank)では localStorage が使えないことがあるため、
 * 副作用テスト専用に最小のインメモリ実装を差し込む。storage.ts は呼び出し時に
 * グローバル localStorage を参照するので、stubGlobal で置換すれば実装は素通しで検証できる。
 */
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

describe('savePlayedGame / loadPlayedGames / deletePlayedGame (localStorage)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('保存した対局を読み戻せる', () => {
    savePlayedGame(makeGame('x'));
    const loaded = loadPlayedGames();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('x');
  });

  it('未保存時は空配列を返す', () => {
    expect(loadPlayedGames()).toEqual([]);
  });

  it('複数保存すると新しい順に並ぶ', () => {
    savePlayedGame(makeGame('first'));
    savePlayedGame(makeGame('second'));
    expect(loadPlayedGames().map((g) => g.id)).toEqual(['second', 'first']);
  });

  it('指定IDを削除できる', () => {
    savePlayedGame(makeGame('keep'));
    savePlayedGame(makeGame('drop'));
    const after = deletePlayedGame('drop');
    expect(after.map((g) => g.id)).toEqual(['keep']);
    expect(loadPlayedGames().map((g) => g.id)).toEqual(['keep']);
  });
});

// ── ローカル内部レート(RatingData) ───────────────────────────

describe('serializeRating / deserializeRating', () => {
  it('ラウンドトリップできる', () => {
    const data: RatingData = { rating: 1216, games: 3 };
    expect(deserializeRating(serializeRating(data))).toEqual(data);
  });

  it('バージョン不一致・破損・非有限数は null', () => {
    expect(deserializeRating(JSON.stringify({ version: 99, rating: 1200, games: 0 }))).toBeNull();
    expect(deserializeRating('{{{')).toBeNull();
    expect(deserializeRating(JSON.stringify({ version: 1, rating: 'high', games: 0 }))).toBeNull();
    expect(
      deserializeRating(JSON.stringify({ version: 1, rating: Infinity, games: 0 })),
    ).toBeNull();
  });
});

describe('loadRatingFor / saveRatingFor（kind 別レート枠）', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('chess は既存 cj:rating に委譲する（loadRating と同一の値を読む）', () => {
    saveRatingFor('chess', { rating: 1350, games: 5 });
    expect(loadRatingFor('chess')).toEqual({ rating: 1350, games: 5 });
    // 既存 API と同じキーを触っていることの確認（挙動不変の保証）
    expect(loadRating()).toEqual({ rating: 1350, games: 5 });
  });

  it('shogi は別キーに保存され、chess と混ざらない', () => {
    saveRatingFor('chess', { rating: 1350, games: 5 });
    saveRatingFor('shogi', { rating: 900, games: 2 });
    expect(loadRatingFor('shogi')).toEqual({ rating: 900, games: 2 });
    expect(loadRatingFor('chess')).toEqual({ rating: 1350, games: 5 }); // 汚染されない
  });

  it('未保存の shogi レートは null（呼び出し側が初期値で初期化）', () => {
    expect(loadRatingFor('shogi')).toBeNull();
  });
});
