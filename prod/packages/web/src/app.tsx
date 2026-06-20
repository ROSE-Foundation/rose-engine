import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { IdentitySwitcher } from './components/identity-switcher.js';
import { SignInRequired } from './components/sign-in-required.js';
import { ThemeProvider } from './components/theme-provider.js';
import { ThemeToggle } from './components/theme-toggle.js';
import { Button } from './components/ui/button.js';
import { LogoMark } from './components/ui/logo-mark.js';
import { createApiClient, resolveApiBaseUrl } from './lib/api-client.js';
import { ApiClientProvider, useGroupView } from './lib/queries.js';
import { SessionProvider, useSession } from './lib/session.js';
import { DeltaEngineSurface } from './surfaces/delta-engine/delta-engine.js';
import { CoupledPairSurface } from './surfaces/coupled-pair/coupled-pair.js';
import { CovenantConsole } from './surfaces/covenant-console/covenant-console.js';
import { ExchangeTrading } from './surfaces/exchange-trading/exchange-trading.js';
import { Home } from './surfaces/home/home.js';
import { OperatorPanel } from './surfaces/operator/operator-panel.js';
import { SimulationSurface } from './surfaces/simulation/simulation.js';
import { SubscriberSurface } from './surfaces/subscriber/subscriber.js';

type Surface =
  | 'home'
  | 'covenant-console'
  | 'coupled-pair'
  | 'exchange-trading'
  | 'subscriber'
  | 'simulation'
  | 'operator'
  | 'delta-engine';

// Topnav surfaces (Home is reached via the logo mark, per the mocks). Labels follow index.html.
// `delta-engine` is a THROWAWAY R&D PoC embedded as a static asset (see DeltaEngineSurface) — it
// adds no /prod→/throwaway code dependency.
const NAV_SURFACES: readonly Surface[] = [
  'exchange-trading',
  'covenant-console',
  'coupled-pair',
  'subscriber',
  'simulation',
  'operator',
  'delta-engine',
];

// Operator-only nav surfaces (Story 9.3 role gate): a subscriber / signed-out visitor never sees them.
const OPERATOR_ONLY_SURFACES: readonly Surface[] = ['simulation', 'operator'];

const SURFACE_LABELS: Record<Surface, string> = {
  home: 'Home',
  'covenant-console': 'Treasury Dashboard',
  'coupled-pair': 'Coupled Coins',
  'exchange-trading': 'Exchange',
  subscriber: 'Subscriber',
  simulation: 'Simulation',
  operator: 'Operator',
  'delta-engine': 'Delta Engine',
};

const queryClient = new QueryClient();
const apiClient = createApiClient({ baseUrl: resolveApiBaseUrl() });

/** Resolves the first live pair from the group view so the Coupled-Pair surface has a target. */
function CoupledPairPanel(): React.JSX.Element {
  const query = useGroupView();
  const pairId = query.data?.coupledPairs[0]?.id;
  if (!pairId) return <p className="text-muted-foreground">No active pairs.</p>;
  return <CoupledPairSurface pairId={pairId} />;
}

/** Resolves the Subscriber's held note ids from the live group view; acts as the session identity. */
function SubscriberPanel({ subscriberAddress }: { subscriberAddress: string }): React.JSX.Element {
  const query = useGroupView();
  const noteIds = (query.data?.coupledPairs ?? [])
    .map((p) => p.noteId)
    .filter((id): id is string => id !== null);
  return (
    <SubscriberSurface
      eligibility={{ eligible: true }}
      subscriberAddress={subscriberAddress}
      noteIds={noteIds}
    />
  );
}

/**
 * The nav surfaces a given identity may see (Story 9.3 role gate): an operator sees everything; a
 * subscriber (or a signed-out visitor) does NOT see the operator-only Simulation / Operator tabs.
 * Exchange + Subscriber stay in the nav for the signed-out visitor but fail closed to a "sign in
 * first" state.
 */
function navSurfacesFor(isOperator: boolean): readonly Surface[] {
  return isOperator
    ? NAV_SURFACES
    : NAV_SURFACES.filter((s) => !OPERATOR_ONLY_SURFACES.includes(s));
}

export function Shell(): React.JSX.Element {
  const [surface, setSurface] = useState<Surface>('home');
  const { identity, isOperator } = useSession();
  const ownerAddress = identity?.address ?? '';
  const navSurfaces = navSurfacesFor(isOperator);

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
          {navSurfaces.map((s) => (
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
        <div className="ml-auto flex items-center gap-2">
          <IdentitySwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 p-6">
        {surface === 'home' && <Home onSelect={setSurface} />}
        {surface === 'covenant-console' && <CovenantConsole />}
        {surface === 'coupled-pair' && <CoupledPairPanel />}
        {/* Exchange open/close is a gated write surface — fail closed to "sign in first" with no
            default address, never acting as a baked-in identity (FR-30, AC3). */}
        {surface === 'exchange-trading' &&
          (identity ? (
            <ExchangeTrading
              onNavigate={setSurface}
              owner={ownerAddress}
              showOperatorTools={isOperator}
            />
          ) : (
            <SignInRequired surface="the Exchange terminal" />
          ))}
        {surface === 'subscriber' &&
          (identity ? (
            <SubscriberPanel subscriberAddress={ownerAddress} />
          ) : (
            <SignInRequired surface="the Subscriber surface" />
          ))}
        {/* The Simulation tab is an operator surface — gated even if the surface state lingers after a
            switch to a non-operator identity. */}
        {surface === 'simulation' &&
          (isOperator ? (
            <SimulationSurface />
          ) : (
            <SignInRequired surface="Simulation" operatorOnly />
          ))}
        {/* The Operator panel is an operator surface — gated even if the surface state lingers after a
            switch to a non-operator identity. */}
        {surface === 'operator' &&
          (isOperator ? (
            <OperatorPanel />
          ) : (
            <SignInRequired surface="the Operator panel" operatorOnly />
          ))}
        {surface === 'delta-engine' && <DeltaEngineSurface />}
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
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
