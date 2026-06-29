// 解説/対話リクエストの「純粋」検証・正規化ロジック。
//
// なぜ別ファイルに切り出すのか（WHY / 再発防止）:
//   - Edge Function 本体(index.ts)は Deno.serve / Deno.env など Deno グローバルに依存するため、
//     このリポジトリの Node/vitest ツールチェーンでは型チェックもテストもできない「死角」になる。
//   - そこで「攻撃面に直結する検証・正規化」だけを Deno 非依存の純関数として隔離し、
//     vitest でユニットテスト＋tsconfig で型チェックできるようにした（tsconfig.app.json の include に追加済み）。
//   - 同じ関数をフロント(src/explain/client.ts)からも呼んで送信前に弾く＝多層防御＋UX改善。
//     ただし「真の信頼境界はサーバ」。フロント検証はあくまで補助で、サーバ側を必ず通すこと。
//
// 設計の前提（Codex と合意したレビュー結果, 2026-06-29）:
//   - 公開 anon key で /functions/v1/explain を直叩きできる（Supabase 設計上 anon key は公開前提）。
//     => 「アプリUIを経由する」ことは制約にならない。サーバ側で“任意の悪意あるボディ”を想定して検証する。
//   - 未検証だと攻撃者が巨大/悪意あるコンテキストやプロンプト命令を送れて、コスト増・ログ汚染・
//     プロンプトインジェクション耐性低下につながる（重大度 medium、C2 直叩きと合わさり重要度上昇）。
//
// ここで“やらない”こと: レート制限・日次クォータ・Turnstile・キャッシュ本体は共有ストア(Supabase等)が必要なので
//   別タスク。ここは「形式・長さ・範囲の検証」と「キャッシュキー正規化」までに限定する（必要十分）。

/** リクエストボディのバイト上限。16KB。
 *  根拠: 1手分の構造化事実(FEN+UCI+PV上位K+短い履歴)は数KBに収まる。
 *  これを超える入力は正当な利用ではなく、コスト/ログ汚染リスクなので拒否する。
 *  名前どおり“バイト”で測ること（UTF-16 文字数ではない。多バイト日本語でズレるバグを防ぐ＝C3）。 */
export const MAX_BODY_BYTES = 16 * 1024;

/** 文字列の UTF-8 バイト長を返す。HTTP body の実バイト数判定に使う。
 *  なぜ str.length ではないか: JS の String#length は UTF-16 コードユニット数で、
 *  日本語・絵文字を含むと実バイト数と乖離する。16KB 制限を“バイト”で守るため TextEncoder を使う。 */
export function byteLengthOf(str: string): number {
  return new TextEncoder().encode(str).length;
}

export type Mode = 'explain' | 'followup';
export type GameKind = 'chess' | 'shogi';
export type MoveQuality = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
export type Level = 'beginner' | 'intermediate' | 'advanced';

export interface ExplainContext {
  fenOrSfen: string;
  movePlayed?: string;
  evalBefore?: number;
  evalAfter?: number;
  bestMove?: string;
  pv?: string[];
  quality?: MoveQuality;
}

export interface KnowledgeProfile {
  known: string[];
  unknown: string[];
  level?: Level;
}

export interface ExplainBody {
  mode: Mode;
  game: GameKind;
  context: ExplainContext;
  question?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  profile?: KnowledgeProfile;
}

// ---- 各種上限（マジックナンバーの根拠をコメントで固定。緩めると攻撃面/コストが増える） ----
const LIMITS = {
  // FEN は通常 ~90 文字、SFEN(将棋) でも余裕を見て 200。これを超える盤面表現は不正入力。
  fenMax: 200,
  // UCI 手は最大 "e7e8q"=5 文字。将棋の USI も "P*5e"/"7g7f+" 等で十分 8 に収まる。余裕を見て 10。
  moveMax: 10,
  // 評価値(cp)の妥当域。詰みは別途 mate 換算で ±100000 付近まで来るため広めに。
  // これを超える値は分類ロジックの想定外＝壊れた/悪意ある入力。
  evalAbsMax: 1_000_000,
  // 読み筋(PV)は解析深さ分。1手解説に上位手を数十手も渡す必要はない。トークン/コスト防衛で 40 上限。
  pvMaxItems: 40,
  // 追問の質問文。長文を投げてトークンを膨らませる攻撃を抑止。500 文字で日本語の質問は十分。
  questionMax: 500,
  // 対話履歴。直近文脈だけ要るので 10 ターン上限。各メッセージも 2000 文字で切る。
  historyMaxItems: 10,
  historyContentMax: 2000,
  // 用語プロファイル。pin/fork 等の語彙数は現実的に数十。各語も短い。自由文インジェクション抑止。
  profileMaxItems: 100,
  profileItemMax: 40,
} as const;

const QUALITIES: readonly MoveQuality[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];
const LEVELS: readonly Level[] = ['beginner', 'intermediate', 'advanced'];

export type ValidationResult = { ok: true; value: ExplainBody } | { ok: false; error: string };

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
/** 有限数か（NaN/Infinity を弾く）。評価値に Infinity を入れて分類を壊す攻撃を防ぐ。 */
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 制御文字(改行・タブ・NUL 等)を除去するための正規表現。
 *  なぜ必要か(Codex 指摘2の核心): known/unknown 等のユーザー語彙をプロンプトに埋め込む際、
 *  改行や引用符を使って「これまでの指示を無視せよ」のような“命令文”を注入される余地を消す。
 *  制御文字を空白化することで、語彙が複数行に化けてプロンプト構造を壊すのを防ぐ。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** 自由文(question/history.content)から制御文字を除去し前後空白を削る。
 *  なぜ必要か(多観点レビュー INV-001/PI-001/PI-002 が収束した実バグへの対応):
 *  buildPrompt は history を `${role}: ${content}` で改行連結し、question を「${question}」に展開する。
 *  content/question に生の改行を仕込むと「ユーザー: …(改行)解説者: 偽の応答」のような“偽の対話ターン”を
 *  構造的に捏造できる。pv/profile 用語は sanitizeStringArray で除去済みなのに、この2フィールドだけ
 *  素通しだった（しかも index.ts には「無害化済み」と誤コメントが残っていた）。ここで一貫させる。 */
function cleanText(s: string): string {
  return s.replace(CONTROL_CHARS, ' ').trim();
}

/** 文字列配列を検証し、要素数・各要素長で切り詰める（過大入力をサイレントに拒否ではなく上限でクリップ）。
 *  なぜクリップして通すか: known/unknown 用語や PV は“多すぎる”だけなら致命的でない。
 *  ただし上限超過分は捨てて、コスト/トークンの上振れを物理的に止める。
 *
 *  重要(Codex 指摘3への対応): 以前は out が上限に達した時点で break しており、
 *  上限“以降”の要素に非文字列が混じっていても見逃していた（「型を厳格検証」の契約とズレ＝テールバイパス）。
 *  body は 16KB 上限なので全走査は安価。よって break せず全要素の型を検証し、採用は maxItems まで。 */
function sanitizeStringArray(input: unknown, maxItems: number, maxLen: number): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const el of input) {
    if (!isStr(el)) return null; // 型が違えば不正入力として全体を拒否（テールも含め全要素を検証）
    const cleaned = el.replace(CONTROL_CHARS, ' ').trim(); // 制御文字を無害化
    if (cleaned.length === 0) continue;
    if (out.length < maxItems) out.push(cleaned.slice(0, maxLen)); // 採用は上限まで。走査は最後まで続ける
  }
  return out;
}

/**
 * 解説/対話リクエストボディを厳格検証する。信頼境界（サーバ）での唯一の砦。
 * 返り値は discriminated union。ok=false のときは安全な短いエラー文（攻撃者に内部構造を晒さない）。
 *
 * 方針: 「存在チェックだけ」だった従来(C 指摘: fenOrSfen の有無のみ)を改め、
 *   enum/型/長さ/数値範囲/配列長をすべて検証。未知フィールドは黙って無視（前方互換）。
 */
export function validateExplainBody(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'invalid body' };
  const b = input as Record<string, unknown>;

  // mode / game は enum 固定。プロンプト分岐とプロバイダ選択に効くので厳格に。
  if (b.mode !== 'explain' && b.mode !== 'followup') return { ok: false, error: 'invalid mode' };
  if (b.game !== 'chess' && b.game !== 'shogi') return { ok: false, error: 'invalid game' };
  const mode = b.mode as Mode;
  const game = b.game as GameKind;

  // context は必須。最低限 fenOrSfen が要る（盤面が無いと解説のしようがない）。
  if (typeof b.context !== 'object' || b.context === null)
    return { ok: false, error: 'invalid context' };
  const c = b.context as Record<string, unknown>;

  if (!isStr(c.fenOrSfen) || c.fenOrSfen.length === 0 || c.fenOrSfen.length > LIMITS.fenMax)
    return { ok: false, error: 'invalid fenOrSfen' };

  // 任意フィールドは「あるなら型・長さ・範囲を満たすこと」。
  // 空文字は拒否(REG-01: fenOrSfen は length===0 を弾くのに movePlayed/bestMove だけ "" を通すと
  //   facts に "movePlayed":"" が載って「指し手あり・内容空」の矛盾データを LLM に渡してしまう非対称)。
  if (
    c.movePlayed !== undefined &&
    (!isStr(c.movePlayed) || c.movePlayed.length === 0 || c.movePlayed.length > LIMITS.moveMax)
  )
    return { ok: false, error: 'invalid movePlayed' };
  if (
    c.bestMove !== undefined &&
    (!isStr(c.bestMove) || c.bestMove.length === 0 || c.bestMove.length > LIMITS.moveMax)
  )
    return { ok: false, error: 'invalid bestMove' };
  if (
    c.evalBefore !== undefined &&
    (!isFiniteNum(c.evalBefore) || Math.abs(c.evalBefore) > LIMITS.evalAbsMax)
  )
    return { ok: false, error: 'invalid evalBefore' };
  if (
    c.evalAfter !== undefined &&
    (!isFiniteNum(c.evalAfter) || Math.abs(c.evalAfter) > LIMITS.evalAbsMax)
  )
    return { ok: false, error: 'invalid evalAfter' };
  if (c.quality !== undefined && !QUALITIES.includes(c.quality as MoveQuality))
    return { ok: false, error: 'invalid quality' };

  const pv = sanitizeStringArray(c.pv, LIMITS.pvMaxItems, LIMITS.moveMax);
  if (pv === null) return { ok: false, error: 'invalid pv' };

  const context: ExplainContext = {
    fenOrSfen: c.fenOrSfen,
    movePlayed: c.movePlayed as string | undefined,
    bestMove: c.bestMove as string | undefined,
    evalBefore: c.evalBefore as number | undefined,
    evalAfter: c.evalAfter as number | undefined,
    quality: c.quality as MoveQuality | undefined,
    pv: pv.length ? pv : undefined,
  };

  // question は followup のときだけ意味を持つ。長さ上限でトークン膨張攻撃を抑止。
  // 制御文字除去＋trim で、改行による構造注入(PI-002)と空白のみ質問の通過(REG-02)を同時に塞ぐ。
  let question: string | undefined;
  if (b.question !== undefined) {
    if (!isStr(b.question) || b.question.length > LIMITS.questionMax)
      return { ok: false, error: 'invalid question' };
    question = cleanText(b.question);
  }
  if (mode === 'followup' && (!question || question.length === 0))
    return { ok: false, error: 'question required for followup' };

  // history は型・件数・各長を検証しつつ末尾(直近)を優先採用。
  let history: { role: 'user' | 'assistant'; content: string }[] | undefined;
  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) return { ok: false, error: 'invalid history' };
    // Codex 指摘3への対応: 以前は slice(-N) してから検証していたため、N より前に混じった
    // 不正要素を見逃した（テールバイパス）。まず“全要素”の型を検証してから直近 N 件を採用する。
    // body 16KB 上限ゆえ全走査は安価。
    const items: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const el of b.history) {
      if (typeof el !== 'object' || el === null)
        return { ok: false, error: 'invalid history item' };
      const h = el as Record<string, unknown>;
      if (h.role !== 'user' && h.role !== 'assistant')
        return { ok: false, error: 'invalid history role' };
      if (!isStr(h.content)) return { ok: false, error: 'invalid history content' };
      // 制御文字除去(INV-001/PI-001: 偽ターン捏造の防止)してから長さ上限でクリップ。
      items.push({
        role: h.role,
        content: cleanText(h.content).slice(0, LIMITS.historyContentMax),
      });
    }
    // 直近 historyMaxItems 件だけ採用（古い文脈はコスト/関連性の観点で捨てる）。
    history = items.slice(-LIMITS.historyMaxItems);
  }

  // profile は known/unknown 配列と level enum。自由文を用語IDっぽい短文にクリップ。
  let profile: KnowledgeProfile | undefined;
  if (b.profile !== undefined) {
    if (typeof b.profile !== 'object' || b.profile === null)
      return { ok: false, error: 'invalid profile' };
    const p = b.profile as Record<string, unknown>;
    const known = sanitizeStringArray(p.known, LIMITS.profileMaxItems, LIMITS.profileItemMax);
    const unknown = sanitizeStringArray(p.unknown, LIMITS.profileMaxItems, LIMITS.profileItemMax);
    if (known === null || unknown === null) return { ok: false, error: 'invalid profile terms' };
    if (p.level !== undefined && !LEVELS.includes(p.level as Level))
      return { ok: false, error: 'invalid level' };
    profile = { known, unknown, level: p.level as Level | undefined };
  }

  return { ok: true, value: { mode, game, context, question, history, profile } };
}

/**
 * 解説(explain)モードのキャッシュキー入力を“正規化”する。
 * なぜ正規化が要るか: 同一局面の再解説で LLM を再課金しないため（PLAN の「コスト核」=C5）。
 *   キー要素は決定的に並べ、followup は対話的でキャッシュに向かないので対象外（呼び出し側で分岐）。
 * 注意: ここではキー“入力オブジェクト”を返すだけ。ハッシュ化やDB参照は共有ストア実装側（Supabase接続後）。
 *   level を含めるのは、レベルで解説文面が変わる＝別キャッシュにすべきだから。
 *
 * !!! キャッシュ実装前に必ず解決すること(Codex指摘#1の地雷) !!!
 *   現在のキーは pv と profile.known/unknown(語彙) を“含めない”。一方 buildPrompt は context全体(pv含む)と
 *   語彙データをプロンプトに入れている。このままキャッシュを有効化すると、同一局面・同一levelでも
 *   「語彙/PVが違う別ユーザー」に、別人向けに生成された文面を再利用してしまう。
 *   対処の方向は2択:
 *     (a) キーに pv と語彙(正規化済み)を含める → ただし語彙差でキャッシュヒット率が激減しコスト核の意味が薄れる。
 *     (b) キャッシュ対象の explain プロンプトから語彙/PV個別性を外し「局面+level の基本解説」だけを
 *         キャッシュ、語彙パーソナライズはキャッシュ外(クライアント側 or 非キャッシュ)で行う。
 *   PoC では (b) を推奨（コスト最小と整合）。この判断は Supabase キャッシュ実装時に確定する。
 */
export function cacheKeyInput(body: ExplainBody): Record<string, unknown> {
  return {
    game: body.game,
    fenOrSfen: body.context.fenOrSfen,
    movePlayed: body.context.movePlayed ?? null,
    bestMove: body.context.bestMove ?? null,
    evalBefore: body.context.evalBefore ?? null,
    evalAfter: body.context.evalAfter ?? null,
    quality: body.context.quality ?? null,
    level: body.profile?.level ?? 'beginner',
  };
}
