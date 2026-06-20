// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../../lib/api-client.js';
import type { OnboardingState } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import { KycOnboardingControl } from './kyc-onboarding.js';

const ADDRESS = `0x${'a'.repeat(40)}`;

function state(onboarded: boolean, version = 1): OnboardingState {
  return { address: ADDRESS, onboarded, version };
}

function renderControl(client: Partial<ApiClient>, address = ADDRESS): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>
        <KycOnboardingControl address={address} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe('KycOnboardingControl (Story 9.2)', () => {
  it('renders the live onboarding state (not onboarded ⇒ default-denied)', async () => {
    renderControl({ getOnboardingState: vi.fn().mockResolvedValue(state(false)) });
    expect(await screen.findByText('Not onboarded')).toBeInTheDocument();
    expect(screen.getByText(/Default-denied/)).toBeInTheDocument();
  });

  it('calls setOnboarding(onboard) and reflects the new onboarded state', async () => {
    const setOnboarding = vi.fn().mockResolvedValue(state(true, 2));
    const getOnboardingState = vi
      .fn()
      .mockResolvedValueOnce(state(false))
      .mockResolvedValue(state(true, 2));
    renderControl({ getOnboardingState, setOnboarding });

    const onboardBtn = await screen.findByRole('button', { name: 'Onboard' });
    await userEvent.click(onboardBtn);

    await waitFor(() =>
      expect(setOnboarding).toHaveBeenCalledWith({ address: ADDRESS, action: 'onboard' }),
    );
    expect(await screen.findByText('Onboarded')).toBeInTheDocument();
  });

  it('degrades to an honest "faithful mode only" note on a 503', async () => {
    const getOnboardingState = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError('FAITHFUL_ONBOARDING_UNAVAILABLE', 'not faithful', 503),
      );
    renderControl({ getOnboardingState });
    expect(await screen.findByText(/faithful/)).toBeInTheDocument();
  });

  it('renders nothing when no address is wired (no identity to gate)', () => {
    const { container } = renderControl({ getOnboardingState: vi.fn() }, '');
    expect(container).toBeEmptyDOMElement();
  });
});
