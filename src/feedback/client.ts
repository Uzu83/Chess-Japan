/*
 * feedback/client.ts — feedback-adcd2（Firestore）への送信
 *
 * 手順の正: ~/development/projects/feedback-platform/docs/CONNECT.md
 *
 * WHY Edge GitHub Issue をやめたか:
 *   公開 Issue は書きにくく受信箱も露出する。共通非公開 Firestore へ寄せる。
 *   create のみ・named app feedback-adcd2・wantsReply は当面 false 固定。
 *
 * WHY vendor 経由か:
 *   file:../feedback-platform は Cloudflare Pages で親ディレクトリが無く壊れる。
 */
import {
  initFeedbackFirestore,
  submitFeedback as submitFeedbackDoc,
  type FeedbackTarget,
} from '@tosagiken/feedback-web';
import type { FeedbackKind as FirestoreFeedbackKind } from '@tosagiken/feedback-core';
import type { Firestore } from 'firebase/firestore';

/** UI 用。Firestore 共通 kind に無い explain_quality を含む。 */
export const CHESS_FEEDBACK_KINDS = ['bug', 'feature', 'explain_quality', 'ux', 'other'] as const;
export type ChessFeedbackKind = (typeof CHESS_FEEDBACK_KINDS)[number];

/** 旧 UI 互換の別名。 */
export type FeedbackKind = ChessFeedbackKind;

export const FEEDBACK_DEVICES = ['phone', 'tablet', 'pc'] as const;
export type FeedbackDevice = (typeof FEEDBACK_DEVICES)[number];

export const FEEDBACK_BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'other'] as const;
export type FeedbackBrowser = (typeof FEEDBACK_BROWSERS)[number];

const PRODUCT = 'chess-japan';
const SCREEN = 'feedback-modal';

function env(name: keyof ImportMetaEnv): string | undefined {
  const v = import.meta.env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function feedbackFormUrl(): string | undefined {
  return env('VITE_FEEDBACK_URL');
}

/** Google Form 等のフォールバック URL。 */
export function getFeedbackFormUrl(): string | undefined {
  return feedbackFormUrl();
}

/** Firebase Web config が揃っているか。 */
export function isFeedbackBackendConfigured(): boolean {
  return Boolean(
    env('VITE_FEEDBACK_FIREBASE_API_KEY') &&
    env('VITE_FEEDBACK_FIREBASE_AUTH_DOMAIN') &&
    env('VITE_FEEDBACK_FIREBASE_PROJECT_ID') &&
    env('VITE_FEEDBACK_FIREBASE_APP_ID') &&
    env('VITE_FEEDBACK_FIREBASE_MESSAGING_SENDER_ID') &&
    env('VITE_FEEDBACK_FIREBASE_STORAGE_BUCKET'),
  );
}

/** フィードバック導線を出すか（Firestore か Form のどちらか）。 */
export function isFeedbackAvailable(): boolean {
  return isFeedbackBackendConfigured() || Boolean(getFeedbackFormUrl());
}

/** Pages 本番だけ VITE_FEEDBACK_TARGET=prod。それ以外は省略 → feedback_dev。 */
export function resolveFeedbackTarget(): FeedbackTarget | undefined {
  return env('VITE_FEEDBACK_TARGET') === 'prod' ? 'prod' : undefined;
}

/**
 * UI kind → Firestore kind。explain_quality は other + 本文プレフィックス。
 * 共有スキーマにプロダクト固有 kind を足さない（CONNECT）。
 */
export function mapChessKindToFirestore(kind: ChessFeedbackKind): {
  kind: FirestoreFeedbackKind;
  messagePrefix: string | null;
} {
  if (kind === 'explain_quality') {
    return { kind: 'other', messagePrefix: '[解説の品質]' };
  }
  return { kind, messagePrefix: null };
}

export type BuildFeedbackMessageInput = {
  message: string;
  kind: ChessFeedbackKind;
  repro?: string;
  boardPaste?: string;
  device?: FeedbackDevice;
  browser?: FeedbackBrowser;
};

/** 局面・再現・端末などスキーマ外フィールドを本文へ畳む。 */
export function buildFeedbackMessage(input: BuildFeedbackMessageInput): string {
  const { messagePrefix } = mapChessKindToFirestore(input.kind);
  const parts: string[] = [];
  const body = input.message.trim();
  if (messagePrefix) {
    parts.push(messagePrefix + (body ? ` ${body}` : ''));
  } else if (body) {
    parts.push(body);
  }

  const repro = input.repro?.trim();
  if (repro) parts.push(`---\n再現手順:\n${repro}`);

  const board = input.boardPaste?.trim();
  if (board) parts.push(`---\n局面・棋譜:\n${board}`);

  const meta: string[] = [];
  if (input.device) meta.push(`端末: ${input.device}`);
  if (input.browser) meta.push(`ブラウザ: ${input.browser}`);
  if (meta.length > 0) parts.push(`---\n${meta.join(' / ')}`);

  // Firestore messageMax=2000。超過は末尾を切る（本文優先で先頭を残す）。
  const joined = parts.join('\n\n').trim();
  return joined.length <= 2000 ? joined : joined.slice(0, 2000);
}

export type FeedbackSubmitInput = {
  kind: ChessFeedbackKind;
  message: string;
  repro?: string;
  boardPaste?: string;
  device?: FeedbackDevice;
  browser?: FeedbackBrowser;
  appVersion?: string;
};

export type FeedbackSubmitResult =
  { ok: true; id: string } | { ok: false; error: string; fallbackUrl?: string };

let dbCache: Firestore | null = null;

function getDb(): Firestore {
  if (dbCache) return dbCache;
  const { db } = initFeedbackFirestore({
    apiKey: env('VITE_FEEDBACK_FIREBASE_API_KEY')!,
    authDomain: env('VITE_FEEDBACK_FIREBASE_AUTH_DOMAIN')!,
    projectId: env('VITE_FEEDBACK_FIREBASE_PROJECT_ID')!,
    appId: env('VITE_FEEDBACK_FIREBASE_APP_ID')!,
    messagingSenderId: env('VITE_FEEDBACK_FIREBASE_MESSAGING_SENDER_ID')!,
    storageBucket: env('VITE_FEEDBACK_FIREBASE_STORAGE_BUCKET')!,
  });
  dbCache = db;
  return db;
}

/** テスト用に DB キャッシュを捨てる。 */
export function resetFeedbackDbCacheForTests(): void {
  dbCache = null;
}

/**
 * フィードバック送信。
 * Firestore 未設定時は Form URL があればそれを fallback として返す。
 */
export async function submitFeedback(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
  const fallbackUrl = getFeedbackFormUrl();
  const mapped = mapChessKindToFirestore(input.kind);
  const message = buildFeedbackMessage(input);
  if (!message) {
    return { ok: false, error: '内容を入力してください', fallbackUrl };
  }

  if (!isFeedbackBackendConfigured()) {
    return {
      ok: false,
      error: 'feedback ingest unavailable',
      fallbackUrl,
    };
  }

  try {
    const db = getDb();
    const target = resolveFeedbackTarget();
    const result = await submitFeedbackDoc(
      db,
      {
        product: PRODUCT,
        kind: mapped.kind,
        message,
        screen: SCREEN,
        platform: 'web',
        appVersion: input.appVersion,
        wantsReply: false,
      },
      target ? { target } : {},
    );
    if (!result.ok) {
      return { ok: false, error: result.error, fallbackUrl };
    }
    return { ok: true, id: result.id };
  } catch {
    return {
      ok: false,
      error: '送信に失敗しました。時間をおいて再度お試しください。',
      fallbackUrl,
    };
  }
}
