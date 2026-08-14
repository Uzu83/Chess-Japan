/*
 * submit.ts — validateFeedback を通した値だけを Firestore に create する
 *
 * 真の信頼境界は firestore.rules。ここは:
 *   1. core の検証を必ず通す（未知フィールド・status 偽装・本文とメール同居を防ぐ）
 *   2. createdAt を serverTimestamp() にする（端末時計を書かない）
 *   3. read / update / delete をこのモジュールから出さない
 *
 * 既定の書き込み先は feedback_dev。本番 feedback は target: 'prod' を明示したときだけ。
 */

import {
  doc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import {
  validateFeedback,
  type FeedbackContactDoc,
  type FeedbackDoc,
  type FeedbackInput,
  type ValidationResult,
} from '@tosagiken/feedback-core';
import {
  COLLECTIONS,
  DEFAULT_FEEDBACK_TARGET,
  collectionForTarget,
  type FeedbackTarget,
} from './collections';

/** rules の feedback allowlist。ここに無いキーを足すと create が拒否される。 */
export const FEEDBACK_WRITE_KEYS = [
  'product',
  'kind',
  'message',
  'screen',
  'platform',
  'appVersion',
  'wantsReply',
  'status',
  'createdAt',
] as const;

/** rules の contact allowlist。 */
export const CONTACT_WRITE_KEYS = ['email', 'consentVersion', 'expiresAt'] as const;

/*
 * Spark では TTL が走らず、CONSENT の 30日削除を破る。
 * 請求先は繋がない。連絡先の永続化は B（TTL or 手動削除）まで閉じる。
 */
export const CONTACT_PERSISTENCE_ENABLED = false;

export type FeedbackWriteData = {
  product: string;
  kind: FeedbackDoc['kind'];
  message: string;
  screen: string | null;
  platform: FeedbackDoc['platform'];
  appVersion: string | null;
  wantsReply: boolean;
  status: 'new';
  createdAt: ReturnType<typeof serverTimestamp>;
};

export type ContactWriteData = {
  email: string;
  consentVersion: string;
  expiresAt: Timestamp;
};

export type PlannedFeedbackWrite = {
  id: string;
  target: FeedbackTarget;
  feedbackCollection: string;
  feedbackData: FeedbackWriteData;
  /** wantsReply=false なら null。メールが入力されていても core が捨てる。 */
  contactData: ContactWriteData | null;
};

export type SubmitFeedbackSuccess = { ok: true; id: string };
export type SubmitFeedbackFailure = Extract<ValidationResult, { ok: false }>;
export type SubmitFeedbackResult = SubmitFeedbackSuccess | SubmitFeedbackFailure;

export function newFeedbackId(): string {
  return crypto.randomUUID();
}

export function toFeedbackWriteData(feedback: FeedbackDoc): FeedbackWriteData {
  return {
    product: feedback.product,
    kind: feedback.kind,
    message: feedback.message,
    screen: feedback.screen,
    platform: feedback.platform,
    appVersion: feedback.appVersion,
    wantsReply: feedback.wantsReply,
    // core が必ず 'new' にする。クライアントに仕分け状態を決めさせない。
    status: 'new',
    createdAt: serverTimestamp(),
  };
}

export function toContactWriteData(contact: FeedbackContactDoc): ContactWriteData {
  return {
    email: contact.email,
    consentVersion: contact.consentVersion,
    // core の expiresAt は 30日後。rules 上限は 31日。ここを延ばすな。
    expiresAt: Timestamp.fromDate(contact.expiresAt),
  };
}

export type PlanFeedbackWriteOptions = {
  target?: FeedbackTarget;
  now?: Date;
  id?: string;
};

/**
 * 検証 + 正規化。I/O なし。テストと submitFeedback の共通入口。
 */
export function planFeedbackWrite(
  input: FeedbackInput,
  options: PlanFeedbackWriteOptions = {},
): { ok: true; plan: PlannedFeedbackWrite } | SubmitFeedbackFailure {
  const target = options.target ?? DEFAULT_FEEDBACK_TARGET;
  const validated = validateFeedback(input, options.now ?? new Date());
  if (!validated.ok) return validated;

  return {
    ok: true,
    plan: {
      id: options.id ?? newFeedbackId(),
      target,
      feedbackCollection: collectionForTarget(target),
      feedbackData: toFeedbackWriteData(validated.feedback),
      contactData: validated.contact ? toContactWriteData(validated.contact) : null,
    },
  };
}

/**
 * Spark で contact を書けないときのガード。plan は作れるが submit は拒否する。
 * wantsReply=true の本文だけ書いてメールを捨てると、返信希望の記録が嘘になる。
 */
export function rejectIfContactPersistenceDisabled(
  plan: PlannedFeedbackWrite,
): SubmitFeedbackFailure | null {
  if (CONTACT_PERSISTENCE_ENABLED) return null;
  if (plan.contactData || plan.feedbackData.wantsReply) {
    return {
      ok: false,
      error: '返信希望の受付はまだ開始していません',
      field: 'wantsReply',
    };
  }
  return null;
}

/**
 * Firestore へ create のみ。read/update/delete は呼ばない。
 * contact が有効なときは同じ id で batch する（片方だけ成功して orphan にしない）。
 * CONTACT_PERSISTENCE_ENABLED=false のあいだは contact も wantsReply 本文も書かない。
 */
export async function submitFeedback(
  db: Firestore,
  input: FeedbackInput,
  options: PlanFeedbackWriteOptions = {},
): Promise<SubmitFeedbackResult> {
  const planned = planFeedbackWrite(input, options);
  if (!planned.ok) return planned;

  const blocked = rejectIfContactPersistenceDisabled(planned.plan);
  if (blocked) return blocked;

  const { plan } = planned;
  const batch = writeBatch(db);
  batch.set(doc(db, plan.feedbackCollection, plan.id), plan.feedbackData);
  if (CONTACT_PERSISTENCE_ENABLED && plan.contactData) {
    batch.set(doc(db, COLLECTIONS.contacts, plan.id), plan.contactData);
  }
  await batch.commit();
  return { ok: true, id: plan.id };
}
