import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
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

  it('閉じたあとフォーカスを開く前の要素へ戻す（Codex major）', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            開く
          </button>
          <ProUpgradeDialog open={open} onClose={() => setOpen(false)} onConfirm={() => {}} />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '開く' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
