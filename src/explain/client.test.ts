import { isBackendConfigured, localExplanation, requestExplanation } from './client';
import type { ExplainRequest } from './client';

const baseReq: ExplainRequest = {
  mode: 'explain',
  game: 'chess',
  context: {
    fenOrSfen: 'fen',
    movePlayed: 'a2a3',
    evalBefore: 50,
    evalAfter: -250,
    bestMove: 'e2e4',
    pv: ['e2e4'],
    quality: 'blunder',
  },
};

describe('explain client (バックエンド未設定)', () => {
  it('isBackendConfigured は false', () => {
    expect(isBackendConfigured()).toBe(false);
  });

  it('localExplanation は手の質と最善手を含む', () => {
    const text = localExplanation(baseReq);
    expect(text).toContain('悪手');
    expect(text).toContain('e2e4');
  });

  it('requestExplanation は未設定時ローカル解説にフォールバック', async () => {
    const text = await requestExplanation(baseReq);
    expect(text).toContain('悪手');
  });

  it('followup はローカル応答を返す', () => {
    const text = localExplanation({ ...baseReq, mode: 'followup', question: 'どういうこと?' });
    expect(text).toContain('どういうこと?');
  });
});
