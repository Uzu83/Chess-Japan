import type { ExplanationContext, KnowledgeProfile, MoveQuality } from '../core/types';
import { qualityLabelJa } from '../core/classify';
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

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** バックエンド(Edge Function)が設定済みか。 */
export function isBackendConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON);
}

/** 評価値(cp)を人間向けの短い表現にする。 */
function evalText(cp: number | undefined): string {
  if (cp === undefined) return '不明';
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
    )} です。詳しい対話解説には解説バックエンド(Grok)の設定が必要です。`;
  }
  const quality = c.quality ? qualityLabelJa(c.quality as MoveQuality) : '判定なし';
  const best =
    c.bestMove && c.movePlayed && c.bestMove !== c.movePlayed
      ? `エンジンの最善手は ${c.bestMove} でした。`
      : 'これはエンジン最善手と一致します。';
  return `この手は「${quality}」です。指す前の評価は ${evalText(
    c.evalBefore,
  )}、指した後は ${evalText(c.evalAfter)}。${best}（より自然な解説には Grok バックエンドの設定が必要です）`;
}

/** Edge Function を呼んで解説/応答テキストを得る。未設定ならローカル簡易解説。 */
export async function requestExplanation(req: ExplainRequest): Promise<string> {
  if (!isBackendConfigured()) {
    return localExplanation(req);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUPABASE_ANON}`,
  };
  // Turnstile 有効時のみ、リクエスト毎の新鮮なトークンを x-turnstile-token に付与（#2）。
  // 未設定なら null で無付与（バックエンドも非課金環境では検証 skip）。単発トークンなので都度取得。
  const turnstileToken = await getTurnstileToken();
  if (turnstileToken) headers['x-turnstile-token'] = turnstileToken;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/explain`, {
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
