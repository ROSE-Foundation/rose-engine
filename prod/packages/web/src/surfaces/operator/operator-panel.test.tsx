// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Shell } from '../../app.js';
import { ThemeProvider } from '../../components/theme-provider.js';
import { type ApiClient } from '../../lib/api-client.js';
import type {
  FaithfulConfirmationSettingsUpdate,
  OperatorInjectionUpdate,
} from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import { DEMO_IDENTITIES, SessionProvider, type Identity } from '../../lib/session.js';
import {
  confirmationSettings,
  confirmationSettingsRangeError,
  engineMode,
  operatorConfirmationUnavailableError,
  operatorCovenantUnavailableError,
  operatorInjectionState,
  operatorReconcileUnavailableError,
  positionsResponse,
  okPosition,
  tradingGroupView,
} from '../../test/fixtures.js';
import { OperatorPanel } from './operator-panel.js';

const ALICE = DEMO_IDENTITIES[0]!;
const OLIVIA = DEMO_IDENTITIES.find((i) => i.role === 'operator')!;

function wrap(client: Partial<ApiClient>, ui: ReactNode): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>{ui}</ApiClientProvider>
    </QueryClientProvider>
  );
}

/** A faithful-mode client whose three operator GETs resolve from fixtures. */
function faithfulClient(overrides: Partial<ApiClient> = {}): Partial<ApiClient> {
  return {
    getConfirmationSettings: () => Promise.resolve(confirmationSettings()),
    getCovenantBreach: () => Promise.resolve(operatorInjectionState(false)),
    getReconcileDivergence: () => Promise.resolve(operatorInjectionState(false)),
    ...overrides,
  };
}

describe('OperatorPanel — three faithful-mode injection controls (Story 9.5)', () => {
  it('renders the three controls from the fixtures', async () => {
    render(wrap(faithfulClient(), <OperatorPanel />));

    // Confirmation control: the latency input carries the current value.
    const latency = await screen.findByLabelText<HTMLInputElement>('Confirmation latency');
    expect(latency.value).toBe('2000');
    // The two arm/clear toggles render in their cleared state.
    expect(screen.getByRole('button', { name: /force covenant breach/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /arm reconcile divergence/i })).toBeInTheDocument();
  });

  it('editing latency + Apply calls PUT /operator/confirmation with the patch', async () => {
    const updateConfirmationSettings = vi.fn<
      (
        patch: FaithfulConfirmationSettingsUpdate,
      ) => Promise<ReturnType<typeof confirmationSettings>>
    >(() => Promise.resolve(confirmationSettings({ latencyMs: 5000, version: 1 })));
    render(wrap(faithfulClient({ updateConfirmationSettings }), <OperatorPanel />));

    const latency = await screen.findByLabelText<HTMLInputElement>('Confirmation latency');
    await userEvent.clear(latency);
    await userEvent.type(latency, '5000');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(updateConfirmationSettings).toHaveBeenCalledTimes(1);
    expect(updateConfirmationSettings.mock.calls[0]![0]).toMatchObject({ latencyMs: 5000 });
    expect(await screen.findByText(/applied — version 1/i)).toBeInTheDocument();
  });

  it('Force covenant breach calls PUT /operator/covenant-breach {active:true}', async () => {
    const setCovenantBreach = vi.fn<
      (b: OperatorInjectionUpdate) => Promise<ReturnType<typeof operatorInjectionState>>
    >(() => Promise.resolve(operatorInjectionState(true)));
    render(wrap(faithfulClient({ setCovenantBreach }), <OperatorPanel />));

    await userEvent.click(await screen.findByRole('button', { name: /force covenant breach/i }));
    expect(setCovenantBreach).toHaveBeenCalledWith({ active: true });
  });

  it('Arm reconcile divergence calls PUT /operator/reconcile-divergence {active:true}', async () => {
    const setReconcileDivergence = vi.fn<
      (b: OperatorInjectionUpdate) => Promise<ReturnType<typeof operatorInjectionState>>
    >(() => Promise.resolve(operatorInjectionState(true)));
    render(wrap(faithfulClient({ setReconcileDivergence }), <OperatorPanel />));

    await userEvent.click(await screen.findByRole('button', { name: /arm reconcile divergence/i }));
    expect(setReconcileDivergence).toHaveBeenCalledWith({ active: true });
  });

  it('an ACTIVE injection renders the Clear control + an ACTIVE status', async () => {
    render(
      wrap(
        faithfulClient({ getCovenantBreach: () => Promise.resolve(operatorInjectionState(true)) }),
        <OperatorPanel />,
      ),
    );
    expect(
      await screen.findByRole('button', { name: /clear covenant breach/i }),
    ).toBeInTheDocument();
    // The status label reads ACTIVE for the armed covenant injection.
    expect(screen.getAllByText('ACTIVE').length).toBeGreaterThan(0);
  });

  it('renders the clean "not available" state when each GET returns a typed 503 (non-faithful)', async () => {
    render(
      wrap(
        {
          getConfirmationSettings: () => Promise.reject(operatorConfirmationUnavailableError()),
          getCovenantBreach: () => Promise.reject(operatorCovenantUnavailableError()),
          getReconcileDivergence: () => Promise.reject(operatorReconcileUnavailableError()),
        },
        <OperatorPanel />,
      ),
    );

    // One note per gated control — all naming faithful mode + their machine code.
    await waitFor(() => {
      expect(screen.getByText(/OPERATOR_CONFIRMATION_UNAVAILABLE/)).toBeInTheDocument();
    });
    expect(screen.getByText(/OPERATOR_COVENANT_UNAVAILABLE/)).toBeInTheDocument();
    expect(screen.getByText(/OPERATOR_RECONCILE_UNAVAILABLE/)).toBeInTheDocument();
    // No editable Apply / toggle controls when unavailable.
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /force covenant breach/i }),
    ).not.toBeInTheDocument();
  });

  it('surfaces the typed 400 message when a confirmation PUT is refused (out-of-range)', async () => {
    const updateConfirmationSettings = vi.fn(() =>
      Promise.reject(confirmationSettingsRangeError()),
    );
    render(wrap(faithfulClient({ updateConfirmationSettings }), <OperatorPanel />));

    await screen.findByLabelText('Confirmation latency');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/failureRate must be within/i);
    expect(alert).toHaveTextContent(/FaithfulConfirmationSettingsError/);
  });
});

describe('OperatorPanel — operator-role gating in the Shell (Story 9.3)', () => {
  function renderShell(client: Partial<ApiClient>, initialIdentity?: Identity | null): void {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider value={client as ApiClient}>
            <SessionProvider initialIdentity={initialIdentity}>
              <Shell />
            </SessionProvider>
          </ApiClientProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  function shellClient(): Partial<ApiClient> {
    return {
      getEngineMode: () => Promise.resolve(engineMode()),
      getGroupView: () => Promise.resolve(tradingGroupView()),
      getPositions: () => Promise.resolve(positionsResponse([okPosition()])),
      getOnboardingState: (address: string) =>
        Promise.resolve({ address, onboarded: true, version: 1 }),
      ...faithfulClient(),
    };
  }

  it('an operator sees the Operator nav tab and can open the panel', async () => {
    renderShell(shellClient(), OLIVIA);
    const tab = screen.getByRole('button', { name: 'Operator' });
    expect(tab).toBeInTheDocument();
    await userEvent.click(tab);
    expect(
      await screen.findByRole('heading', { name: /production-like events/i }),
    ).toBeInTheDocument();
  });

  it('a subscriber never sees the Operator nav tab', () => {
    renderShell(shellClient(), ALICE);
    expect(screen.queryByRole('button', { name: 'Operator' })).not.toBeInTheDocument();
  });
});
