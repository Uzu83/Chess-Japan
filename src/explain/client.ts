import type { ExplanationContext, KnowledgeProfile, MoveQuality } from '../core/types';
import { qualityLabelJa } from '../core/classify';
import { uciToSan, uciLineToSan } from '../core/notation';
import { getTurnstileToken } from './turnstile';

export type ExplainMode = 'explain' | 'followup';

export interface ExplainRequest {
  mode: ExplainMode;
  game: 'chess' | 'shogi';
  context: ExplanationContext;
  question?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  profile?: KnowledgeProfile;
}

/*
 * WHY モジュール定数でなく関数で env を読むか(テスト決定性・実バグの再発防止):
 *   モジュールトップの const に import.meta.env を捕獲すると、その値は import 時に固定され、
 *   テストの vi.stubEnv が効かない。さらに Vitest は Vite 経由で開発者の .env.local も読むため、
 *   「バックエンド未設定」を前提にしたテストが .env.local を作った瞬間に落ちる
 *   (実際に VITE_SUPABASE_URL を .env.local に置いたら CI ではなくローカルだけ落ちた)。
 *   呼び出し時に読む形なら、テストが stubEnv で環境を明示制御でき、開発者の env に依存しない。
 */
function supabaseUrl(): string | undefined {
  return import.meta.env.VITE_SUPABASE_URL as string | undefined;
}
function supabaseAnon(): string | undefined {
  return import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
}

/** バックエンド(Edge Function)が設定済みか。 */
export function isBackendConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnon());
}

/*
 * 詰み検出の閾値。classify.scoreToCp は詰みを ±(100000 - 手数) の巨大 cp に換算するため、
 * この値以上は「ポーン差」でなく「詰み」として表現する(そのまま割ると "-1000.0ポーン" のような
 * 意味不明な数値がユーザーに漏れる — 実際に起きた表示バグの再発防止)。
 */
const MATE_CP = 99_000;

/** 評価値(cp, 手番側視点)を人間向けの短い表現にする。詰みは専用表現。 */
function evalText(cp: number | undefined): string {
  if (cp === undefined) return '不明';
  if (Math.abs(cp) >= MATE_CP) return cp > 0 ? '詰みあり(勝ち)' : '詰まされる(負け)';
  const pawns = (cp / 100).toFixed(1);
  const side = cp >= 0 ? '手番側有利' : '相手有利';
  return `${pawns}(${side})`;
}

/** バックエンド未設定時のローカル簡易解説(ルールベース)。 */
export function localExplanation(req: ExplainRequest): string {
  const { context: c, mode, question } = req;
  if (mode === 'followup') {
    return `（ローカル簡易応答）「${question ?? ''}」について：現在の局面評価は ${evalText(
      c.evalAfter,
    )} です。詳しい対話解説にはAI解説バックエンドの設定が必要です。`;
  }
  const quality = c.quality ? qualityLabelJa(c.quality as MoveQuality) : '判定なし';

  /*
   * 最善手の提示は SAN + 想定手順 + 評価差で「最善手は何で、なぜ良かったか」に
   * LLM 無しでも最低限答える(バックエンド未接続のユーザーにも core value を届ける)。
   * SAN 変換に失敗したら UCI にフォールバックして情報は落とさない。
   */
  let best: string;
  if (c.bestMove && c.movePlayed && c.bestMove !== c.movePlayed) {
    const bestSan = uciToSan(c.fenOrSfen, c.bestMove) ?? c.bestMove;
    const pvSan = c.pv ? uciLineToSan(c.fenOrSfen, c.pv, 6) : [];
    const line = pvSan.length > 0 ? `想定手順は ${pvSan.join(' ')}。` : '';
    // 評価差 = 最善(evalBefore)と実際(evalAfter)の差。ポーン換算で"なぜ悪いか"の数値的根拠。
    // ただしどちらかが詰み級(±MATE_CP 以上)ならポーン換算は無意味なので専用文にする。
    let delta = '';
    if (c.evalBefore !== undefined && c.evalAfter !== undefined) {
      const isMateSwing = Math.abs(c.evalBefore) >= MATE_CP || Math.abs(c.evalAfter) >= MATE_CP;
      delta = isMateSwing
        ? 'この手は詰みに直結する重大な分岐でした。'
        : `この差は約 ${((c.evalBefore - c.evalAfter) / 100).toFixed(1)} ポーン相当です。`;
    }
    best = `エンジンの最善手は ${bestSan} でした。${line}${delta}`;
  } else {
    best = 'これはエンジン最善手と一致します。';
  }
  return `この手は「${quality}」です。指す前の評価は ${evalText(
    c.evalBefore,
  )}、指した後は ${evalText(c.evalAfter)}。${best}（より自然な解説にはAI解説バックエンドの設定が必要です）`;
}

/** Edge Function を呼んで解説/応答テキストを得る。未設定ならローカル簡易解説。 */
export async function requestExplanation(req: ExplainRequest): Promise<string> {
  if (!isBackendConfigured()) {
    // 将棋の局所解説は USI→日本語変換に tsshogi を要する。チェス利用者のメインバンドルに
    // tsshogi を漏らさないため、将棋分岐だけ **動的 import** で shogiNotation を読み込む
    // （chess の localExplanation は同期のまま・既存テストに影響なし）。
    if (req.game === 'shogi') {
      const { localShogiExplanation } = await import('../core/shogiNotation');
      return localShogiExplanation({
        context: req.context,
        mode: req.mode,
        question: req.question,
      });
    }
    return localExplanation(req);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${supabaseAnon()}`,
  };
  // Turnstile 有効時のみ、リクエスト毎の新鮮なトークンを x-turnstile-token に付与（#2）。
  // 未設定なら null で無付与（バックエンドも非課金環境では検証 skip）。単発トークンなので都度取得。
  const turnstileToken = await getTurnstileToken();
  if (turnstileToken) headers['x-turnstile-token'] = turnstileToken;
  const res = await fetch(`${supabaseUrl()}/functions/v1/explain`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`explain API error: ${res.status}`);
  }
  const data = (await res.json()) as { text?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return data.text ?? '';
}
