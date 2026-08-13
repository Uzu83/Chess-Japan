import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthContext, disabledState } from '../auth/authState';
import type { Profile } from '../auth/profile';
import { startCheckout } from '../billing/client';
import { BillingButtons } from './BillingButtons';

vi.mock('../billing/client', () => ({
  isBillingConfigured: () => true,
  startCheckout: vi.fn(async () => {}),
  openCustomerPortal: vi.fn(async () => {}),
}));

vi.mock('./AuthDialog', () => ({
  AuthDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="auth-dialog">auth</div> : null,
}));

const freeProfile: Profile = {
  id: 'u1',
  display_name: null,
  rating: 1200,
  games: 0,
  rating_initialized: true,
  rating_source: 'default',
  plan: 'free',
  stripe_status: 'none',
  created_at: '',
  updated_at: '',
};

function renderBilling(status: 'anonymous' | 'signedIn') {
  return render(
    <AuthContext.Provider
      value={{
        ...disabledState,
        status,
        profile: status === 'signedIn' ? freeProfile : null,
      }}
    >
      <BillingButtons />
    </AuthContext.Provider>,
  );
}

describe('BillingButtons 未ログインからの Pro', () => {
  beforeEach(() => {
    vi.mocked(startCheckout).mockClear();
    sessionStorage.clear();
  });

  it('OAuth 戻りでログイン済みなら Checkout を再開する', async () => {
    sessionStorage.setItem('cj:resume-checkout', '1');
    renderBilling('signedIn');
    await waitFor(() => expect(startCheckout).toHaveBeenCalledTimes(1));
  });

  it('再開フラグが無ければログイン済みでも Checkout しない', async () => {
    renderBilling('signedIn');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pro' })).toBeInTheDocument());
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it('ログインして始めるのあと、ログイン完了で Checkout する', async () => {
    const { rerender } = renderBilling('anonymous');
    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    fireEvent.click(screen.getByRole('button', { name: 'ログインして始める' }));
    expect(screen.getByTestId('auth-dialog')).toBeInTheDocument();

    rerender(
      <AuthContext.Provider value={{ ...disabledState, status: 'signedIn', profile: freeProfile }}>
        <BillingButtons />
      </AuthContext.Provider>,
    );
    await waitFor(() => expect(startCheckout).toHaveBeenCalledTimes(1));
  });
});
