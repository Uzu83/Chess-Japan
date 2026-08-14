import {
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions,
} from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

/**
 * feedback-adcd2 専用の named app。ホスト（Chess 等）のデフォルトアプリに相乗りしない。
 * 無名 initializeApp() だとホスト側と duplicate-app になる。
 */
export const FEEDBACK_APP_NAME = 'feedback-adcd2';

/** 唯一の書き込み先。これ以外の projectId は拒否する。 */
export const FEEDBACK_PROJECT_ID = 'feedback-adcd2';

function assertFeedbackProjectId(options: FirebaseOptions): void {
  if (options.projectId !== FEEDBACK_PROJECT_ID) {
    throw new Error(
      `feedback Firestore projectId must be "${FEEDBACK_PROJECT_ID}" (got "${options.projectId ?? ''}")`,
    );
  }
}

/**
 * feedback-adcd2 の Firestore を返す。必ずこのプロジェクトの config を渡す。
 * ホストアプリの getFirestore(app) を流用しない（別プロジェクトに書き込む）。
 */
export function initFeedbackFirestore(options: FirebaseOptions): {
  app: FirebaseApp;
  db: Firestore;
} {
  assertFeedbackProjectId(options);
  const existing = getApps().find((app) => app.name === FEEDBACK_APP_NAME);
  if (existing) {
    assertFeedbackProjectId(existing.options);
    return { app: existing, db: getFirestore(existing) };
  }
  const app = initializeApp(options, FEEDBACK_APP_NAME);
  return { app, db: getFirestore(app) };
}
