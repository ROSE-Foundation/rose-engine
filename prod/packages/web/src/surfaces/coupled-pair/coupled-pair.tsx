import { Card, CardContent, CardHeader } from '../../components/ui/card.js';
import { LiveIndicator } from '../../components/ui/live-indicator.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { ApiClientError } from '../../lib/api-client.js';
import type { CoupledPairResponse } from '../../lib/contract-types.js';
import { deriveFloorUnits, distanceToFloor, legsBalance, sumLegs } from '../../lib/pair-math.js';
import { REFRESH_WINDOW_MS, useCoupledPair } from '../../lib/queries.js';
import {
  CoupledCoinsWalkthrough,
  type WalkthroughParams,
} from './walkthrough/coupled-coins-walkthrough.js';

/** A raw smallest-units magnitude (the `coupled_pairs` row carries no per-leg scale). Mono, exact. */
function Units({ value, label }: { value: string; label?: string }): React.JSX.Element {
  return (
    <span className="font-numeric tabular-nums" aria-label={label}>
      {value}
    </span>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border py-[6px]">
      <dt className="text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Presentational live Coupled-Pair view (AC-3, FR-6): `V_A`, `V_B`, `K`, `floor`, `anchor (P₀)`,
 * current `P` (when supplied by a live tick), the holding (the two legs), with `V_A + V_B = K`
 * shown and distance-to-floor legible (warn when near/breached). Lifecycle badge + live indicator.
 */
export function CoupledPairView({
  pair,
  currentPrice,
  lastUpdated,
  refreshWindowMs = REFRESH_WINDOW_MS,
  now,
}: {
  pair: CoupledPairResponse;
  currentPrice?: string | null;
  lastUpdated: Date | string | number;
  refreshWindowMs?: number;
  now?: number;
}): React.JSX.Element {
  const k = sumLegs(pair.longLegValue, pair.shortLegValue);
  const balanced = legsBalance(pair.longLegValue, pair.shortLegValue, pair.collateralPool);
  const floorUnits = deriveFloorUnits(pair.collateralPool, pair.floor);
  const distance = distanceToFloor(
    pair.longLegValue,
    pair.shortLegValue,
    pair.collateralPool,
    pair.floor,
  );
  const nearFloor = distance <= floorUnits / 5n; // within 20% of the threshold (or breached)

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-display text-lg font-semibold">
            Coupled pair · {pair.referenceAsset}
          </span>
          <StatusBadge status={pair.state} />
        </div>
        <LiveIndicator lastUpdated={lastUpdated} refreshWindowMs={refreshWindowMs} now={now} />
      </CardHeader>
      <CardContent>
        <dl>
          <Row term="V_A (long leg)">
            <Units value={pair.longLegValue} label={`long leg ${pair.longLegValue}`} />
          </Row>
          <Row term="V_B (short leg)">
            <Units value={pair.shortLegValue} label={`short leg ${pair.shortLegValue}`} />
          </Row>
          <Row term="K (collateral pool)">
            <span className="flex items-center gap-2">
              <Units value={pair.collateralPool} />
              <span
                className={balanced ? 'text-xs text-gain' : 'text-xs text-loss'}
                aria-label={balanced ? 'V_A plus V_B equals K' : 'V_A plus V_B does not equal K'}
              >
                {balanced ? '✓ V_A + V_B = K' : `✗ V_A + V_B = ${k.toString()} ≠ K`}
              </span>
            </span>
          </Row>
          <Row term="Anchor (P₀)">
            <Units value={pair.anchorPrice} />
          </Row>
          <Row term="Current P">
            <Units value={currentPrice ?? '—'} />
          </Row>
          <Row term="Floor (f)">
            <span className="font-numeric tabular-nums">
              {pair.floor} · {floorUnits.toString()} units
            </span>
          </Row>
          <Row term="Leverage (L)">
            <Units value={pair.leverage} />
          </Row>
          <Row term="Distance to floor">
            <span
              className={
                nearFloor ? 'font-numeric tabular-nums text-warn' : 'font-numeric tabular-nums'
              }
              aria-label={`distance to floor ${distance.toString()}`}
            >
              {distance >= 0n ? distance.toString() : `${distance.toString()} (breached)`}
            </span>
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Maps a live pair into the walkthrough's simulation parameters (real, not illustrative). */
function toWalkthroughParams(pair: CoupledPairResponse): WalkthroughParams {
  return {
    referenceAsset: pair.referenceAsset,
    anchorPrice: pair.anchorPrice,
    leverage: pair.leverage,
    collateralPool: pair.collateralPool,
    floor: pair.floor,
    illustrative: false,
  };
}

/** The live-data section: `CoupledPairView` with explicit loading/empty/error states. */
function LivePairSection({
  query,
}: {
  query: ReturnType<typeof useCoupledPair>;
}): React.JSX.Element {
  if (query.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (query.isError) {
    const code = query.error instanceof ApiClientError ? query.error.code : 'REQUEST_FAILED';
    return (
      <div role="alert" className="rounded-md border border-loss p-4 text-loss">
        <p>Failed to load pair — {code}.</p>
        <button type="button" className="mt-2 underline" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!query.data) {
    return <p className="text-muted-foreground">No active pairs.</p>;
  }
  return <CoupledPairView pair={query.data} lastUpdated={query.dataUpdatedAt} />;
}

/**
 * The Coupled-Pair surface ("the mechanism", mock card 03): the pedagogical coupled-coins
 * walkthrough — seeded from the live pair when one is available, otherwise an explicitly-illustrative
 * example — above the live-data `CoupledPairView`.
 */
export function CoupledPairSurface({ pairId }: { pairId: string }): React.JSX.Element {
  const query = useCoupledPair(pairId);
  const livePair = query.data ? toWalkthroughParams(query.data) : null;

  return (
    <div className="flex flex-col gap-6">
      <CoupledCoinsWalkthrough livePair={livePair} />
      <LivePairSection query={query} />
    </div>
  );
}
