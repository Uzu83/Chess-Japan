import { beforeEach, vi } from 'vitest';
import {
  hashPgn,
  serializeContexts,
  deserializeContexts,
  serializeSession,
  deserializeSession,
  encodePgnForUrl,
  decodePgnFromUrl,
  serializePlayedGames,
  deserializePlayedGames,
  appendPlayedGame,
  savePlayedGame,
  loadPlayedGames,
  deletePlayedGame,
  type SessionData,
  type PlayedGame,
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
