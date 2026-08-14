import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initFeedbackFirestore = vi.fn();
const submitFeedbackDoc = vi.fn();

vi.mock('@tosagiken/feedback-web', () => ({
  initFeedbackFirestore: (...args: unknown[]) => initFeedbackFirestore(...args),
  submitFeedback: (...args: unknown[]) => submitFeedbackDoc(...args),
}));

describe('feedback/client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    initFeedbackFirestore.mockReset();
    submitFeedbackDoc.mockReset();
    initFeedbackFirestore.mockReturnValue({ db: { __brand: 'db' } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function load() {
    return import('./client');
  }

  function stubFirebaseEnv() {
    vi.stubEnv('VITE_FEEDBACK_FIREBASE_API_KEY', 'key');
    vi.stubEnv('VITE_FEEDBACK_FIREBASE_AUTH_DOMAIN', 'feedback-adcd2.firebaseapp.com');
    vi.stubEnv('VITE_FEEDBACK_FIREBASE_PROJECT_ID', 'feedback-adcd2');
    vi.stubEnv('VITE_FEEDBACK_FIREBASE_APP_ID', '1:1:web:abc');
    vi.stubEnv('VITE_FEEDBACK_FIREBASE_MESSAGING_SENDER_ID', '1');
    vi.stubEnv('VITE_FEEDBACK_FIREBASE_STORAGE_BUCKET', 'feedback-adcd2.firebasestorage.app');
  }

  it('mapChessKindToFirestore: explain_quality → other + prefix', async () => {
    const { mapChessKindToFirestore } = await load();
    expect(mapChessKindToFirestore('explain_quality')).toEqual({
      kind: 'other',
      messagePrefix: '[解説の品質]',
    });
    expect(mapChessKindToFirestore('bug')).toEqual({ kind: 'bug', messagePrefix: null });
  });

  it('buildFeedbackMessage は局面と再現を畳み、prefix を付ける', async () => {
    const { buildFeedbackMessage } = await load();
    const msg = buildFeedbackMessage({
      kind: 'explain_quality',
      message: ' ev が変 ',
      repro: 'e4 を解説',
      boardPaste: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      device: 'pc',
      browser: 'chrome',
    });
    expect(msg.startsWith('[解説の品質]')).toBe(true);
    expect(msg).toContain('ev が変');
    expect(msg).toContain('再現手順:');
    expect(msg).toContain('局面・棋譜:');
    expect(msg).toContain('端末: pc');
    expect(msg.length).toBeLessThanOrEqual(2000);
  });

  it('resolveFeedbackTarget: prod のときだけ prod', async () => {
    const { resolveFeedbackTarget } = await load();
    expect(resolveFeedbackTarget()).toBeUndefined();
    vi.stubEnv('VITE_FEEDBACK_TARGET', 'prod');
    // env はモジュール再読込が必要（関数は毎回 import.meta.env を読むので stub だけで足りる）
    expect(resolveFeedbackTarget()).toBe('prod');
  });

  it('未設定なら Form フォールバック', async () => {
    vi.stubEnv('VITE_FEEDBACK_URL', 'https://forms.gle/test');
    const { submitFeedback, isFeedbackBackendConfigured } = await load();
    expect(isFeedbackBackendConfigured()).toBe(false);
    const r = await submitFeedback({ kind: 'bug', message: 'hello' });
    expect(r).toEqual({
      ok: false,
      error: 'feedback ingest unavailable',
      fallbackUrl: 'https://forms.gle/test',
    });
    expect(submitFeedbackDoc).not.toHaveBeenCalled();
  });

  it('設定あり・TARGET 無しなら target 省略で submit', async () => {
    stubFirebaseEnv();
    submitFeedbackDoc.mockResolvedValue({ ok: true, id: 'abc' });
    const { submitFeedback, resetFeedbackDbCacheForTests } = await load();
    resetFeedbackDbCacheForTests();
    const r = await submitFeedback({ kind: 'bug', message: '盤が固まる' });
    expect(r).toEqual({ ok: true, id: 'abc' });
    expect(initFeedbackFirestore).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'feedback-adcd2' }),
    );
    expect(submitFeedbackDoc).toHaveBeenCalledTimes(1);
    const [, input, opts] = submitFeedbackDoc.mock.calls[0]!;
    expect(input).toMatchObject({
      product: 'chess-japan',
      kind: 'bug',
      screen: 'feedback-modal',
      platform: 'web',
      wantsReply: false,
    });
    expect(opts).toEqual({});
  });

  it('VITE_FEEDBACK_TARGET=prod なら target prod', async () => {
    stubFirebaseEnv();
    vi.stubEnv('VITE_FEEDBACK_TARGET', 'prod');
    submitFeedbackDoc.mockResolvedValue({ ok: true, id: 'prod1' });
    const { submitFeedback, resetFeedbackDbCacheForTests } = await load();
    resetFeedbackDbCacheForTests();
    await submitFeedback({ kind: 'ux', message: 'ボタンが遠い' });
    const opts = submitFeedbackDoc.mock.calls[0]![2];
    expect(opts).toEqual({ target: 'prod' });
  });

  it('throw 時は日本語エラー + Form', async () => {
    stubFirebaseEnv();
    vi.stubEnv('VITE_FEEDBACK_URL', 'https://forms.gle/x');
    submitFeedbackDoc.mockRejectedValue(new Error('quota'));
    const { submitFeedback, resetFeedbackDbCacheForTests } = await load();
    resetFeedbackDbCacheForTests();
    const r = await submitFeedback({ kind: 'other', message: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/送信に失敗/);
      expect(r.fallbackUrl).toBe('https://forms.gle/x');
    }
  });
});
