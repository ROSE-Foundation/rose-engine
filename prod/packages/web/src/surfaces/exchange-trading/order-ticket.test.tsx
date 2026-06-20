// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../../lib/api-client.js';
import type { CoupledPairPosition, OpenPositionRequest } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import { confirmedOpenPosition, pendingOpenPosition } from '../../test/fixtures.js';
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

describe('OrderTicket — position open via Review→Confirm + disabled-1x leverage (Story 8.3)', () => {
  it('renders a DISABLED, fixed-1x leverage selector in P0', () => {
    render(wrap({}, <OrderTicket pair={pair()} owner={ADDRESS} />));
    const selector = screen.getByRole('combobox', { name: /position leverage/i });
    expect(selector).toBeDisabled();
    expect(screen.getByText(/1× \(fixed\)/i)).toBeInTheDocument();
  });

  it('Open fires POST /positions/open with the right body and stays pending until confirmed', async () => {
    // The flow status never flips to confirmed ⇒ the panel must NOT show optimistic success.
    const getOpenPositionFlow = vi.fn(() => Promise.resolve(pendingOpenPosition()));
    const openPosition = vi.fn<
      (body: OpenPositionRequest) => Promise<ReturnType<typeof pendingOpenPosition>>
    >(() => Promise.resolve(pendingOpenPosition()));
    const client: Partial<ApiClient> = { openPosition, getOpenPositionFlow };
    render(wrap(client, <OrderTicket pair={pair()} owner={ADDRESS} />));

    await userEvent.click(screen.getByRole('button', { name: /open position/i }));
    // Review states the on-chain consequence (a paired mint).
    expect(screen.getByText(/paired .* mint/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));
    expect(await screen.findByText(/awaiting sepolia confirmation/i)).toBeInTheDocument();
    // No optimistic success: confirmed text never appears while the poll says pending.
    expect(screen.queryByText(/subscription confirmed/i)).not.toBeInTheDocument();

    expect(openPosition).toHaveBeenCalledTimes(1);
    const body = openPosition.mock.calls[0]![0];
    expect(body.coupledPairId).toBe('pair-1');
    expect(body.owner).toBe(ADDRESS);
    expect(body.side).toBe('LONG');
    expect(body.paymentAsset).toBe('EUR');
    // NFR-2: the amount crosses the wire as a smallest-units STRING, never a number.
    expect(typeof body.amount).toBe('string');
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('opens the SHORT side when the direction selector is set to Short', async () => {
    const getOpenPositionFlow = vi.fn(() => Promise.resolve(pendingOpenPosition()));
    const openPosition = vi.fn<
      (body: OpenPositionRequest) => Promise<ReturnType<typeof pendingOpenPosition>>
    >(() => Promise.resolve(pendingOpenPosition()));
    const client: Partial<ApiClient> = { openPosition, getOpenPositionFlow };
    render(wrap(client, <OrderTicket pair={pair()} owner={ADDRESS} />));

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /position side/i }),
      'SHORT',
    );
    await userEvent.click(screen.getByRole('button', { name: /open position/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));
    expect(openPosition.mock.calls[0]![0].side).toBe('SHORT');
  });

  it('shows success only once the polled flow returns confirmed (the commit point)', async () => {
    const getOpenPositionFlow = vi.fn(() => Promise.resolve(confirmedOpenPosition()));
    const openPosition = vi.fn<
      (body: OpenPositionRequest) => Promise<ReturnType<typeof pendingOpenPosition>>
    >(() => Promise.resolve(pendingOpenPosition()));
    const client: Partial<ApiClient> = { openPosition, getOpenPositionFlow };
    render(wrap(client, <OrderTicket pair={pair()} owner={ADDRESS} />));

    await userEvent.click(screen.getByRole('button', { name: /open position/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));
    expect(await screen.findByText(/subscription confirmed/i)).toBeInTheDocument();
  });

  it('falls back to the Subscriber-surface link when there is no owner (cannot open a position)', () => {
    const onNavigate = vi.fn();
    render(wrap({}, <OrderTicket pair={pair()} onNavigate={onNavigate} />));
    expect(screen.queryByRole('button', { name: /open position/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /subscriber surface/i })).toBeInTheDocument();
  });
});
