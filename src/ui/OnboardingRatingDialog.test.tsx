import { render, screen, fireEvent } from '@testing-library/react';
import { saveRating } from '../core/storage';
import { OnboardingRatingDialog } from './OnboardingRatingDialog';

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

describe('OnboardingRatingDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('プリセットをクリックしても submit せず、決定で確定する', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<OnboardingRatingDialog onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('radio', { name: /初心者/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '初期レートの設定' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '選択した実力で始める' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(1200, 'self_beginner');
  });

  it('未選択の決定は disabled', () => {
    render(<OnboardingRatingDialog onSubmit={vi.fn(async () => {})} />);
    expect(screen.getByRole('button', { name: '選択した実力で始める' })).toBeDisabled();
  });

  it('中級者を選んでから決定すると 1500 で submit する', () => {
    const onSubmit = vi.fn(async () => {});
    render(<OnboardingRatingDialog onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /中級者/ }));
    fireEvent.click(screen.getByRole('button', { name: '選択した実力で始める' }));
    expect(onSubmit).toHaveBeenCalledWith(1500, 'self_intermediate');
  });

  it('スキップは確認なしで default 1200', () => {
    const onSubmit = vi.fn(async () => {});
    render(<OnboardingRatingDialog onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /スキップ/ }));
    expect(onSubmit).toHaveBeenCalledWith(1200, 'default');
  });

  it('カスタム入力の決定は入力したレートで submit する', () => {
    const onSubmit = vi.fn(async () => {});
    render(<OnboardingRatingDialog onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/直接入力/), { target: { value: '1350' } });
    fireEvent.click(screen.getByRole('button', { name: '入力したレートで始める' }));
    expect(onSubmit).toHaveBeenCalledWith(1350, 'self_custom');
  });

  it('ローカルレートの引き継ぎはラベル付きの即確定のまま', () => {
    saveRating({ rating: 1420, games: 8 });
    const onSubmit = vi.fn(async () => {});
    render(<OnboardingRatingDialog onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /この端末のレート 1420 を引き継ぐ/ }));
    expect(onSubmit).toHaveBeenCalledWith(1420, 'local_migrated');
  });
});
