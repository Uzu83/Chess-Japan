import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProUpgradeDialog } from './ProUpgradeDialog';

describe('ProUpgradeDialog (#84)', () => {
  it('Escape で onClose する', () => {
    const onClose = vi.fn();
    render(
      <ProUpgradeDialog
        open
        onClose={onClose}
        onConfirm={() => {}}
        confirmLabel="ログインして始める"
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('背景の閉じるボタンで onClose する', () => {
    const onClose = vi.fn();
    render(<ProUpgradeDialog open onClose={onClose} onConfirm={() => {}} />);
    const closers = screen.getAllByRole('button', { name: '閉じる' });
    // absolute inset-0 の背景ボタンが先頭
    fireEvent.click(closers[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('閉じているときは dialog を出さない', () => {
    render(<ProUpgradeDialog open={false} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
