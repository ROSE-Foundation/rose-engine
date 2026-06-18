import type { CoupledPairPosition } from '../../lib/contract-types.js';
import { legTokenSymbols } from '../../lib/leg-symbols.js';
import { deriveFloorUnits } from '../../lib/pair-math.js';

function Row({ k, v, hl }: { k: string; v: string; hl?: boolean }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-dim">{k}</dt>
      <dd className={hl ? 'text-right text-gold' : 'text-right'}>{v}</dd>
    </div>
  );
}

/**
 * Right column. ROSE coins are issued as an ATOMIC L+S package (the core coupling invariant — a
 * naked single leg is impossible on-chain), so this is NOT a perp order ticket: it shows the
 * selected market's REAL package terms and points to the Subscriber flow for the actual acquisition.
 * No fabricated balances, no fake write.
 */
export function OrderTicket({
  pair,
  onNavigate,
}: {
  pair: CoupledPairPosition | null;
  onNavigate?: (surface: 'subscriber') => void;
}): React.JSX.Element {
  if (!pair) {
    return (
      <div className="p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">Order ticket</p>
        <p className="mt-3 text-sm text-muted-foreground">No open pair for this market yet.</p>
      </div>
    );
  }
  const sym = legTokenSymbols(pair.referenceAsset);
  const floorUnits = deriveFloorUnits(pair.collateralPool, pair.floor).toString();
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">Order ticket</p>
      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <p className="mb-2 font-semibold">Acquire the coupled package</p>
        <p className="text-xs text-muted-foreground">
          Issued as an atomic <span className="text-long">{sym.long}</span> +{' '}
          <span className="text-short">{sym.short}</span> pair — delta-neutral at issuance, never a
          naked leg.
        </p>
        <dl className="mt-3 flex flex-col gap-1.5 font-numeric text-xs">
          <Row k="Reference" v={pair.referenceAsset} />
          <Row k="Anchor (P₀)" v={pair.anchorPrice} />
          <Row k="Leverage" v={`${pair.leverage}×`} />
          <Row k="Collateral (K)" v={`${pair.collateralPool} units`} />
          <Row k="Floor (f)" v={`${pair.floor} · ${floorUnits} units`} />
          <Row k="Max loss" v="Floored — never into debt" hl />
        </dl>
      </div>
      {onNavigate ? (
        <button
          type="button"
          onClick={() => onNavigate('subscriber')}
          className="rounded-lg border border-border bg-muted px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-elevated"
        >
          Subscribe to or redeem this package in the{' '}
          <span className="text-foreground">Subscriber</span> surface →
        </button>
      ) : (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          Subscribe to or redeem this package from the{' '}
          <span className="text-foreground">Subscriber</span> surface.
        </p>
      )}
      <div className="rounded-lg border border-long/20 bg-long/5 p-3 text-xs text-muted-foreground">
        <span className="text-long" aria-hidden>
          ◈
        </span>{' '}
        Collateral is segregated and 100% withdrawable; the package floors at zero.
      </div>
    </div>
  );
}
