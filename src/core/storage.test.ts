import {
  hashPgn,
  serializeContexts,
  deserializeContexts,
  serializeSession,
  deserializeSession,
  encodePgnForUrl,
  decodePgnFromUrl,
  type SessionData,
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
