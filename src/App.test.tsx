import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('タイトルとエンジン状態を表示する', async () => {
    render(<App />);
    expect(screen.getByText('Chess-Japan — 1手解説AI')).toBeInTheDocument();
    // エンジン初期化(非同期)が落ち着くまで待つ（jsdom では Worker 不在のためモックにフォールバック）。
    await waitFor(() => expect(screen.getByText(/モック/)).toBeInTheDocument());
  });
});
