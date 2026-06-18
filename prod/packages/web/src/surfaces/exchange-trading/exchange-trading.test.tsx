// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../../lib/api-client.js';
import type { GroupViewResponse } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import { emptyGroupView, tradingGroupView, tradingLossGroupView } from '../../test/fixtures.js';
import { ExchangeTrading, ExchangeTradingView } from './exchange-trading.js';

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
    render(<ExchangeTradingView view={tradingGroupView()} />);
    // Positions (DEPLOYED_CAPITAL) and realized P&L (FEE_INCOME) render with unit/scale.
    expect(screen.getByText('5000.00')).toBeInTheDocument();
    // 1250.00 (P&L) appears in both the KPI card and the by-entity table.
    expect(screen.getAllByText('1250.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('TRADING_CO').length).toBeGreaterThan(0);
    // The P&L delta carries a glyph + sign (meaning not on color alone).
    expect(screen.getByText(/▴/)).toBeInTheDocument();
    // The open pair's lifecycle badge label is shown.
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows the empty state when there is no trading activity', () => {
    render(<ExchangeTradingView view={emptyGroupView()} />);
    expect(screen.getByText(/no trading activity yet/i)).toBeInTheDocument();
  });

  it('renders a negative P&L with a single down sign (the delta owns the sign, no double sign)', () => {
    render(<ExchangeTradingView view={tradingLossGroupView()} />);
    // The KPI delta shows ▾ −300.00 — never ▾ −-300.00 (the label is the unsigned magnitude).
    expect(screen.getByLabelText('down 300.00')).toBeInTheDocument();
    expect(screen.queryByText(/−-/)).not.toBeInTheDocument();
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
    render(<ExchangeTradingView view={tradingGroupView()} />);
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
    render(<ExchangeTradingView view={tradingGroupView()} />);
    expect(screen.getAllByText(/Price feed not connected/i).length).toBeGreaterThan(0);
    // The price-feed empty-state marker appears (positions Mark/P&L + 24h stats).
    expect(screen.getAllByText(/\(price feed\)/i).length).toBeGreaterThan(0);
  });

  it('scopes the center + positions to the selected market', () => {
    render(<ExchangeTradingView view={twoMarketView()} />);
    // Default: first market (BTC) is the chart-head heading.
    expect(screen.getByRole('heading', { name: 'BTC' })).toBeInTheDocument();
    // Select ETH/USD from the market list.
    fireEvent.click(screen.getByRole('button', { name: /ETH\/USD/ }));
    expect(screen.getByRole('heading', { name: 'ETH/USD' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'BTC' })).not.toBeInTheDocument();
  });

  it('order-ticket CTA navigates to the Subscriber surface (no fake write)', () => {
    const onNavigate = vi.fn();
    render(<ExchangeTradingView view={tradingGroupView()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Subscriber surface/i }));
    expect(onNavigate).toHaveBeenCalledWith('subscriber');
  });

  it('preserves the live per-entity execution + P&L (not lost in the rebuild)', () => {
    render(<ExchangeTradingView view={tradingGroupView()} />);
    expect(screen.getByText('5000.00')).toBeInTheDocument(); // DEPLOYED_CAPITAL
    expect(screen.getAllByText('1250.00').length).toBeGreaterThanOrEqual(2); // P&L KPI + table
    expect(screen.getByText(/▴/)).toBeInTheDocument();
  });
});
