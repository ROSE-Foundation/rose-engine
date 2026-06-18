import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ThemeProvider } from './components/theme-provider.js';
import { ThemeToggle } from './components/theme-toggle.js';
import { Button } from './components/ui/button.js';
import { createApiClient, resolveApiBaseUrl } from './lib/api-client.js';
import { ApiClientProvider, useGroupView } from './lib/queries.js';
import { CoupledPairSurface } from './surfaces/coupled-pair/coupled-pair.js';
import { CovenantConsole } from './surfaces/covenant-console/covenant-console.js';
import { ExchangeTrading } from './surfaces/exchange-trading/exchange-trading.js';
import { SubscriberSurface } from './surfaces/subscriber/subscriber.js';

type Surface = 'covenant-console' | 'coupled-pair' | 'exchange-trading' | 'subscriber';

const SURFACE_LABELS: Record<Surface, string> = {
  'covenant-console': 'Covenant Console',
  'coupled-pair': 'Coupled-Pair',
  'exchange-trading': 'Exchange / Trading',
  subscriber: 'Subscriber',
};

const queryClient = new QueryClient();
const apiClient = createApiClient({ baseUrl: resolveApiBaseUrl() });

// The Subscriber identity (paper/local): an env-driven address with an empty default — NO secret,
// NO baked-in placeholder. The deployed source is the session's allowlisted ONCHAINID claim
// (ops-deferred, see deferred-work.md story-6.6).
function resolveSubscriberAddress(): string {
  return import.meta.env.VITE_SUBSCRIBER_ADDRESS ?? '';
}

/** Resolves the first live pair from the group view so the Coupled-Pair surface has a target. */
function CoupledPairPanel(): React.JSX.Element {
  const query = useGroupView();
  const pairId = query.data?.coupledPairs[0]?.id;
  if (!pairId) return <p className="text-muted-foreground">No active pairs.</p>;
  return <CoupledPairSurface pairId={pairId} />;
}

/** Resolves the Subscriber's held note ids from the live group view (paper/local composition). */
function SubscriberPanel(): React.JSX.Element {
  const query = useGroupView();
  const noteIds = (query.data?.coupledPairs ?? [])
    .map((p) => p.noteId)
    .filter((id): id is string => id !== null);
  return (
    <SubscriberSurface
      eligibility={{ eligible: true }}
      subscriberAddress={resolveSubscriberAddress()}
      noteIds={noteIds}
    />
  );
}

function Shell(): React.JSX.Element {
  const [surface, setSurface] = useState<Surface>('covenant-console');
  const operatorSurfaces: Surface[] = ['covenant-console', 'coupled-pair', 'exchange-trading'];

  return (
    <div className="flex min-h-screen">
      <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-border p-4">
        <span className="mb-4 font-display text-lg font-semibold text-foreground">ROSE Engine</span>
        <span className="px-1 text-xs uppercase tracking-wide text-muted-foreground">Operator</span>
        {operatorSurfaces.map((s) => (
          <Button
            key={s}
            variant={surface === s ? 'primary' : 'ghost'}
            onClick={() => setSurface(s)}
          >
            {SURFACE_LABELS[s]}
          </Button>
        ))}
        <span className="mt-4 px-1 text-xs uppercase tracking-wide text-muted-foreground">
          Subscriber
        </span>
        <Button
          variant={surface === 'subscriber' ? 'primary' : 'ghost'}
          onClick={() => setSurface('subscriber')}
        >
          {SURFACE_LABELS.subscriber}
        </Button>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-3">
          <span className="font-display text-base font-semibold">{SURFACE_LABELS[surface]}</span>
          <ThemeToggle />
        </header>
        <main className="flex-1 p-6">
          {surface === 'covenant-console' && <CovenantConsole />}
          {surface === 'coupled-pair' && <CoupledPairPanel />}
          {surface === 'exchange-trading' && <ExchangeTrading />}
          {surface === 'subscriber' && <SubscriberPanel />}
        </main>
      </div>
    </div>
  );
}

/**
 * The ROSE Engine app (FR-14): the operator surfaces (Covenant Console, Coupled-Pair,
 * Exchange/Trading) plus the responsive Subscriber surfaces — all on live `@rose/api` data.
 */
export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider value={apiClient}>
          <Shell />
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
