// @vitest-environment jsdom
import '../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClientError, type ApiClient } from '../lib/api-client.js';
import { ApiClientProvider } from '../lib/queries.js';
import { engineMode } from '../test/fixtures.js';
import { ModeBanner } from './mode-banner.js';

function wrap(client: Partial<ApiClient>): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>
        <ModeBanner />
      </ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('ModeBanner (Story 9.6, FR-33)', () => {
  it('renders the production-faithful text + the mocked list when the endpoint reports faithful', async () => {
    render(wrap({ getEngineMode: () => Promise.resolve(engineMode()) }));

    expect(await screen.findByText('Production-faithful demo')).toBeInTheDocument();
    // The honest no-real-capital framing + at least one named mocked component is surfaced.
    const banner = screen.getByRole('status', { name: 'Engine mode' });
    expect(banner).toHaveTextContent(/NO real capital/i);
    expect(banner).toHaveTextContent(/Mocked:/i);
    expect(banner).toHaveTextContent(/KYC\/AML claim issuer/i);
  });

  it('renders the paper-simulation text when the endpoint reports paper', async () => {
    render(
      wrap({
        getEngineMode: () =>
          Promise.resolve(
            engineMode({
              engineMode: 'paper',
              real: ['Double-entry ledger + per-(asset, scale) balance invariant'],
              mocked: [
                'Instant in-process on-chain confirmation (auto-confirm — no latency, no failure)',
              ],
            }),
          ),
      }),
    );

    expect(await screen.findByText('Paper simulation')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Engine mode' })).toHaveTextContent(/no real funds/i);
  });

  it('renders the read-only note (no mocked list) when the endpoint reports read-only', async () => {
    render(
      wrap({
        getEngineMode: () =>
          Promise.resolve(
            engineMode({ engineMode: 'read-only', real: ['ledger reads'], mocked: [] }),
          ),
      }),
    );

    expect(await screen.findByText('Read-only deployment')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Engine mode' })).not.toHaveTextContent(/Mocked:/i);
  });

  it('degrades gracefully to an honest fallback bar when the endpoint is unreachable (always present)', async () => {
    render(
      wrap({
        getEngineMode: () =>
          Promise.reject(new ApiClientError('REQUEST_FAILED', 'Request failed (500).', 500)),
      }),
    );

    // The banner is ALWAYS present — even on a rejected /mode, it renders the safe honest fallback.
    const banner = await screen.findByRole('status', { name: 'Engine mode' });
    expect(banner).toHaveTextContent(/Demo environment/i);
    expect(banner).toHaveTextContent(/NO real capital/i);
    // Once the query settles to its error state, the fallback names the endpoint as unavailable.
    await waitFor(() => expect(banner).toHaveTextContent(/engine mode unavailable/i));
  });
});
