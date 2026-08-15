/*
 * explain API のエラー本文 → ユーザー向け日本語。
 *
 * WHY 別モジュールか: client.ts は fetch/ローカル解説が主。文言マップはテストしやすく
 * 単体で置いて、status と body.error の両方から同じ表を引く。
 */

/** Edge が返す error 文字列（英語）→ 日本語。未知はそのまま返す（フォールバック）。 */
const BODY_JA: Record<string, string> = {
  'rate limited': 'アクセスが集中しています。しばらくしてから再試行してください',
  'daily quota exceeded':
    '本日の解説回数の上限に達しました。明日またお試しください（Pro で枠が広がります）',
  'deep monthly quota exceeded': '今月の深掘り解説の上限（30回）に達しました',
  'pro required for deep explain':
    '深掘り解説は Pro（月額 ¥480）限定です。個人レッスン1回分より気軽に始められます',
  'rate limiter unavailable':
    '混雑のため一時的に利用できません。しばらくしてから再試行してください',
  'turnstile failed':
    'ボット対策の確認に失敗しました。解説パネル内の確認をもう一度試すか、ページを再読み込みしてください',
  'turnstile required':
    'ボット対策の確認が必要です。解説パネル内の「あなたは人間ですか」を完了してから再試行してください',
  unauthorized: 'ログインの有効期限が切れている可能性があります。再ログインしてください',
  'invalid depth': '解説の設定が不正です',
  'invalid json': 'リクエストの形式が不正です',
  'bot protection required':
    'ボット対策の確認が必要です。解説パネル内の確認を完了してから再試行してください',
  'payload too large': 'リクエストが大きすぎます。棋譜や履歴を減らして再試行してください',
  'upstream failed': 'AI側で一時的な障害が発生しました。しばらくしてから再試行してください',
  'origin not allowed': 'このページからの解説リクエストは許可されていません',
};

/**
 * HTTP status + 任意の body.error から表示用メッセージを作る。
 * body が既知ならそれを優先（402/429 の意味が status より具体的）。
 */
export function formatExplainApiError(status: number, bodyError?: string | null): string {
  const trimmed = bodyError?.trim();
  if (trimmed) {
    const mapped = BODY_JA[trimmed];
    if (mapped) return mapped;
    // サーバーが既に日本語を返した場合・未知コードはそのまま（長すぎるのは切る）
    if (trimmed.length <= 200) return trimmed;
  }
  if (status === 402) return BODY_JA['pro required for deep explain']!;
  if (status === 429) return BODY_JA['rate limited']!;
  if (status === 401) return BODY_JA.unauthorized!;
  if (status === 403) return 'この操作は許可されていません';
  if (status === 503) return '解説サービスが一時的に利用できません';
  if (status >= 500) return 'サーバー側で問題が発生しました。しばらくしてから再試行してください';
  return `解説の取得に失敗しました（${status}）`;
}

/**
 * fetch 自体が落ちたとき（CORS preflight 失敗 / ネットワーク / Edge 未捕捉 500）。
 * WHY billing と同型か: ブラウザは CORS 失敗を TypeError: Failed to fetch に畳むため、
 *   生メッセージを出すと「試合してないから？」と誤解される。接続の問題だと明示する。
 */
/** fetch 失敗時の汎用日本語。棋譜はクライアント側に残っていることを明示する。 */
const NETWORK_ERROR_JA = '通信が不安定です。棋譜は失われていません。再試行してください';

/** ブラウザ/ライブラリ由来の英語メッセージを UI に漏らさないための簡易判定。 */
function looksLikeEnglishMessage(msg: string): boolean {
  return /[a-zA-Z]/.test(msg) && !/[\u3040-\u30ff\u4e00-\u9faf]/.test(msg);
}

export function formatExplainNetworkError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  /*
   * 人間確認が未完了のまま時間切れ（turnstile.ts の TOKEN_TIMEOUT_MS）。
   * 「失敗しました」ではなく **今なにをすればいいか** を書く。無言のスピナーで
   * ユーザーが固まった実害（本番 QA 2026-08-13）への対処なので、汎用文言に混ぜない。
   */
  if (/turnstile timeout/i.test(msg))
    return '解説パネル内の「あなたは人間ですか」の確認を完了してください。完了してから再試行すると解説が表示されます';
  if (/turnstile/i.test(msg)) return BODY_JA['turnstile failed']!;
  if (/failed to fetch/i.test(msg) || err instanceof TypeError) {
    return NETWORK_ERROR_JA;
  }
  if (looksLikeEnglishMessage(msg)) return NETWORK_ERROR_JA;
  return msg;
}

/** 表示メッセージが深掘り Pro 必須（402）系かどうか。CTA 出し分け用。 */
export function isProRequiredExplainMessage(message: string): boolean {
  return (
    message.includes('pro required for deep explain') ||
    message.includes('深掘り解説は Pro') ||
    message.includes('Pro（月額')
  );
}
