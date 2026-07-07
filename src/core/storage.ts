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
 *   "cj:games"          = 対局履歴(AI戦で指した対局のリスト・新しい順。chess/shogi 混在。game タグで区別)
 *   "cj:rating"         = チェスのローカル内部レート(AI戦のレート戦で変動。Phase 2C でクラウド同期に昇格予定)
 *   "cj:rating:shogi"   = 将棋のローカル内部レート(チェスと別枠。別ゲームの強さは別物なので混ぜない — Codex ゲート① 質問3回答)
 */

import type { ExplanationContext, GameKind } from './types';

/** 破壊的スキーマ変更時にインクリメントする。旧データは無視される。 */
const SCHEMA_VERSION = 1;

/** コンテキスト保存キーのプレフィックス。後ろに pgnHash が付く。 */
const CONTEXTS_KEY_PREFIX = 'cj:ctx:';

/** セッション保存キー。 */
const SESSION_KEY = 'cj:session';

/** 対局履歴の保存キー。 */
const GAMES_KEY = 'cj:games';

/**
 * 対局履歴の保存上限(件数)。超過分は古いものから捨てる(リングバッファ的運用)。
 *
 * WHY 50 か: 1対局の PGN は 40手で ~250 文字。50件でも ~12KB 程度と localStorage(5MB)に
 * 対して十分小さい。無制限にすると解析キャッシュ(cj:ctx:*)と競合して QuotaExceeded を
 * 誘発しうるので、体験上「最近の対局が見れれば十分」という割り切りで上限を設ける。
 * 上限を増やすときは他キー(解析キャッシュ)との合計容量に注意すること。
 */
const MAX_PLAYED_GAMES = 50;

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

// ── 対局履歴(AI戦で指した対局) ─────────────────────────────────

/**
 * 保存する1対局分のメタ + 棋譜。
 *
 * WHY PGN をそのまま持つか:
 *   PGN 1本あれば ChessGame.fromPgn で完全に再現でき、既存の ReviewView にそのまま渡して
 *   「振り返り」に接続できる。独自の局面列を持つより PGN 一本化の方が資産(レビュー機能)を活かせる。
 *
 * outcome は「人間(あなた)視点」の勝敗:
 *   result('1-0'等)は白視点の絶対表記。youColor と組み合わせて win/loss/draw を UI が出すのは
 *   毎回の変換が面倒なので、保存時に人間視点の outcome を確定させておく(表示を単純化)。
 */
export interface PlayedGame {
  /** 一意ID(呼び出し側で crypto.randomUUID 等で採番)。 */
  id: string;
  /** 作成時刻(epoch ms、呼び出し側で採番)。 */
  createdAt: number;
  /**
   * 棋譜文字列。chess=ヘッダ付き PGN / shogi=KIF。
   *
   * WHY 将棋の KIF もこの `pgn` フィールドに入れるか（フィールド名の負債を許容する判断・Codex ゲート① 修正 #3）:
   *   本来なら `record`/`text` のような中立名が正しい。しかし `pgn` を `record` にリネームすると
   *   ①既存 localStorage の全レコードが isPlayedGame の型ガードを外れて丸ごと落ちる（履歴消失）
   *   ②`serializePlayedGames`/`deserializePlayedGames` の後方互換が壊れる。
   *   履歴を1件も失わないことを最優先し、フィールド名の負債（"pgn" に KIF が入る不正確さ）を
   *   あえて許容する。どちらの棋譜かは `game` タグで判別する（振り返り接続もこのタグで分岐）。
   */
  pgn: string;
  /** 絶対表記の結果: '1-0' | '0-1' | '1/2-1/2' | '*'。 */
  result: string;
  /** 人間(あなた)視点の結末。 */
  outcome: 'win' | 'loss' | 'draw' | 'unfinished';
  /** あなたが持っていた色。 */
  youColor: 'white' | 'black';
  /** 対戦相手の表示名(例 "AI (ふつう)")。 */
  opponent: string;
  /** 手数。 */
  moveCount: number;
  /**
   * ゲーム種別。**optional**。
   *
   * WHY optional か（既存履歴を1件も落とさない移行・Codex ゲート① 修正 #3）:
   *   Phase 4-2 以前に保存されたレコードにはこのフィールドが無い。必須にすると型ガードで
   *   旧レコードが全滅する。よって optional にし、読み込み側は `game ?? 'chess'`（= playedGameKind）で
   *   欠落を chess とみなす。デシリアライザは値を注入せず素通し（round-trip の純粋性を保つため）。
   */
  game?: GameKind;
}

/**
 * レコードのゲーム種別を解決する（欠落＝旧チェス履歴 → 'chess'）。
 *
 * WHY デシリアライズ時に注入せずここで解決するか:
 *   deserializePlayedGames に `game: 'chess'` を注入すると、`game` を持たない既存レコードで
 *   round-trip（serialize→deserialize が入力と一致）が崩れ、既存テストのアサーションを壊す。
 *   よって永続層は値をそのまま保ち、**読み出し・フィルタ地点でこの関数を通して** 正規化する。
 */
export function playedGameKind(g: PlayedGame): GameKind {
  return g.game ?? 'chess';
}

/** 対局履歴リストのペイロード型(バージョン付き)。 */
interface PlayedGamesPayload {
  version: number;
  games: PlayedGame[];
}

/** PlayedGame らしさを検証する型ガード(壊れた要素を捨てるため)。 */
function isPlayedGame(v: unknown): v is PlayedGame {
  if (typeof v !== 'object' || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g['id'] === 'string' &&
    typeof g['createdAt'] === 'number' &&
    typeof g['pgn'] === 'string' &&
    typeof g['result'] === 'string' &&
    (g['outcome'] === 'win' ||
      g['outcome'] === 'loss' ||
      g['outcome'] === 'draw' ||
      g['outcome'] === 'unfinished') &&
    (g['youColor'] === 'white' || g['youColor'] === 'black') &&
    typeof g['opponent'] === 'string' &&
    typeof g['moveCount'] === 'number' &&
    // game は optional。欠落（旧チェス履歴）も許容し、存在する場合のみ値を検証する。
    (g['game'] === undefined || g['game'] === 'chess' || g['game'] === 'shogi')
  );
}

/** 対局履歴リストを バージョン付き JSON にシリアライズする(純関数)。 */
export function serializePlayedGames(games: PlayedGame[]): string {
  const payload: PlayedGamesPayload = { version: SCHEMA_VERSION, games };
  return JSON.stringify(payload);
}

/**
 * JSON から対局履歴リストをデシリアライズする(純関数)。
 * バージョン不一致・破損・非配列は null。個々の壊れた要素は型ガードで除外する。
 */
export function deserializePlayedGames(json: string): PlayedGame[] | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Partial<PlayedGamesPayload>;
    if (p.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(p.games)) return null;
    return p.games.filter(isPlayedGame);
  } catch {
    return null;
  }
}

/**
 * 新しい対局を先頭に足して上限で丸めたリストを返す(純関数)。
 * WHY 純関数に切る: 「先頭追加 + 上限カット」の順序ロジックはバグりやすいので
 * localStorage と切り離して vitest で固定する。
 */
export function appendPlayedGame(existing: PlayedGame[], game: PlayedGame): PlayedGame[] {
  // 新しい順(先頭が最新)。上限を超えたら末尾(古いもの)から捨てる。
  return [game, ...existing].slice(0, MAX_PLAYED_GAMES);
}

// ── ローカル内部レート(AI戦) ─────────────────────────────────

/** チェスのレート保存キー（歴史的キー。挙動不変のため名前は据え置き）。 */
const RATING_KEY = 'cj:rating';

/** 将棋のレート保存キー（チェスと別枠。Codex ゲート① 質問3回答）。 */
const RATING_SHOGI_KEY = 'cj:rating:shogi';

/** kind → レート保存キー。chess は既存キーへ委譲して従来挙動を1バイトも変えない。 */
function ratingKeyFor(kind: GameKind): string {
  return kind === 'shogi' ? RATING_SHOGI_KEY : RATING_KEY;
}

/**
 * ローカルレートの保存データ。
 * WHY games(レート戦の対局数)も持つか: 将来「⚡レート確定まであとN局」的な表示や、
 * Phase 2C のクラウド移行時に「このローカルレートは何局分の実績か」を判断する材料になる。
 */
export interface RatingData {
  rating: number;
  /** レート戦としてカウントした対局数。 */
  games: number;
}

/** レートを バージョン付き JSON にシリアライズ(純関数)。 */
export function serializeRating(data: RatingData): string {
  return JSON.stringify({ version: SCHEMA_VERSION, ...data });
}

/** JSON からレートをデシリアライズ(純関数)。破損・不正は null(呼び出し側が初期値を使う)。 */
export function deserializeRating(json: string): RatingData | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p['version'] !== SCHEMA_VERSION) return null;
    // 有限数のみ許可(NaN/Infinity/文字列の混入で表示や Elo 計算が壊れるのを防ぐ)
    if (typeof p['rating'] !== 'number' || !Number.isFinite(p['rating'])) return null;
    if (typeof p['games'] !== 'number' || !Number.isFinite(p['games'])) return null;
    return { rating: p['rating'], games: p['games'] };
  } catch {
    return null;
  }
}

/** localStorage からレートを読む。無し・破損は null(呼び出し側が INITIAL_RATING で初期化)。 */
export function loadRating(): RatingData | null {
  try {
    const json = localStorage.getItem(RATING_KEY);
    if (!json) return null;
    return deserializeRating(json);
  } catch {
    return null;
  }
}

/** レートを保存。書き込み失敗(Quota等)は握る(次回起動で古い値に戻るだけで事故にならない)。 */
export function saveRating(data: RatingData): void {
  try {
    localStorage.setItem(RATING_KEY, serializeRating(data));
  } catch {
    // QuotaExceeded / SecurityError → 無視
  }
}

/**
 * kind 別のレートを読む（chess は既存 cj:rating・shogi は cj:rating:shogi）。
 * 無し・破損は null（呼び出し側が INITIAL_RATING で初期化）。
 *
 * WHY loadRating/saveRating を残したまま Xxx For を足すか:
 *   既存の loadRating/saveRating（cj:rating 固定）はシグネチャ・挙動とも据え置く義務がある
 *   （OnboardingRatingDialog 等が依存・チェス経路を1挙動も変えない）。chess はここから委譲する。
 */
export function loadRatingFor(kind: GameKind): RatingData | null {
  if (kind === 'chess') return loadRating();
  try {
    const json = localStorage.getItem(ratingKeyFor(kind));
    if (!json) return null;
    return deserializeRating(json);
  } catch {
    return null;
  }
}

/** kind 別のレートを保存（chess は既存 saveRating へ委譲）。書き込み失敗は握る。 */
export function saveRatingFor(kind: GameKind, data: RatingData): void {
  if (kind === 'chess') return saveRating(data);
  try {
    localStorage.setItem(ratingKeyFor(kind), serializeRating(data));
  } catch {
    // QuotaExceeded / SecurityError → 無視
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

/** localStorage から対局履歴(新しい順)を読み込む。無し・破損は空配列。 */
export function loadPlayedGames(): PlayedGame[] {
  try {
    const json = localStorage.getItem(GAMES_KEY);
    if (!json) return [];
    return deserializePlayedGames(json) ?? [];
  } catch {
    return [];
  }
}

/**
 * 対局を履歴に保存し、更新後のリストを返す。
 * 先頭追加 + 上限カット(appendPlayedGame)。書き込み失敗(QuotaExceeded 等)は握って
 * 「計算上の新リスト」を返す(UI は即時反映でき、次回起動時に消えても事故にならない)。
 */
export function savePlayedGame(game: PlayedGame): PlayedGame[] {
  const next = appendPlayedGame(loadPlayedGames(), game);
  try {
    localStorage.setItem(GAMES_KEY, serializePlayedGames(next));
  } catch {
    // QuotaExceeded / SecurityError → 無視(既存の履歴は壊さない)
  }
  return next;
}

/** 指定IDの対局を履歴から削除し、更新後のリストを返す。 */
export function deletePlayedGame(id: string): PlayedGame[] {
  const next = loadPlayedGames().filter((g) => g.id !== id);
  try {
    localStorage.setItem(GAMES_KEY, serializePlayedGames(next));
  } catch {
    // 書き込み失敗は無視
  }
  return next;
}
