// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../../lib/api-client.js';
import { ApiClientProvider } from '../../lib/queries.js';
import {
  activePair,
  divergentGroupView,
  emptyGroupView,
  reconciledGroupView,
} from '../../test/fixtures.js';
import { CovenantConsole, CovenantConsoleView } from './covenant-console.js';

const NOW = new Date('2026-06-16T12:00:01Z').getTime();

function Providers({
  client,
  children,
}: {
  client: Partial<ApiClient>;
  children: ReactNode;
}): React.JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ApiClientProvider value={client as ApiClient}>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('CovenantConsoleView (presentational)', () => {
  it('renders the live Group NAV hero and per-entity balances from the group view', () => {
    render(<CovenantConsoleView view={reconciledGroupView()} now={NOW} />);
    expect(screen.getByText('Group NAV')).toBeInTheDocument();
    expect(screen.getAllByLabelText('12480330.00 EUR (scale 2)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('VCC').length).toBeGreaterThan(0);
    expect(screen.getByText('tco-fee-income')).toBeInTheDocument();
  });

  it('derives a KPI in the dominant asset only — never adding unlike units across assets', () => {
    // BACKING_FLOAT exists in EUR (12480330.00) and USD (777.00); the Backing-float KPI must show
    // the dominant (first-match) asset's figure, NOT a meaningless cross-asset sum.
    const view = reconciledGroupView();
    const usd = { asset: 'USD', scale: 2, smallestUnits: '77700', decimal: '777.00' };
    view.entities[0]!.accounts.push({
      accountId: 'vcc-backing-float-usd',
      type: 'BACKING_FLOAT',
      asset: 'USD',
      scale: 2,
      navRole: 'ASSET',
      normalSide: 'DEBIT',
      totalDebit: usd,
      totalCredit: { asset: 'USD', scale: 2, smallestUnits: '0', decimal: '0.00' },
      net: usd,
    });
    render(<CovenantConsoleView view={view} now={NOW} />);
    // The KPI card shows the EUR figure (12480330.00), never 12481107.00 (EUR+USD mixed).
    expect(screen.getAllByLabelText('12480330.00 EUR (scale 2)').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('12481107.00 EUR (scale 2)')).toBeNull();
  });

  it('renders the covenant monitor, coupled-coin book, and cross-entity reconciliation', () => {
    render(<CovenantConsoleView view={reconciledGroupView()} now={NOW} />);
    // Covenant monitor — bright lines, each with a label + PASS/WATCH/BREACH status (color+glyph).
    expect(screen.getByText('Covenant monitor — the bright lines')).toBeInTheDocument();
    expect(screen.getByText('Backing-float floor')).toBeInTheDocument();
    expect(screen.getByText('Deploy ratio (ceiling)')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Status: Pass').length).toBeGreaterThan(0);
    // Net directional exposure + coupled-coin book by market.
    expect(screen.getByText('Net directional exposure')).toBeInTheDocument();
    expect(screen.getByText('Coupled-coin book')).toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    // Cross-entity reconciliation — role + status.
    expect(screen.getByText('Cross-entity reconciliation')).toBeInTheDocument();
    expect(screen.getByText('Treasury / Note issuer')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Reconciliation: Reconciled').length).toBeGreaterThan(0);
  });

  it('renders net directional exposure per market (units), never a cross-market sum', () => {
    render(<CovenantConsoleView view={reconciledGroupView()} now={NOW} />);
    expect(screen.getByText('BTC · net')).toBeInTheDocument();
  });

  it('shows an explicit covenant empty-state when no thresholds are configured', () => {
    render(<CovenantConsoleView view={{ ...reconciledGroupView(), covenants: [] }} now={NOW} />);
    expect(screen.getByText(/Covenant thresholds not configured/)).toBeInTheDocument();
  });

  it('shows the divergence banner when reconcile reports a mismatch, hidden otherwise', () => {
    const { rerender } = render(<CovenantConsoleView view={reconciledGroupView()} now={NOW} />);
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<CovenantConsoleView view={divergentGroupView()} now={NOW} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ledger ↔ chain divergence detected on ROSE-L',
    );
  });

  it('shows the empty state when there are no balances', () => {
    render(<CovenantConsoleView view={emptyGroupView()} now={NOW} />);
    expect(screen.getByText('No balances yet.')).toBeInTheDocument();
  });

  it('drills an account row to its postings with a copy-tx-hash affordance', async () => {
    render(<CovenantConsoleView view={reconciledGroupView()} now={NOW} />);
    await userEvent.click(screen.getByTestId('row-VCC:vcc-backing-float'));
    const drill = screen.getByTestId('drill-VCC:vcc-backing-float');
    expect(drill).toHaveTextContent('Total debit');
    expect(drill).toHaveTextContent('Total credit');
    expect(drill).toHaveTextContent('No on-chain tx');
  });
});

describe('CovenantConsole (container states)', () => {
  it('surfaces an API error with its machine code + retry (never a blank surface)', async () => {
    const client: Partial<ApiClient> = {
      getGroupView: vi.fn(async () => {
        throw new ApiClientError('AUTHORIZATION_DENIED', 'Refused.', 403);
      }),
      getCoupledPair: vi.fn(async () => activePair()),
    };
    render(
      <Providers client={client}>
        <CovenantConsole />
      </Providers>,
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('AUTHORIZATION_DENIED'),
    );
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders live data fetched through the injected client', async () => {
    const client: Partial<ApiClient> = {
      getGroupView: vi.fn(async () => reconciledGroupView()),
      getCoupledPair: vi.fn(async () => activePair()),
    };
    render(
      <Providers client={client}>
        <CovenantConsole />
      </Providers>,
    );
    await waitFor(() => {
      expect(screen.getAllByLabelText('12480330.00 EUR (scale 2)').length).toBeGreaterThan(0);
    });
  });
});
