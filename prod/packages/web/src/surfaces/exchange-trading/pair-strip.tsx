import type { CoupledCoinMarket } from '../../lib/contract-types.js';
import { legTokenSymbols } from '../../lib/leg-symbols.js';

/** The two leg tokens of a market: derived symbols + real outstanding notionals ("units"). */
export function PairStrip({ market }: { market: CoupledCoinMarket }): React.JSX.Element {
  const sym = legTokenSymbols(market.referenceAsset);
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <div className="flex-1 rounded-lg border border-border bg-card p-3">
        <p className="font-numeric text-[10px] uppercase tracking-wider text-long">
          <span aria-hidden>◤</span> Long token · L
        </p>
        <p className="mt-1 font-semibold">{sym.long}</p>
        <p className="mt-0.5 font-numeric text-xs text-dim">
          {market.longNotional} units outstanding
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Gains as the reference rises. Floors at zero — never liquidated into debt.
        </p>
      </div>
      <div className="flex-1 rounded-lg border border-border bg-card p-3">
        <p className="font-numeric text-[10px] uppercase tracking-wider text-short">
          <span aria-hidden>◢</span> Short token · S
        </p>
        <p className="mt-1 font-semibold">{sym.short}</p>
        <p className="mt-0.5 font-numeric text-xs text-dim">
          {market.shortNotional} units outstanding
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The mirror leg. Gains as the reference falls. Same protections.
        </p>
      </div>
    </div>
  );
}
