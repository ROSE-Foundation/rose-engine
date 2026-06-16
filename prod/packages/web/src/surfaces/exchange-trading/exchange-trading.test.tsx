// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClientError, type ApiClient } from '../../lib/api-client.js';
import { ApiClientProvider } from '../../lib/queries.js';
import { emptyGroupView, tradingGroupView, tradingLossGroupView } from '../../test/fixtures.js';
import { ExchangeTrading, ExchangeTradingView } from './exchange-trading.js';

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
