// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../../lib/api-client.js';
import type { GroupViewResponse } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import {
  confirmedClosePosition,
  emptyGroupView,
  noFeedPosition,
  okPosition,
  pendingClosePosition,
  positionServiceUnavailableError,
  positionsResponse,
  reconciliationReport,
  solvencyGuardrailError,
  stalePosition,
  tradingGroupView,
  tradingLossGroupView,
} from '../../test/fixtures.js';
import { ExchangeTrading, ExchangeTradingView } from './exchange-trading.js';

const ADDRESS = `0x${'a'.repeat(40)}`;

/**
 * `ExchangeTradingView` now hosts the operator reconciliation panel + per-row close flow, so it uses
 * the api-client/react-query hooks — its renders need a QueryClient + an `ApiClientProvider`. This
 * wraps a presentational render with both (an empty client suffices when no write is exercised).
 */
function renderView(ui: ReactNode, client: Partial<ApiClient> = {}): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>{ui}</ApiClientProvider>
    </QueryClientProvider>,
  );
}

/** A two-market trading view (adds an ETH/USD market + pair) to exercise market selection. */
function twoMarketView(): GroupViewResponse {
  const base = tradingGroupView();
  const ethPair = {
    ...base.coupledPairs[0]!,
    id: 'pair-eth',
    referenceAsset: 'ETH/USD',
    noteId: null,
  };
  return {
    ...base,
    coupledPairs: [...base.coupledPairs, ethPair],
    coupledCoinBook: [
      ...base.coupledCoinBook,
      {
        referenceAsset: 'ETH/USD',
        pairs: 1,
        longNotional: '5000',
        shortNotional: '5000',
        collateral: '10000',
        net: '0',
      },
    ],
  };
}

function withProviders(client: Partial<ApiClient>): (ui: ReactNode) => React.JSX.Element {
  return function Wrapper(ui: ReactNode): React.JSX.Element {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider value={client as ApiClient}>{ui}</ApiClientProvider>
      </QueryClientProvider>
    );
  };
}

describe('ExchangeTradingView (AC-1)', () => {
  it('renders live positions and P&L by entity with money cells + a signed delta (never color-only)', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} />);
    // Positions (DEPLOYED_CAPITAL) and realized P&L (FEE_INCOME) render with unit/scale.
    expect(screen.getByText('5000.00')).toBeInTheDocument();
    // 1250.00 (P&L) appears in both the KPI card and the by-entity table.
    expect(screen.getAllByText('1250.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('TRADING_CO').length).toBeGreaterThan(0);
    // The P&L delta carries a glyph + sign (meaning not on color alone).
    expect(screen.getByText(/▴/)).toBeInTheDocument();
  });

  it('shows the empty state when there is no trading activity', () => {
    renderView(<ExchangeTradingView view={emptyGroupView()} />);
    expect(screen.getByText(/no trading activity yet/i)).toBeInTheDocument();
  });

  it('renders a negative P&L with a single down sign (the delta owns the sign, no double sign)', () => {
    renderView(<ExchangeTradingView view={tradingLossGroupView()} />);
    // The KPI delta shows ▾ −300.00 — never ▾ −-300.00 (the label is the unsigned magnitude).
    expect(screen.getByLabelText('down 300.00')).toBeInTheDocument();
    expect(screen.queryByText(/−-/)).not.toBeInTheDocument();
  });
});

describe('Live positions + marks + P&L (Story 8.4, AC-2)', () => {
  it('renders the live mark price + directional P&L when the oracle is connected (OK)', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} positions={[okPosition()]} />);
    // The live mark price replaces the "price feed not connected" empty-state (chart-head + Mark cell).
    expect(screen.getAllByText('63000.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/live mark/i)).toBeInTheDocument();
    // The directional P&L renders as a signed glyph delta (never color-only).
    expect(screen.getByLabelText('up 1500')).toBeInTheDocument();
    expect(screen.queryByText(/price feed not connected/i)).not.toBeInTheDocument();
  });

  it('shows the documented "no price feed" state when the oracle is absent — never fabricated', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} positions={[noFeedPosition()]} />);
    // The position is listed, but its Mark/P&L are the honest no-feed gap (no number).
    expect(screen.getByText('LONG')).toBeInTheDocument();
    expect(screen.getAllByText(/no price feed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/price feed not connected/i)).toBeInTheDocument();
  });

  it('shows the stale-mark state (price surfaced, P&L untrusted) when the quote is stale', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} positions={[stalePosition()]} />);
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
    // The stale price is surfaced for transparency…
    expect(screen.getAllByText('63000.00').length).toBeGreaterThan(0);
    // …but never a trusted directional P&L (the position's P&L delta is absent).
    expect(screen.queryByLabelText('up 1500')).not.toBeInTheDocument();
  });

  it('renders the live positions from the injected client through the container', async () => {
    const client: Partial<ApiClient> = {
      getGroupView: () => Promise.resolve(tradingGroupView()),
      getPositions: () => Promise.resolve(positionsResponse([okPosition()])),
    };
    const wrap = withProviders(client);
    render(wrap(<ExchangeTrading owner={`0x${'a'.repeat(40)}`} />));
    expect((await screen.findAllByText('63000.00')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('ExchangeTrading container', () => {
  it('renders the error state with the machine code when the query rejects', async () => {
    const client: Partial<ApiClient> = {
      getGroupView: () => Promise.reject(new ApiClientError('REQUEST_FAILED', 'boom', 500)),
    };
    const wrap = withProviders(client);
    render(wrap(<ExchangeTrading />));
    expect(await screen.findByText(/REQUEST_FAILED/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders live trading data from the injected client', async () => {
    const client: Partial<ApiClient> = {
      getGroupView: () => Promise.resolve(tradingGroupView()),
    };
    const wrap = withProviders(client);
    render(wrap(<ExchangeTrading />));
    expect((await screen.findAllByText('1250.00')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('Exchange terminal (spec #5 — coupled-package model)', () => {
  it('renders the market list, derived leg-token symbols, and the real package-terms ticket', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} />);
    // Market list from the coupledCoinBook (buttons with aria-pressed, not a listbox).
    expect(screen.getByRole('button', { name: /BTC/ })).toBeInTheDocument();
    // Derived leg-token symbols (rBTC-L / rBTC-S) appear in the pair strip + the order ticket.
    expect(screen.getAllByText('rBTC-L').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rBTC-S').length).toBeGreaterThan(0);
    // The order ticket presents the atomic-package framing + real terms (leverage 3×), not a perp order.
    expect(screen.getByText('Acquire the coupled package')).toBeInTheDocument();
    expect(screen.getAllByText('3×').length).toBeGreaterThan(0); // stat strip + ticket
  });

  it('never fabricates price data — chart, live mark and P&L are explicit empty-states', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} />);
    expect(screen.getAllByText(/Price feed not connected/i).length).toBeGreaterThan(0);
    // The price-feed empty-state marker appears (positions Mark/P&L + 24h stats).
    expect(screen.getAllByText(/\(price feed\)/i).length).toBeGreaterThan(0);
  });

  it('scopes the center + positions to the selected market', () => {
    renderView(<ExchangeTradingView view={twoMarketView()} />);
    // Default: first market (BTC) is the chart-head heading.
    expect(screen.getByRole('heading', { name: 'BTC' })).toBeInTheDocument();
    // Select ETH/USD from the market list.
    fireEvent.click(screen.getByRole('button', { name: /ETH\/USD/ }));
    expect(screen.getByRole('heading', { name: 'ETH/USD' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'BTC' })).not.toBeInTheDocument();
  });

  it('order-ticket CTA navigates to the Subscriber surface (no fake write)', () => {
    const onNavigate = vi.fn();
    renderView(<ExchangeTradingView view={tradingGroupView()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Subscriber surface/i }));
    expect(onNavigate).toHaveBeenCalledWith('subscriber');
  });

  it('preserves the live per-entity execution + P&L (not lost in the rebuild)', () => {
    renderView(<ExchangeTradingView view={tradingGroupView()} />);
    expect(screen.getByText('5000.00')).toBeInTheDocument(); // DEPLOYED_CAPITAL
    expect(screen.getAllByText('1250.00').length).toBeGreaterThanOrEqual(2); // P&L KPI + table
    expect(screen.getByText(/▴/)).toBeInTheDocument();
  });
});

describe('Position close — §11.4 single-side solvency guardrail (Story 8.6, UX-DR5)', () => {
  it('renders the rule-NAMED §11.4 refusal (not a generic error) when close is refused with a 409', async () => {
    const closePosition = vi.fn(() => Promise.reject(solvencyGuardrailError()));
    const client: Partial<ApiClient> = { closePosition };
    renderView(
      <ExchangeTradingView view={tradingGroupView()} positions={[okPosition()]} owner={ADDRESS} />,
      client,
    );
    // The Close action is per position row; it hands the row's position id to the close flow.
    await userEvent.click(screen.getByRole('button', { name: /close .*BTC position/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm redemption/i }));
    // An explicit, rule-NAMED refusal: the machine code + the §11.4 guardrail message (not generic).
    expect(
      await screen.findByText(/SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED/),
    ).toBeInTheDocument();
    expect(screen.getByText(/§11\.4 solvency guardrail/i)).toBeInTheDocument();
    expect(closePosition).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: 'pos-1', paymentAsset: 'EUR' }),
    );
  });

  it('closes a position pending-until-confirmed (no optimistic success)', async () => {
    const closePosition = vi.fn(() => Promise.resolve(pendingClosePosition()));
    const getClosePositionFlow = vi.fn(() => Promise.resolve(confirmedClosePosition()));
    const client: Partial<ApiClient> = { closePosition, getClosePositionFlow };
    renderView(
      <ExchangeTradingView view={tradingGroupView()} positions={[okPosition()]} owner={ADDRESS} />,
      client,
    );
    await userEvent.click(screen.getByRole('button', { name: /close .*BTC position/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm redemption/i }));
    expect(await screen.findByText(/redemption confirmed/i)).toBeInTheDocument();
  });
});

describe('Operator reconciliation panel (Story 8.5, FR-27)', () => {
  it('runs reconcile and renders the per-(pair, side) backing/exposure rows from the report', async () => {
    const reconcilePositions = vi.fn(() => Promise.resolve(reconciliationReport()));
    const client: Partial<ApiClient> = { reconcilePositions };
    renderView(<ExchangeTradingView view={tradingGroupView()} />, client);
    await userEvent.click(screen.getByRole('button', { name: /run reconciliation/i }));
    // The over-exposed SHORT side row: backing 10000 vs exposure 12000, headroom −2000 (over-exposed).
    expect(await screen.findByText('12000')).toBeInTheDocument();
    expect(screen.getByText('-2000')).toBeInTheDocument();
    expect(screen.getAllByText(/over-exposed/i).length).toBeGreaterThan(0);
    expect(reconcilePositions).toHaveBeenCalledTimes(1);
  });

  it('degrades to a clean "not available on this deployment" state on a 503', async () => {
    const reconcilePositions = vi.fn(() => Promise.reject(positionServiceUnavailableError()));
    const client: Partial<ApiClient> = { reconcilePositions };
    renderView(<ExchangeTradingView view={tradingGroupView()} />, client);
    await userEvent.click(screen.getByRole('button', { name: /run reconciliation/i }));
    expect(await screen.findByText(/not available on this deployment/i)).toBeInTheDocument();
    expect(screen.getByText(/POSITION_SERVICE_UNAVAILABLE/)).toBeInTheDocument();
  });
});
