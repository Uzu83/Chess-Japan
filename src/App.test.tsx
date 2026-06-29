import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('タイトルを表示する', () => {
    render(<App />);
    expect(screen.getByText('Chess-Japan — 1手解説AI')).toBeInTheDocument();
  });
});
