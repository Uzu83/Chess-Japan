/**
 * jwtClaims.ts — ユーザー JWT のペイロード読み取り（検証は getAuthUser 側）
 *
 * 退会など破壊操作で「最近発行されたセッションか」を見るために使う。
 * 署名検証の代替ではない。auth/v1/user 通過後の補助条件。
 */

/** JWT payload の iat（秒）。不正なら null。 */
export function readJwtIssuedAt(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { iat?: unknown };
    return typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null;
  } catch {
    return null;
  }
}

/**
 * トークン発行からの経過が maxAgeSec 以内か。
 * iat が読めない・未来すぎる場合は安全側で false。
 */
export function isJwtFresh(
  token: string,
  maxAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const iat = readJwtIssuedAt(token);
  if (iat === null) return false;
  if (iat > nowSec + 60) return false; // 時計ずれ余裕 60s
  return nowSec - iat <= maxAgeSec;
}
