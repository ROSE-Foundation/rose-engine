import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ThemeProvider } from './components/theme-provider.js';
import { ThemeToggle } from './components/theme-toggle.js';
import { Button } from './components/ui/button.js';
import { LogoMark } from './components/ui/logo-mark.js';
import { createApiClient, resolveApiBaseUrl } from './lib/api-client.js';
import { ApiClientProvider, useGroupView } from './lib/queries.js';
import { AlphaEngineSurface } from './surfaces/alpha-engine/alpha-engine.js';
import { CoupledPairSurface } from './surfaces/coupled-pair/coupled-pair.js';
import { CovenantConsole } from './surfaces/covenant-console/covenant-console.js';
import { ExchangeTrading } from './surfaces/exchange-trading/exchange-trading.js';
import { Home } from './surfaces/home/home.js';
import { SubscriberSurface } from './surfaces/subscriber/subscriber.js';

type Surface =
  | 'home'
  | 'covenant-console'
  | 'coupled-pair'
  | 'exchange-trading'
  | 'subscriber'
  | 'alpha-engine';

// Topnav surfaces (Home is reached via the logo mark, per the mocks). Labels follow index.html.
// `alpha-engine` is a THROWAWAY R&D PoC embedded as a static asset (see AlphaEngineSurface) — it
// adds no /prod→/throwaway code dependency.
const NAV_SURFACES: readonly Surface[] = [
  'exchange-trading',
  'covenant-console',
  'coupled-pair',
  'subscriber',
  'alpha-engine',
];

const SURFACE_LABELS: Record<Surface, string> = {
  home: 'Home',
  'covenant-console': 'Treasury Dashboard',
  'coupled-pair': 'Coupled Coins',
  'exchange-trading': 'Exchange',
  subscriber: 'Subscriber',
  'alpha-engine': 'Alpha Engine',
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
  const [surface, setSurface] = useState<Surface>('home');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-border px-6 py-3">
        <button
          type="button"
          onClick={() => setSurface('home')}
          className="flex items-center gap-2.5"
          aria-label="Go to home"
        >
          <LogoMark className="h-7 w-7" />
          <span className="font-display text-base font-semibold">ROSE Engine</span>
        </button>
        <nav className="flex items-center gap-1">
          {NAV_SURFACES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={surface === s ? 'primary' : 'ghost'}
              onClick={() => setSurface(s)}
            >
              {SURFACE_LABELS[s]}
            </Button>
          ))}
        </nav>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 p-6">
        {surface === 'home' && <Home onSelect={setSurface} />}
        {surface === 'covenant-console' && <CovenantConsole />}
        {surface === 'coupled-pair' && <CoupledPairPanel />}
        {surface === 'exchange-trading' && (
          <ExchangeTrading onNavigate={setSurface} owner={resolveSubscriberAddress()} />
        )}
        {surface === 'subscriber' && <SubscriberPanel />}
        {surface === 'alpha-engine' && <AlphaEngineSurface />}
      </main>
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
