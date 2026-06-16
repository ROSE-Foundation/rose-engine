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
    // FEE_INCOME exists in EUR (500.00) and USD (999.00); the Float yield KPI must show the
    // dominant (first-match) asset's figure, NOT a meaningless cross-asset sum.
    const view = reconciledGroupView();
    const usd = { asset: 'USD', scale: 2, smallestUnits: '99900', decimal: '999.00' };
    view.entities[1]!.accounts.push({
      accountId: 'tco-fee-income-usd',
      type: 'FEE_INCOME',
      asset: 'USD',
      scale: 2,
      navRole: 'EQUITY',
      normalSide: 'CREDIT',
      totalDebit: { asset: 'USD', scale: 2, smallestUnits: '0', decimal: '0.00' },
      totalCredit: usd,
      net: usd,
    });
    render(<CovenantConsoleView view={view} now={NOW} />);
    // The KPI card shows the EUR figure (500.00), not 1499.00 (EUR+USD mixed).
    expect(screen.getAllByLabelText('500.00 EUR (scale 2)').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('1499.00 EUR (scale 2)')).toBeNull();
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
