/*
 * validate.ts — 送信前の検証と正規化（純関数）
 *
 * ここを通った値だけが Firestore に書かれる。同じ関数を Security Rules の意図と対応させ、
 * 「クライアントで弾く」「ルールでも弾く」の二重にする。**真の信頼境界はルール側**で、
 * ここは UX（その場でエラーを出す）と事故防止のための前段。
 */

import {
  CONSENT_VERSION,
  CONTACT_RETENTION_DAYS,
  FEEDBACK_KINDS,
  FEEDBACK_PLATFORMS,
  LIMITS,
  type FeedbackContactDoc,
  type FeedbackDoc,
  type FeedbackInput,
  type ValidationResult,
} from './schema';

/*
 * 制御文字を除去する（改行とタブは残す）。
 * WHY: ゼロ幅文字や制御文字は、後で本文を読む人間・AI の表示を壊したり、
 *      ログを汚したりする。改行は要望文で普通に使うので残す。
 */
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function normalizeText(s: string): string {
  return stripControlChars(s).trim();
}

/**
 * 画面の識別子を正規化する。
 * URL が渡された場合は **origin + pathname だけ**にする（query / hash に個人情報や
 * セッション識別子が乗りやすいため。落とすのはこちらの責任にする）。
 */
export function normalizeScreen(raw: string | undefined): string | null {
  const s = normalizeText(raw ?? '');
  if (!s) return null;
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.slice(0, LIMITS.screenMax);
  } catch {
    return s.slice(0, LIMITS.screenMax);
  }
}

/*
 * メールアドレスの形だけ見る。
 * WHY 厳密な RFC 検証をしないか: 正規表現で RFC 5322 を追うと誤って正当なアドレスを弾く。
 * ここの目的は「明らかな入力ミスをその場で気づかせる」ことなので、@ とドメインの形が
 * 通っていれば通す。到達性は実際に送ってみるまで分からない。
 */
function looksLikeEmail(s: string): boolean {
  if (s.length > LIMITS.emailMax) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

/** 連絡先の削除予定時刻。Firestore の TTL ポリシーがこのフィールドを見る。 */
export function contactExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + CONTACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 入力を検証し、書き込む2つの文書に分ける。
 *
 * @param input クライアントが組み立てた入力
 * @param now   期限計算の基準時刻（テスト決定性のため引数で受ける）
 */
export function validateFeedback(input: FeedbackInput, now: Date = new Date()): ValidationResult {
  const product = normalizeText(input.product);
  if (!product || product.length > LIMITS.productMax) {
    return { ok: false, error: 'プロダクトが指定されていません', field: 'product' };
  }

  if (!FEEDBACK_KINDS.includes(input.kind)) {
    return { ok: false, error: '種類を選んでください', field: 'kind' };
  }

  const message = normalizeText(input.message);
  if (!message) {
    return { ok: false, error: '内容を入力してください', field: 'message' };
  }
  if (message.length > LIMITS.messageMax) {
    return {
      ok: false,
      error: `内容は${LIMITS.messageMax}文字までです`,
      field: 'message',
    };
  }

  const platform =
    input.platform && FEEDBACK_PLATFORMS.includes(input.platform) ? input.platform : null;
  const appVersion = normalizeText(input.appVersion ?? '').slice(0, LIMITS.appVersionMax) || null;

  const feedback: FeedbackDoc = {
    product,
    kind: input.kind,
    message,
    screen: normalizeScreen(input.screen),
    platform,
    appVersion,
    wantsReply: input.wantsReply === true,
    status: 'new',
    createdAt: null,
  };

  /*
   * 返信不要なら連絡先は「入力されていても捨てる」。
   * WHY: チェックを外したのに前に入れたメールが残る、という事故を構造的に防ぐ。
   *      保存しない約束をした以上、握り潰すのではなく通り道自体を無くす。
   */
  if (!feedback.wantsReply) {
    return { ok: true, feedback, contact: null };
  }

  const email = normalizeText(input.contactEmail ?? '');
  if (!email) {
    return {
      ok: false,
      error: '返信を希望する場合はメールアドレスを入力してください',
      field: 'contactEmail',
    };
  }
  if (!looksLikeEmail(email)) {
    return { ok: false, error: 'メールアドレスの形式を確認してください', field: 'contactEmail' };
  }

  const contact: FeedbackContactDoc = {
    email,
    consentVersion: CONSENT_VERSION,
    expiresAt: contactExpiryFrom(now),
  };

  return { ok: true, feedback, contact };
}
