/*
 * schema.ts — フィードバックの契約（ランタイム非依存の唯一の正）
 *
 * この層は UI も DB も知らない。Web / Flutter / サーバーのどこから見ても同じ意味になるように、
 * 「何を保存し、何を保存しないか」だけを定義する。
 *
 * 設計方針（オーナー決定 2026-08-13）:
 *   1. **既定は完全匿名**。返信が要る人だけが連絡先を入力する
 *   2. 連絡先は本文と**別コレクション**に置き、TTL で自動削除する
 *      （Firestore の TTL は文書単位でしか効かないため。同居させるとメール削除で本文まで消える）
 *   3. 同意は「取った事実」ではなく「何に同意したか」を残す（consentVersion）
 */

/** フィードバックの種類。プロダクト固有の種類はここに足さない（product フィールドで区別する）。 */
export const FEEDBACK_KINDS = ['bug', 'feature', 'ux', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** 送信元プラットフォーム。Web と モバイルで同じ契約を使うため最初から持つ。 */
export const FEEDBACK_PLATFORMS = ['web', 'ios', 'android'] as const;
export type FeedbackPlatform = (typeof FEEDBACK_PLATFORMS)[number];

/** 仕分けの状態。オーナーが土日にまとめて捌くための最小限。 */
export const FEEDBACK_STATUSES = ['new', 'triaged', 'done', 'wontfix'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/*
 * 同意文のバージョン。
 * WHY 必要か: 文面を後から変えたとき「この人は何に同意したのか」を復元できなくなる。
 * 開示請求や問い合わせに1行で答えられるようにするため、日付で固定して保存する。
 * **文面を変えたら必ずこの値も上げること。**
 */
export const CONSENT_VERSION = '2026-08-13';

/** 同意チェックの隣に出す文面。UI はこれをそのまま表示する（プロダクトごとに書き換えない）。 */
export const CONSENT_TEXT =
  '返信のためにメールアドレスを利用します。返信後30日で削除します。他の目的には使いません。';

/** 連絡先の保持日数。expiresAt はこの日数で切り、Firestore の TTL が自動削除する。 */
export const CONTACT_RETENTION_DAYS = 30;

/** 各項目の上限。増やすと保存量と濫用の面が広がるので、根拠なく緩めない。 */
export const LIMITS = {
  /** プロダクト識別子（例 chess-japan）。URL やコレクション名に使える範囲に絞る。 */
  productMax: 64,
  /** 本文。長文の要望も受け取れるが、丸ごとログを貼られない程度に切る。 */
  messageMax: 2000,
  /** 発生画面。パス相当（例 /review）を想定。 */
  screenMax: 200,
  /** アプリ版。semver + ビルド番号で十分収まる。 */
  appVersionMax: 64,
  /** メールアドレス。RFC 上の上限に合わせる。 */
  emailMax: 254,
} as const;

/** クライアントが組み立てる入力（検証前）。 */
export interface FeedbackInput {
  product: string;
  kind: FeedbackKind;
  message: string;
  /** 発生画面。URL を渡す場合は呼び出し側で query / hash を落としてから渡す。 */
  screen?: string;
  platform?: FeedbackPlatform;
  appVersion?: string;
  /** 返信を希望するか。false なら連絡先は一切保存しない。 */
  wantsReply: boolean;
  /** wantsReply が true のときだけ意味を持つ。 */
  contactEmail?: string;
}

/** `feedback/{id}` に書く本体。**個人情報を入れない**のがこの型の役割。 */
export interface FeedbackDoc {
  product: string;
  kind: FeedbackKind;
  message: string;
  screen: string | null;
  platform: FeedbackPlatform | null;
  appVersion: string | null;
  wantsReply: boolean;
  status: FeedbackStatus;
  /** サーバータイムスタンプを入れる場所。書き込み層が埋める。 */
  createdAt: null;
}

/** `feedback_contacts/{同じid}` に書く連絡先。TTL で自動的に消える。 */
export interface FeedbackContactDoc {
  email: string;
  consentVersion: string;
  /** TTL ポリシーの対象フィールド。この時刻を過ぎると Firestore が文書ごと削除する。 */
  expiresAt: Date;
}

/** 検証結果。ok=false のとき error は UI にそのまま出せる日本語。 */
export type ValidationResult =
  | { ok: true; feedback: FeedbackDoc; contact: FeedbackContactDoc | null }
  | { ok: false; error: string; field: keyof FeedbackInput };
