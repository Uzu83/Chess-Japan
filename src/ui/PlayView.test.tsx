import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { loadRating, loadPlayedGames, playedGameKind } from '../core/storage';

/*
 * PlayView.test.tsx — チェス対局(AI戦)の状態機械 回帰テスト
 *
 * WHY: 将棋(ShogiPlaySession.test.tsx)と同型の orchestration を、本番稼働中の**主機能である
 *   チェス対局**にも敷く。コアの着手/レート計算は playGame/rating のテストが担うので、ここは
 *   PlayView がそれらをどう配線するか（AI 自動着手・レート適用・0手保存スキップ・待った降格・
 *   turnToken キャンセル）を mock engine で決定的に固定する。将棋版との対称ハードニング。
 *
 * テスト環境: チェスは COI 不要（lite-single・SAB 不要）なので将棋のような crossOriginIsolated
 *   のモックは不要。engine factory(createEngine) を制御可能 mock に、PlayBoard を props 捕獲スタブに、
 *   localStorage を MemoryStorage に stub する（storage.test.ts と同流儀）。
 */

// 対局エンジンを制御可能な mock に差し替え（Stockfish WASM は jsdom で動かない）。
const engineChooseMove = vi.fn<(fen: string, opts?: unknown) => Promise<string | null>>();
vi.mock('../engine/factory', () => ({
  createEngine: vi.fn(async () => ({
    engine: {
      init: async () => {},
      analyze: async () => ({ fen: '', depth: 1, lines: [], bestMove: null }),
      chooseMove: (fen: string, opts?: unknown) => engineChooseMove(fen, opts),
      dispose: () => {},
    },
    kind: 'stockfish',
  })),
}));

// PlayBoard は chessground 依存。状態機械テストでは props(onUserMove 等)を捕まえるスタブに差し替える。
const boardHolder = vi.hoisted(() => ({
  props: null as null | { onUserMove: (from: string, to: string, promotion?: string) => void },
}));
vi.mock('./PlayBoard', () => ({
  PlayBoard: (props: (typeof boardHolder)['props']) => {
    boardHolder.props = props;
    return null;
  },
}));

import { PlayView } from './PlayView';

class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

const onReview = vi.fn();

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
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
  Element.prototype.scrollIntoView = () => {};
  engineChooseMove.mockReset();
  engineChooseMove.mockResolvedValue(null);
  onReview.mockReset();
  boardHolder.props = null;
});

/** エンジン準備が終わり「対局開始」が活性化するまで待つ。 */
async function waitForStartEnabled(): Promise<HTMLElement> {
  const startBtn = await screen.findByRole('button', { name: '対局開始' });
  await waitFor(() => expect(startBtn).toBeEnabled());
  return startBtn;
}

describe('PlayView 状態機械（チェス）', () => {
  it('レート戦で開始即投了(0手): 履歴は保存されないがレートは下がる（逃げ得防止）', async () => {
    render(<PlayView onReview={onReview} />);
    fireEvent.click(await waitForStartEnabled()); // 既定=レート戦・白で開始
    fireEvent.click(await screen.findByRole('button', { name: '投了' }));

    expect(await screen.findByText('あなたの負け')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この対局を振り返る' })).toBeNull();
    expect(loadPlayedGames().filter((g) => playedGameKind(g) === 'chess')).toHaveLength(0);
    await waitFor(() => {
      const r = loadRating();
      expect(r).not.toBeNull();
      expect(r!.rating).toBeLessThan(1200);
      expect(r!.games).toBe(1);
    });
  });

  it('カジュアルで投了してもレートは動かない（保存もされない）', async () => {
    render(<PlayView onReview={onReview} />);
    await waitForStartEnabled();
    fireEvent.click(screen.getByRole('button', { name: /カジュアル/ }));
    fireEvent.click(await waitForStartEnabled());
    fireEvent.click(await screen.findByRole('button', { name: '投了' }));

    expect(await screen.findByText('あなたの負け')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(loadRating()).toBeNull();
  });

  it('黒を選ぶと AI(白)が開始と同時に初手を指す（runAiMove 自動発火）', async () => {
    engineChooseMove.mockResolvedValue('e2e4'); // AI(白)の初手 → SAN "e4"
    render(<PlayView onReview={onReview} />);
    await waitForStartEnabled();
    fireEvent.click(screen.getByRole('button', { name: /黒（後手）/ }));
    fireEvent.click(await waitForStartEnabled());

    await waitFor(() => expect(engineChooseMove).toHaveBeenCalled());
    expect(await screen.findByText('e4')).toBeInTheDocument();
  });

  it('待った を使うとレート戦でもレートが動かない（公平性・降格）', async () => {
    engineChooseMove.mockResolvedValue('e7e5'); // AI(黒)の応手 → SAN "e5"
    render(<PlayView onReview={onReview} />);
    fireEvent.click(await waitForStartEnabled()); // レート戦・白で開始
    await waitFor(() => expect(boardHolder.props).not.toBeNull());
    await act(async () => {
      boardHolder.props!.onUserMove('e2', 'e4'); // あなた(白)が e4
    });
    expect(await screen.findByText('e5')).toBeInTheDocument(); // AI が e5 で応手
    fireEvent.click(screen.getByRole('button', { name: '待った' }));
    fireEvent.click(screen.getByRole('button', { name: '投了' }));
    expect(await screen.findByText('あなたの負け')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(loadRating()).toBeNull(); // 待った使用でレート未保存
  });

  it('AI 思考中に「中断して新規」すると、後から届く AI の手は破棄される（stale token）', async () => {
    let resolveMove!: (uci: string | null) => void;
    engineChooseMove.mockImplementation(
      () =>
        new Promise<string | null>((res) => {
          resolveMove = res;
        }),
    );
    render(<PlayView onReview={onReview} />);
    await waitForStartEnabled();
    fireEvent.click(screen.getByRole('button', { name: /黒（後手）/ }));
    fireEvent.click(await waitForStartEnabled());
    await waitFor(() => expect(engineChooseMove).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /中断して新規/ }));
    await waitForStartEnabled();
    await act(async () => {
      resolveMove('e2e4');
    });
    expect(screen.queryByText('e4')).toBeNull(); // 破棄され棋譜に出ない
    expect(screen.getByRole('button', { name: '対局開始' })).toBeInTheDocument();
  });
});
