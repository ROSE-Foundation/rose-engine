// @vitest-environment jsdom
import './test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Shell } from './app.js';
import { ThemeProvider } from './components/theme-provider.js';
import type { ApiClient } from './lib/api-client.js';
import { ApiClientProvider } from './lib/queries.js';
import { DEMO_IDENTITIES, SessionProvider, type Identity } from './lib/session.js';
import { engineMode, okPosition, positionsResponse, tradingGroupView } from './test/fixtures.js';

const ALICE = DEMO_IDENTITIES[0]!;
const BOB = DEMO_IDENTITIES[1]!;
const OLIVIA = DEMO_IDENTITIES.find((i) => i.role === 'operator')!;

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

/** A trading client whose `getPositions` records each owner it is queried for. */
function tradingClient(): { client: Partial<ApiClient>; owners: string[] } {
  const owners: string[] = [];
  const client: Partial<ApiClient> = {
    getEngineMode: () => Promise.resolve(engineMode()),
    getGroupView: () => Promise.resolve(tradingGroupView()),
    getPositions: (owner: string) => {
      owners.push(owner);
      return Promise.resolve(positionsResponse([okPosition()]));
    },
    getOnboardingState: (address: string) =>
      Promise.resolve({ address, onboarded: true, version: 1 }),
  };
  return { client, owners };
}

describe('Shell — session identity wiring (Story 9.3, FR-30)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('signing in as A then switching to B changes the owner the terminal queries (no leakage)', async () => {
    const { client, owners } = tradingClient();
    renderShell(client);

    // Navigate to the Exchange terminal — signed out, it fails closed (no positions query yet).
    await userEvent.click(screen.getByRole('button', { name: 'Exchange' }));
    expect(owners).toHaveLength(0);

    // Sign in as Alice from the fail-closed gate → the terminal now queries Alice's positions.
    await userEvent.click(screen.getByRole('button', { name: /Sign in as Alice/ }));
    await waitFor(() => expect(owners).toContain(ALICE.address));

    // Switch to Bob via the header chip → the terminal re-queries with Bob's address.
    await userEvent.click(screen.getByRole('button', { name: /Signed in as Alice/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: new RegExp(BOB.label) }));
    await waitFor(() => expect(owners).toContain(BOB.address));

    // Each identity drove its OWN address — Alice's query never carried Bob's address and vice-versa.
    expect(owners.every((o) => o === ALICE.address || o === BOB.address)).toBe(true);
  });

  it('an operator sees the operator surfaces; a subscriber does not (role gate)', async () => {
    const { client } = tradingClient();

    // Operator: the Simulation nav tab is present, and the in-terminal operator tools render.
    renderShell(client, OLIVIA);
    expect(screen.getByRole('button', { name: 'Simulation' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Exchange' }));
    expect(await screen.findByRole('button', { name: /run reconciliation/i })).toBeInTheDocument();
  });

  it('a subscriber does NOT see the operator Simulation tab or the reconciliation tool', async () => {
    const { client } = tradingClient();
    renderShell(client, ALICE);
    expect(screen.queryByRole('button', { name: 'Simulation' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Exchange' }));
    await screen.findByRole('heading', { name: 'BTC' });
    expect(screen.queryByRole('button', { name: /run reconciliation/i })).not.toBeInTheDocument();
  });

  it('no session ⇒ a gated surface shows "sign in first" and never queries a default address', async () => {
    const getPositions = vi.fn();
    const openPosition = vi.fn();
    const client: Partial<ApiClient> = {
      getGroupView: () => Promise.resolve(tradingGroupView()),
      getPositions,
      openPosition,
    };
    renderShell(client);

    await userEvent.click(screen.getByRole('button', { name: 'Exchange' }));
    expect(screen.getByText(/Sign in first to use the Exchange terminal/i)).toBeInTheDocument();
    expect(getPositions).not.toHaveBeenCalled();
    expect(openPosition).not.toHaveBeenCalled();

    // The Subscriber surface is gated the same way.
    await userEvent.click(screen.getByRole('button', { name: 'Subscriber' }));
    expect(screen.getByText(/Sign in first to use the Subscriber surface/i)).toBeInTheDocument();
  });

  it('the current-identity chip is always visible with the signed-in label + address', () => {
    const { client } = tradingClient();
    renderShell(client, ALICE);
    expect(screen.getByText(`Signed in as ${ALICE.label}`)).toBeInTheDocument();
    expect(screen.getByText('(0xaaaa…aaaa)')).toBeInTheDocument();
  });
});
