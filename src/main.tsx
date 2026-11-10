import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { initSentryIfConfigured } from './monitoring/sentry.ts';
import { mountWebAnalyticsIfConfigured } from './monitoring/webAnalytics.ts';

// エラー監視(DSN 未設定なら no-op)。render をブロックしない遅延 init — 詳細は monitoring/sentry.ts。
initSentryIfConfigured();
// アクセス集計(トークン未設定なら no-op)。詳細は monitoring/webAnalytics.ts。
mountWebAnalyticsIfConfigured();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
