import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('タイトルとエンジン状態を表示する', async () => {
    render(<App />);
    expect(screen.getByText('Chess-Japan — 1手解説AI')).toBeInTheDocument();
    // エンジン初期化(非同期)が落ち着くまで待つ（jsdom では Worker 不在のためモックにフォールバック）。
    await waitFor(() => expect(screen.getByText(/モック/)).toBeInTheDocument());
  });

  it('レビュー→戻るで対局に戻り、サイトを抜けない（#82）', async () => {
    // テスト開始時の history を基準に、レビュー push 後の pop で play に戻ることを確認する。
    window.history.replaceState({}, '', '/');
    render(<App />);
    await waitFor(() => expect(screen.getByText(/モック/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'レビュー' }));
    expect(new URLSearchParams(window.location.search).get('m')).toBe('review');
    window.history.back();
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('m')).toBeNull();
    });
    expect(screen.getByRole('button', { name: '対局' })).toHaveAttribute('aria-pressed', 'true');
  });
});
