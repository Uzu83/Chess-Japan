/*
 * feedback/client.ts — Edge Function `feedback` 呼び出し
 *
 * WHY env を関数で読むか: explain/client.ts と同じ（import 時固定を避け vitest stubEnv 可能に）。
 * 真の信頼境界はサーバ。ここは送信前の補助検証 + UX。
 */
import { getTurnstileToken } from '../explain/turnstile';
import {
  type FeedbackKind,
  type FeedbackPayload,
  validateFeedbackBody,
} from '../../supabase/functions/_shared/feedbackValidate';

export type { FeedbackKind, FeedbackPayload };

function supabaseUrl(): string | undefined {
  return import.meta.env.VITE_SUPABASE_URL as string | undefined;
}
function supabaseAnon(): string | undefined {
  return import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
}
function feedbackFormUrl(): string | undefined {
  return import.meta.env.VITE_FEEDBACK_URL as string | undefined;
}

/** アプリ内送信（Edge）が使えるか。 */
export function isFeedbackBackendConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnon());
}

/** Google Form 等のフォールバック URL。 */
export function getFeedbackFormUrl(): string | undefined {
  const u = feedbackFormUrl();
  return u && u.length > 0 ? u : undefined;
}

/** フィードバック導線を出すか（Edge か Form のどちらか）。 */
export function isFeedbackAvailable(): boolean {
  return isFeedbackBackendConfigured() || Boolean(getFeedbackFormUrl());
}

export type FeedbackSubmitResult =
  { ok: true; issueUrl: string } | { ok: false; error: string; fallbackUrl?: string };

/**
 * フィードバック送信。
 * Edge 未設定時は Form URL があればそれを fallback として返す（呼び側で開く）。
 */
export async function submitFeedback(
  input: Omit<FeedbackPayload, 'consentPublic'> & { consentPublic: boolean },
): Promise<FeedbackSubmitResult> {
  if (!input.consentPublic) {
    return { ok: false, error: '公開 Issue への同意が必要です' };
  }

  const validated = validateFeedbackBody({ ...input, consentPublic: true });
  if (!validated.ok) {
    return { ok: false, error: validated.error, fallbackUrl: getFeedbackFormUrl() };
  }

  if (!isFeedbackBackendConfigured()) {
    const fallbackUrl = getFeedbackFormUrl();
    return {
      ok: false,
      error: 'feedback ingest unavailable',
      fallbackUrl,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${supabaseAnon()}`,
  };
  const turnstileToken = await getTurnstileToken();
  if (turnstileToken) headers['x-turnstile-token'] = turnstileToken;

  let res: Response;
  try {
    res = await fetch(`${supabaseUrl()}/functions/v1/feedback`, {
      method: 'POST',
      headers,
      body: JSON.stringify(validated.value),
    });
  } catch {
    return {
      ok: false,
      error: 'network error',
      fallbackUrl: getFeedbackFormUrl(),
    };
  }

  let data: { ok?: boolean; issueUrl?: string; error?: string; fallbackUrl?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return {
      ok: false,
      error: `feedback API error: ${res.status}`,
      fallbackUrl: getFeedbackFormUrl(),
    };
  }

  if (res.ok && data.ok && data.issueUrl) {
    return { ok: true, issueUrl: data.issueUrl };
  }

  return {
    ok: false,
    error: data.error ?? `feedback API error: ${res.status}`,
    fallbackUrl: data.fallbackUrl ?? getFeedbackFormUrl(),
  };
}
