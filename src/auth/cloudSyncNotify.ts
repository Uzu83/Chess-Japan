/*
 * cloudSyncNotify.ts — クラウド同期失敗の1回限り通知ヘルパ
 *
 * SyncToastHost と分離（react-refresh: コンポーネントと非コンポーネントの同居回避）。
 */
import { showSyncToast } from '../ui/syncToastBus';

const SESSION_KEY = 'cj:sync-toast-shown';
let moduleShown = false;

/**
 * クラウド保存失敗を同一セッション1回だけ通知。
 * スキップ（未ログイン等）は呼び出し側が呼ばない前提。
 */
export function notifyCloudSyncFailureOnce(reason?: string) {
  let already = false;
  try {
    already = sessionStorage.getItem(SESSION_KEY) === '1';
    if (!already) sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    already = moduleShown;
    moduleShown = true;
  }
  if (already) return;
  showSyncToast(reason ?? 'クラウドへの保存に失敗しました。対局は端末に保存されています。');
}
