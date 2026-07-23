/*
 * SyncToast.tsx — クラウド同期失敗の軽量バナー（画面下部）
 *
 * WHY モーダルにしないか: 対局体験を止めない。localStorage は成功しているので告知のみ。
 */
import { useEffect, useState } from 'react';
import { subscribeSyncToast } from './syncToastBus';

/** App ルートに1つマウントする。 */
export function SyncToastHost() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timeoutId: number | undefined;
    return subscribeSyncToast((msg) => {
      setMessage(msg);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => setMessage(null), 6000);
    });
  }, []);

  if (!message) return null;

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4"
    >
      <p className="max-w-md rounded-lg border border-border bg-surface px-4 py-2.5 text-center text-xs leading-relaxed text-on-surface shadow-xl">
        {message}
      </p>
    </div>
  );
}
