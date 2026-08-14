/*
 * コレクション名はここだけ。プロダクト分割しない（product フィールドで見分ける）。
 * WHY 定数にするか: クライアントが typo で別コレクションへ書く事故を防ぐ。
 */
export const COLLECTIONS = {
  feedback: 'feedback',
  feedbackDev: 'feedback_dev',
  contacts: 'feedback_contacts',
} as const;

/** 書き込み先。既定は dev。本番を汚さないため、prod は明示したときだけ。 */
export type FeedbackTarget = 'dev' | 'prod';

export const DEFAULT_FEEDBACK_TARGET: FeedbackTarget = 'dev';

export function collectionForTarget(target: FeedbackTarget): string {
  switch (target) {
    case 'dev':
      return COLLECTIONS.feedbackDev;
    case 'prod':
      return COLLECTIONS.feedback;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}
