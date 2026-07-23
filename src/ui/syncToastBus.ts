/*
 * syncToastBus.ts — SyncToastHost 向けの pub/sub（コンポーネントと分離）
 */
type ToastListener = (message: string) => void;
const listeners = new Set<ToastListener>();

export function showSyncToast(message: string) {
  for (const fn of listeners) fn(message);
}

export function subscribeSyncToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
