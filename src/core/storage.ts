/**
 * storage.ts — localStorage 永続化ユーティリティ
 *
 * WHY 純関数に切り出すか:
 *   ハッシュ・シリアライズ・デシリアライズ・URL エンコードは副作用のない純関数なので
 *   vitest で回帰検知できる。localStorage への読み書き(副作用)だけを薄いラッパに分離する。
 *
 * スキーマバージョン:
 *   SCHEMA_VERSION を上げると旧データは null を返してシレっと無視する。
 *   マイグレーションは行わない(セッションが消えるだけで事故にならない小規模アプリ)。
 *
 * QuotaExceeded 対策:
 *   書き込み系は try/catch で握る。書き込み失敗は無視し既存データを壊さない。
 *
 * ストレージキー命名規則:
 *   "cj:" プレフィックスで他アプリとの衝突を避ける。
 *   "cj:ctx:<pgnHash>"  = 解析済みコンテキスト
 *   "cj:session"        = セッション(最終棋譜・レベル・向き・ヒント既読)
 */

import type { ExplanationContext } from './types';

/** 破壊的スキーマ変更時にインクリメントする。旧データは無視される。 */
const SCHEMA_VERSION = 1;

/** コンテキスト保存キーのプレフィックス。後ろに pgnHash が付く。 */
const CONTEXTS_KEY_PREFIX = 'cj:ctx:';

/** セッション保存キー。 */
const SESSION_KEY = 'cj:session';

// ── 純関数(テスト対象) ───────────────────────────────────────

/**
 * PGN 文字列の djb2 ハッシュ(16進小文字)を返す。
 *
 * WHY djb2 か:
 *   Web Crypto API は非同期 / ライブラリ追加禁止 / djb2 は実装1行・高速・
 *   同一文字列で必ず同じ値 → ストレージキーとして十分。
 *   衝突確率は 2^32 に 1 回程度で、一ユーザーが数百棋譜を扱うこのアプリでは無視できる。
 *
 * 正規化: CRLF → LF 統一 + 前後トリムだけ行い、それ以外は素のまま。
 * 全く同じ棋譜テキストは必ず同じハッシュになる。
 */
export function hashPgn(pgn: string): string {
  // CRLF を LF に統一し、前後の空白を除去
  const normalized = pgn.replace(/\r\n/g, '\n').trim();
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    // djb2: h = h * 33 XOR charCode。unsigned 32-bit に丸める。
    h = (((h << 5) + h) ^ normalized.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/** serializeContexts / deserializeContexts のラップするペイロード型。 */
interface ContextsPayload {
  version: number;
  data: Record<string, ExplanationContext>; // JSON は文字列キーのみ
}

/** ContextRecord を バージョン付き JSON 文字列にシリアライズする。 */
export function serializeContexts(data: Record<number, ExplanationContext>): string {
  const payload: ContextsPayload = { version: SCHEMA_VERSION, data };
  return JSON.stringify(payload);
}

/**
 * JSON 文字列から ContextRecord をデシリアライズする。
 *
 * バージョン不一致・JSON 破損・型不正は null を返す。
 * 呼び出し元は null を「キャッシュなし」として扱い、新規解析を開始すればよい。
 */
export function deserializeContexts(json: string): Record<number, ExplanationContext> | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Partial<ContextsPayload>;
    if (p.version !== SCHEMA_VERSION) return null;
    if (typeof p.data !== 'object' || p.data === null) return null;

    // JSON のキーは文字列なので number に変換して返す
    const result: Record<number, ExplanationContext> = {};
    for (const [k, v] of Object.entries(p.data)) {
      const ply = Number(k);
      if (!Number.isNaN(ply) && typeof v === 'object' && v !== null) {
        result[ply] = v as ExplanationContext;
      }
    }
    return result;
  } catch {
    return null;
  }
}

/** セッション永続化データの型。 */
export interface SessionData {
  pgn: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  orientation: 'white' | 'black';
  hintDismissed: boolean;
}

/** セッションデータを バージョン付き JSON 文字列にシリアライズする。 */
export function serializeSession(data: SessionData): string {
  return JSON.stringify({ version: SCHEMA_VERSION, ...data });
}

/**
 * JSON 文字列から SessionData をデシリアライズする。
 * 破損・バージョン不一致・必須フィールド不正は null を返す。
 */
export function deserializeSession(json: string): SessionData | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;

    if (p['version'] !== SCHEMA_VERSION) return null;
    if (typeof p['pgn'] !== 'string') return null;

    const level = p['level'];
    if (level !== 'beginner' && level !== 'intermediate' && level !== 'advanced') return null;

    const orientation = p['orientation'];
    if (orientation !== 'white' && orientation !== 'black') return null;

    return {
      pgn: p['pgn'] as string,
      level,
      orientation,
      hintDismissed: Boolean(p['hintDismissed']),
    };
  } catch {
    return null;
  }
}

// ── 共有URL エンコード/デコード ──────────────────────────────────

/**
 * PGN を URL-safe な base64url 文字列にエンコードする。
 *
 * WHY TextEncoder か:
 *   旧 escape()/unescape() は非推奨。TextEncoder は UTF-8 バイト列に変換するため
 *   日本語コメントを含む PGN も正しくエンコードできる。
 *
 * base64url (RFC 4648 §5): '+' → '-', '/' → '_', '=' パディング除去。
 */
export function encodePgnForUrl(pgn: string): string {
  // UTF-8 バイト列に変換
  const bytes = new TextEncoder().encode(pgn);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * base64url 文字列から PGN をデコードする。
 * 破損・無効な base64 は null を返す。
 */
export function decodePgnFromUrl(encoded: string): string | null {
  try {
    // base64url → 通常 base64 に戻す
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    // パディング補完
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(padLen);
    const binary = atob(padded);
    // Latin-1 バイナリ → UTF-8 Uint8Array → 文字列
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ── localStorage 操作(副作用) ─────────────────────────────────

/**
 * 解析済みコンテキストを localStorage に保存する。
 *
 * QuotaExceededError と SecurityError は無視する。
 * WHY 無視するか: 書き込み失敗は「次回再解析が必要になる」だけで既存データは消えない。
 * 失敗を通知してもユーザーがとれるアクションがないためサイレントにする。
 */
export function saveContextsToStorage(
  pgnHash: string,
  data: Record<number, ExplanationContext>,
): void {
  try {
    localStorage.setItem(CONTEXTS_KEY_PREFIX + pgnHash, serializeContexts(data));
  } catch {
    // QuotaExceededError / SecurityError → 無視
  }
}

/**
 * localStorage から解析済みコンテキストを読み込む。
 * 存在しない・破損の場合は null を返す。
 */
export function loadContextsFromStorage(
  pgnHash: string,
): Record<number, ExplanationContext> | null {
  try {
    const json = localStorage.getItem(CONTEXTS_KEY_PREFIX + pgnHash);
    if (!json) return null;
    return deserializeContexts(json);
  } catch {
    return null;
  }
}

/** セッションデータを localStorage に保存する。 */
export function saveSessionToStorage(data: SessionData): void {
  try {
    localStorage.setItem(SESSION_KEY, serializeSession(data));
  } catch {
    // QuotaExceededError → 無視
  }
}

/** localStorage からセッションデータを読み込む。 */
export function loadSessionFromStorage(): SessionData | null {
  try {
    const json = localStorage.getItem(SESSION_KEY);
    if (!json) return null;
    return deserializeSession(json);
  } catch {
    return null;
  }
}
