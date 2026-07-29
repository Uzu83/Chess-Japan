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
    '深掘り解説は Pro プラン限定です。ヘッダーの Pro から登録できます',
  'rate limiter unavailable':
    '混雑のため一時的に利用できません。しばらくしてから再試行してください',
  'turnstile failed':
    'ボット対策の確認に失敗しました。ページを再読み込みしてから再試行してください',
  'turnstile required': 'ボット対策の確認が必要です。ページを再読み込みしてから再試行してください',
  unauthorized: 'ログインの有効期限が切れている可能性があります。再ログインしてください',
  'invalid depth': '解説の設定が不正です',
  'invalid json': 'リクエストの形式が不正です',
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
