import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { loadRatingFor, loadPlayedGames, playedGameKind } from '../core/storage';

/*
 * ShogiPlaySession.test.tsx — 将棋対局セッションの状態機械 回帰テスト（Phase 4-2 バックログ②）
 *
 * WHY コンポーネントテストにするか:
 *   コアの着手/終局判定は shogiPlayGame.test.ts（25 tests）が、レート計算は rating.test.ts が担う。
 *   ここで固めるのは **ShogiPlaySession が両者をどう配線するか**という orchestration:
 *     ①レート戦の 0 手即投了は履歴保存されないがレートは下がる（逃げ得防止）
 *     ②カジュアルは投了してもレートが動かない
 *     ③後手を選ぶと AI（先手）が開始と同時に初手を指す（runAiMove の自動発火）
 *   これらは実ブラウザでは何度も手で確かめてきたが、回帰で静かに壊れやすい（実際 Phase 4-1〜4-3 で
 *   複数の見た目/表記バグを出した領域）。mock engine で決定的に固定する。
 *
 * テスト環境の障壁と回避（重要・将来の担当者へ）:
 *   - COI_ENABLED は ShogiPlaySession モジュールのロード時に window.crossOriginIsolated を捕獲する
 *     module-level const。jsdom では未定義=false になり engineKind='unsupported' で対局できない。
 *     → vi.hoisted で **import より前** に true 化する（hoisted は全 import の前に走る）。
 *   - 本物のやねうら王 WASM は jsdom で動かないので engine factory を制御可能な mock に差し替える
 *     （chooseMove の返り値をテストごとに脚本する）。
 *   - ShogiPlayBoard は shogiground 依存で描画が重い。状態機械の検証には不要なので props を捨てる
 *     スタブへ差し替える（盤操作はこのテストの対象外＝着手は core とレビュー E2E が担保済み）。
 */

// COI_ENABLED（module-level const）を true にするため、import より前に window へ生やす。
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    value: true,
    configurable: true,
    writable: true,
  });
});

// 対局エンジンを制御可能な mock に差し替え。chooseMove の返り値はテストごとに engineChooseMove で脚本。
const engineChooseMove = vi.fn<(sfen: string, opts?: unknown) => Promise<string | null>>();
vi.mock('../engine/factory', () => ({
  createShogiEngine: vi.fn(async () => ({
    engine: {
      init: async () => {},
      analyze: async () => ({ fen: '', depth: 1, lines: [], bestMove: null }),
      chooseMove: (sfen: string, opts?: unknown) => engineChooseMove(sfen, opts),
      dispose: () => {},
    },
    kind: 'yaneuraou',
  })),
}));

// ShogiPlayBoard は shogiground 依存。状態機械テストでは描画不要なのでスタブ化。
vi.mock('./ShogiPlayBoard', () => ({
  ShogiPlayBoard: () => null,
}));

// ↑ の mock/hoisted が効いた状態で import する（static import で問題ないが、意図を明示）。
import ShogiPlaySession from './ShogiPlaySession';

/*
 * localStorage は jsdom の既定オリジン(about:blank)で不安定なため、storage.test.ts と同じく
 * MemoryStorage に stubGlobal して決定的にする。storage.ts はグローバル localStorage を参照するので
 * これで component 側の読み書きも同じストアに乗る。
 */
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

const onReview = vi.fn();

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  // ShogiMoveList のスクロール効果が prefers-reduced-motion を見る。jsdom は matchMedia 未実装なので stub。
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  // 棋譜追記時の自動スクロール。jsdom は scrollIntoView 未実装なので no-op を生やす。
  Element.prototype.scrollIntoView = () => {};
  engineChooseMove.mockReset();
  engineChooseMove.mockResolvedValue(null); // 既定: AI は指さない（0手投了テスト用）
  onReview.mockReset();
});

/** エンジン準備が終わり「対局開始」が活性化するまで待って、そのボタンを返す。 */
async function waitForStartEnabled(): Promise<HTMLElement> {
  const startBtn = await screen.findByRole('button', { name: '対局開始' });
  await waitFor(() => expect(startBtn).toBeEnabled());
  return startBtn;
}

describe('ShogiPlaySession 状態機械', () => {
  it('レート戦で開始即投了(0手): 履歴は保存されないがレートは下がる（逃げ得防止）', async () => {
    render(<ShogiPlaySession onReview={onReview} />);
    const startBtn = await waitForStartEnabled();
    // 既定=レート戦・先手で開始（AI 応手なし＝chooseMove は null）。
    fireEvent.click(startBtn);
    // 投了する。
    fireEvent.click(await screen.findByRole('button', { name: '投了' }));

    // 結果は「あなたの負け」。
    expect(await screen.findByText('あなたの負け')).toBeInTheDocument();
    // 0手なので棋譜が無く「この対局を振り返る」は出ない（KIF が読めず振り返りが壊れるため）。
    expect(screen.queryByRole('button', { name: 'この対局を振り返る' })).toBeNull();

    // 履歴（cj:games）には将棋の対局が保存されていない（0手はスキップ）。
    expect(loadPlayedGames().filter((g) => playedGameKind(g) === 'shogi')).toHaveLength(0);
    // レートは下がって永続化される（逃げ得防止・1200 未満・games=1）。
    await waitFor(() => {
      const r = loadRatingFor('shogi');
      expect(r).not.toBeNull();
      expect(r!.rating).toBeLessThan(1200);
      expect(r!.games).toBe(1);
    });
  });

  it('カジュアルで投了してもレートは動かない（保存もされない）', async () => {
    render(<ShogiPlaySession onReview={onReview} />);
    await waitForStartEnabled();
    // 「カジュアル」を選んでから開始。
    fireEvent.click(screen.getByRole('button', { name: /カジュアル/ }));
    fireEvent.click(await waitForStartEnabled());
    fireEvent.click(await screen.findByRole('button', { name: '投了' }));

    expect(await screen.findByText('あなたの負け')).toBeInTheDocument();
    // カジュアルはレート未保存のまま（null＝初期値のまま動かない）。
    // 少し待っても保存されないことを確認。
    await new Promise((r) => setTimeout(r, 0));
    expect(loadRatingFor('shogi')).toBeNull();
  });

  it('後手を選ぶと AI(先手)が開始と同時に初手を指す（runAiMove 自動発火）', async () => {
    engineChooseMove.mockResolvedValue('7g7f'); // AI(先手)の初手 ☗７六歩
    render(<ShogiPlaySession onReview={onReview} />);
    await waitForStartEnabled();
    // 手番=後手を選択して開始。
    fireEvent.click(screen.getByRole('button', { name: '後手' }));
    fireEvent.click(await waitForStartEnabled());

    // AI の chooseMove が呼ばれ、棋譜に ☗７六歩 が現れる。
    await waitFor(() => expect(engineChooseMove).toHaveBeenCalled());
    expect(await screen.findByText('☗７六歩')).toBeInTheDocument();
  });
});
