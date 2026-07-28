import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_MAX_BODY_BYTES,
  buildFeedbackIssueBody,
  buildFeedbackIssueTitle,
  encodeFeedbackPayloadB64,
  normalizePageUrl,
  stripControls,
  validateFeedbackBody,
} from './feedbackValidate';

const valid = {
  kind: 'bug',
  message: '対局画面で待ったが効かない',
  consentPublic: true as const,
};

describe('stripControls', () => {
  it('改行は残し、NUL 等は落とす', () => {
    expect(stripControls('a\nb\u0000c')).toBe('a\nbc');
  });
});

describe('normalizePageUrl', () => {
  it('query/hash を落とす', () => {
    const r = normalizePageUrl('https://chess-japan.pages.dev/play?token=secret#x');
    expect(r).toEqual({ ok: true, value: 'https://chess-japan.pages.dev/play' });
  });
  it('不正 URL を拒否', () => {
    expect(normalizePageUrl('not a url').ok).toBe(false);
  });
  it('javascript: を拒否', () => {
    expect(normalizePageUrl('javascript:alert(1)').ok).toBe(false);
  });
});

describe('validateFeedbackBody', () => {
  it('最小ボディを通す', () => {
    const r = validateFeedbackBody(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('bug');
  });

  it('consentPublic 無しは拒否', () => {
    const r = validateFeedbackBody({ kind: 'bug', message: 'x' });
    expect(r.ok).toBe(false);
  });

  it('未知フィールド拒否', () => {
    const r = validateFeedbackBody({ ...valid, evil: '1' });
    expect(r.ok).toBe(false);
  });

  it('context の許可外キー拒否', () => {
    const r = validateFeedbackBody({ ...valid, context: { secret: 'x' } });
    expect(r.ok).toBe(false);
  });

  it('context.fen を通す', () => {
    const r = validateFeedbackBody({
      ...valid,
      context: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
    });
    expect(r.ok).toBe(true);
  });

  it('message 過長を拒否', () => {
    const r = validateFeedbackBody({ ...valid, message: 'あ'.repeat(2001) });
    expect(r.ok).toBe(false);
  });

  it('kind 不正を拒否', () => {
    const r = validateFeedbackBody({ ...valid, kind: 'hack' });
    expect(r.ok).toBe(false);
  });
});

describe('encode + issue body', () => {
  it('title に message を含めない', () => {
    const title = buildFeedbackIssueTitle('bug', '2026-07-18T00:00:00Z');
    expect(title).toBe('[feedback/bug] 2026-07-18T00:00:00Z');
    expect(title.includes('待った')).toBe(false);
  });

  it('Issue body は符号化ブロックを含み、生 message を本文直書きしない', () => {
    const payload = validateFeedbackBody(valid);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const body = buildFeedbackIssueBody(payload.value, '2026-07-18T00:00:00Z');
    expect(body).toContain('feedback-schema: v1');
    expect(body).toContain('encoded_payload_b64');
    // 生の日本語 message がフェンス外に出ないこと（符号化内には入りうる）
    const withoutFence = body.split('```')[0] ?? '';
    expect(withoutFence.includes(valid.message)).toBe(false);
    const b64 = encodeFeedbackPayloadB64(payload.value);
    expect(body).toContain(b64);
  });

  it('MAX は 8KB', () => {
    expect(FEEDBACK_MAX_BODY_BYTES).toBe(8 * 1024);
  });
});
