/*
 * moveLabels.ts — ReviewView 用: エンジン解析結果に「エンジン由来の正確な手ラベル」を付与する薄い層。
 *
 * WHY 独立ファイルに切り出すか（ReviewView.tsx から分離・vitest で回帰できるようにする）:
 *   旧実装は ReviewView.tsx 内の `withShogiMoveLabels` が将棋だけラベルを付与し、チェスは
 *   素通ししていた（ExplanationPanel が uciToSan で表示専用に SAN 化していたため）。
 *   2026-07-16(explain-label-data-plan.md)で「エンジン由来の正確なラベルを LLM の DATA にも
 *   同梱し、LLM に座標変換をさせない」方針に変わり、チェスにも SAN ラベルを付与する対称拡張になった。
 *   ReviewView.tsx（1400行超の巨大コンポーネント）にロジックを埋めるとテストしにくいため、
 *   src/core/*.test.ts と同じパターンでユニットテストできるよう独立ファイルに切り出した。
 *
 * WHY chess は同期・shogi は動的 import か（1バイト不変条件・再発防止。詳細は core/types.ts の
 * ExplanationContext コメント）:
 *   uciToSan/uciLineToSan(notation.ts) は chess.js に依存し、chess.js は既にメインバンドルにある
 *   ため静的 import で問題ない。一方 usiToJapanese/usiLineToJapanese(shogiNotation.ts) は
 *   tsshogi(将棋一式)に依存し、これを静的 import するとチェス利用者のメインチャンクに tsshogi が
 *   漏れる（1バイト不変条件違反）。よって shogi 分岐だけ `await import('../core/shogiNotation')`
 *   に閉じる（ReviewView.tsx の旧実装 `withShogiMoveLabels` から引き継いだ制約）。
 *   この境界を壊さないよう、このファイル自身は shogiNotation を **静的 import しないこと**。
 */

import type { ExplanationContext, GameKind } from '../core/types';
import { uciToSan, uciLineToSan } from '../core/notation';

/**
 * 読み筋(PV)ラベルの表示打ち切り手数。ExplanationPanel の想定手順表示(3往復=6手)と揃える。
 * WHY 6か: PV は解析深さ分に伸びるが、1手解説に必要なのは「この筋に進む」ことが伝わる最小量。
 * ExplanationPanel.tsx / shogiNotation.ts の同名パラメータと同値にして UI 全体で表示量を統一する。
 */
const PV_MAX_PLIES = 6;

/**
 * chess: notation.ts(chess.js・同期・既にメインバンドル)で SAN ラベルを付与する。
 * movePlayed・bestMove が両方無い(未解析/初期局面等)ときは付与せず ctx をそのまま返す。
 */
function withChessLabels(ctx: ExplanationContext): ExplanationContext {
  if (!ctx.movePlayed && !ctx.bestMove) return ctx;
  const pvLabels = ctx.pv ? uciLineToSan(ctx.fenOrSfen, ctx.pv, PV_MAX_PLIES) : [];
  return {
    ...ctx,
    movePlayedLabel: ctx.movePlayed
      ? (uciToSan(ctx.fenOrSfen, ctx.movePlayed) ?? undefined)
      : undefined,
    bestMoveLabel: ctx.bestMove ? (uciToSan(ctx.fenOrSfen, ctx.bestMove) ?? undefined) : undefined,
    // 空配列でなく undefined にする理由(旧 withShogiMoveLabels の F001 対応を chess にも適用):
    //   ExplanationPanel/localExplanation は `context.pvLabels ?? フォールバック` の形で評価するため、
    //   定義済みの空配列を渡すとフォールバック(uciLineToSan の再計算)が発火せず、想定手順が丸ごと
    //   消える構造上の穴になる。undefined にすればフォールバック経路が生きる。
    pvLabels: pvLabels.length > 0 ? pvLabels : undefined,
  };
}

/**
 * shogi: shogiNotation.ts(tsshogi 依存)を動的 import して日本語ラベルを付与する。
 * import は初回のみで以降はモジュールキャッシュが効くため、全手解析ループで毎手呼んでも
 * 実コストは初回だけ（旧 withShogiMoveLabels と同じ前提）。
 */
async function withShogiLabels(ctx: ExplanationContext): Promise<ExplanationContext> {
  if (!ctx.movePlayed && !ctx.bestMove) return ctx;
  const { usiToJapanese, usiLineToJapanese } = await import('../core/shogiNotation');
  const pvLabels = ctx.pv ? usiLineToJapanese(ctx.fenOrSfen, ctx.pv, PV_MAX_PLIES) : [];
  return {
    ...ctx,
    movePlayedLabel: ctx.movePlayed
      ? (usiToJapanese(ctx.fenOrSfen, ctx.movePlayed) ?? undefined)
      : undefined,
    bestMoveLabel: ctx.bestMove
      ? (usiToJapanese(ctx.fenOrSfen, ctx.bestMove) ?? undefined)
      : undefined,
    // undefined 規律は chess 分岐(withChessLabels)と同一（F001）。
    pvLabels: pvLabels.length > 0 ? pvLabels : undefined,
  };
}

/**
 * ExplanationContext に movePlayedLabel/bestMoveLabel/pvLabels を付与する
 * （chess=SAN / shogi=日本語）。旧名 `withShogiMoveLabels`（将棋専用）から `withMoveLabels`
 * （chess/shogi 対称）へ改名した（explain-label-data-plan.md・2026-07-16）。
 *
 * これらのラベルは表示だけでなく、`src/explain/client.ts` 経由で Edge Function の DATA にも
 * 同梱される（validate.ts が信頼境界として検証してから buildPrompt の DATA に載せる）。
 * LLM が座標(USI/UCI)から日本語表記/SAN への変換を誤る実バグ（正: ▲２二角成 → 誤: ▲８八角成）を、
 * 「LLM に変換させず、エンジン由来の正確なラベルを引用させる」ことで根治する。
 */
export function withMoveLabels(
  ctx: ExplanationContext,
  kind: GameKind,
): Promise<ExplanationContext> {
  return kind === 'shogi' ? withShogiLabels(ctx) : Promise.resolve(withChessLabels(ctx));
}

/**
 * localStorage から復元した解析済みコンテキスト群に、欠けているラベルを補完する。
 *
 * WHY 必要か（ゲート② codex 異モデルレビュー F001・2026-07-16 accept）:
 *   ラベル機能の追加より前に `saveContextsToStorage`(storage.ts) で保存された解析結果は
 *   movePlayedLabel/bestMoveLabel/pvLabels を持たない。`ReviewView.loadPgn` は復元した
 *   context をそのまま `setContexts` し、以降の単手解析(`if (contexts[ply]) return`)・
 *   全手解析(`ply in prev` ガード)は「既にキャッシュ済み」として再解析しないため、
 *   復元済みの手には**永久にラベルが付かず**、解説リクエストがラベル無しで送られてしまう
 *   （＝今回の修正が既存ユーザーのローカルキャッシュに届かない）。
 *
 * WHY SCHEMA_VERSION を上げないか（裁定済み・絶対に踏まない不変条件）:
 *   storage.ts の SCHEMA_VERSION は contexts 専用ではなく session/対局履歴(cj:games)/
 *   レート(cj:rating)とも共有されている。バンプすると旧データが一括で null 化され、
 *   ユーザーの Elo レートと対局履歴が消える。ラベル欠落は「復元後にその場で埋める」
 *   （このモジュールの役割）ことで解決し、スキーマ自体は変えない。
 *
 * WHY chess 専用でよいか（shogi 分岐が無いことの根拠）:
 *   解析キャッシュの永続化・復元経路(`loadPgn` の `restoreCtx`)は chess 専用。将棋
 *   (`loadShogi`)は `setLoadedPgn(null)` で永続化 effect を確実にスキップする設計
 *   （PLAN.md Phase 4-1 の設計判断・ReviewView.tsx の loadShogi コメント参照）ため、
 *   将棋の保存済みコンテキストはそもそも存在せず、この関数で復元する対象がない。
 *   よって chess 専用の同期関数(`withChessLabels` 相当)だけで十分——`withMoveLabels`
 *   のような async/shogi 分岐を持ち込む必要がなく、`loadPgn`(同期関数)から素直に呼べて
 *   await 越しのレース(世代ガード等)も生じない。
 *
 * WHY 冪等か:
 *   `movePlayedLabel` が既に定義済みのエントリはラベル付与済み(新仕様で保存された分)と
 *   判断してスキップする。壊れた/変換不能な手(uciToSan が null)は前回同様 undefined の
 *   ままにし、毎回変換を試みて失敗するだけの無駄なコストにしない。
 *
 * 補完後の返り値はそのまま `setContexts` される想定で、その後は既存の保存 effect
 * （`saveContextsToStorage` を呼ぶ useEffect）が新しい形(ラベル付き)で再保存するため、
 * ストレージは次回保存時に自己修復される（この関数自身は保存処理を行わない・呼び出し側の
 * 既存 effect に委ねる）。
 */
export function enrichStoredChessContexts(
  data: Record<number, ExplanationContext>,
): Record<number, ExplanationContext> {
  const out: Record<number, ExplanationContext> = {};
  for (const [key, ctx] of Object.entries(data)) {
    // movePlayedLabel が既にあれば補完済み(新仕様で保存された分)とみなしスキップ。
    // movePlayed も bestMove も無ければ withChessLabels 同様に素通し。
    const needsLabel =
      ctx.movePlayedLabel === undefined && (Boolean(ctx.movePlayed) || Boolean(ctx.bestMove));
    out[Number(key)] = needsLabel ? withChessLabels(ctx) : ctx;
  }
  return out;
}
