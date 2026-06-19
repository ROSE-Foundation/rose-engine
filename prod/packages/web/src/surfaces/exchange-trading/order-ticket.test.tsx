// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../../lib/api-client.js';
import type { CoupledPairPosition, SubscribeRequest } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import { confirmedSubscription, pendingSubscription } from '../../test/fixtures.js';
import { OrderTicket } from './order-ticket.js';

const ADDRESS = `0x${'a'.repeat(40)}`;

function pair(noteId: string | null = 'note-1'): CoupledPairPosition {
  return {
    id: 'pair-1',
    referenceAsset: 'BTC',
    state: 'ACTIVE',
    anchorPrice: '60000.00',
    leverage: '1',
    floor: '0.6',
    longLegValue: '10000',
    shortLegValue: '10000',
    collateralPool: '20000',
    noteId,
  };
}

function wrap(client: Partial<ApiClient>, ui: ReactNode): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>{ui}</ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('OrderTicket — disabled-1x leverage + Review→Confirm open/close (Story 8.4, AC-3)', () => {
  it('renders a DISABLED, fixed-1x leverage selector in P0', () => {
    render(wrap({}, <OrderTicket pair={pair()} owner={ADDRESS} />));
    const selector = screen.getByRole('combobox', { name: /position leverage/i });
    expect(selector).toBeDisabled();
    expect(screen.getByText(/1× \(fixed\)/i)).toBeInTheDocument();
  });

  it('Open stays pending (no optimistic success) while the status endpoint is still pending', async () => {
    // The status endpoint never flips to confirmed ⇒ the panel must NOT show success.
    const getSubscription = vi.fn(() => Promise.resolve(pendingSubscription()));
    const subscribe = vi.fn<
      (
        roseNoteId: string,
        body: SubscribeRequest,
      ) => Promise<ReturnType<typeof pendingSubscription>>
    >(() => Promise.resolve(pendingSubscription()));
    const client: Partial<ApiClient> = { subscribe, getSubscription };
    render(wrap(client, <OrderTicket pair={pair()} owner={ADDRESS} />));

    await userEvent.click(screen.getByRole('button', { name: /open position/i }));
    // Review states the on-chain consequence (a paired mint).
    expect(screen.getByText(/paired .* mint/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));
    expect(await screen.findByText(/awaiting sepolia confirmation/i)).toBeInTheDocument();
    // No optimistic success: confirmed text never appears while the poll says pending.
    expect(screen.queryByText(/subscription confirmed/i)).not.toBeInTheDocument();
    expect(subscribe).toHaveBeenCalledTimes(1);
    // The amount crossed the wire as a smallest-units STRING (NFR-2), never a number.
    expect(typeof subscribe.mock.calls[0]![1].amount).toBe('string');
  });

  it('shows success only once the polled status returns confirmed (the commit point)', async () => {
    const getSubscription = vi.fn(() => Promise.resolve(confirmedSubscription()));
    const subscribe = vi.fn<
      (
        roseNoteId: string,
        body: SubscribeRequest,
      ) => Promise<ReturnType<typeof pendingSubscription>>
    >(() => Promise.resolve(pendingSubscription()));
    const client: Partial<ApiClient> = { subscribe, getSubscription };
    render(wrap(client, <OrderTicket pair={pair()} owner={ADDRESS} />));

    await userEvent.click(screen.getByRole('button', { name: /open position/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));
    expect(await screen.findByText(/subscription confirmed/i)).toBeInTheDocument();
  });

  it('falls back to the Subscriber-surface link when the market has no Rose Note', () => {
    const onNavigate = vi.fn();
    render(wrap({}, <OrderTicket pair={pair(null)} owner={ADDRESS} onNavigate={onNavigate} />));
    expect(screen.queryByRole('button', { name: /open position/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /subscriber surface/i })).toBeInTheDocument();
  });
});
