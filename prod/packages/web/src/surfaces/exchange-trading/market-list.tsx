import { cn } from '../../lib/cn.js';
import type { CoupledCoinMarket } from '../../lib/contract-types.js';

/**
 * Left column: the coupled-coin markets aggregated by reference asset (live `coupledCoinBook`).
 * Each market is a keyboard-operable option; leg notionals are real smallest-units ("units" — the
 * `coupled_pairs` row carries no scale). No price/▵% is shown (no price feed; never fabricated).
 */
export function MarketList({
  markets,
  selected,
  onSelect,
}: {
  markets: readonly CoupledCoinMarket[];
  selected: string | null;
  onSelect: (referenceAsset: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between px-2 py-3 text-[11px] font-semibold uppercase tracking-wider text-dim">
        <span>Markets</span>
        <span className="font-numeric">{markets.length}</span>
      </div>
      <ul className="flex flex-col gap-1 overflow-y-auto" aria-label="Coupled markets">
        {markets.map((m) => {
          const active = m.referenceAsset === selected;
          return (
            <li key={m.referenceAsset}>
              <button
                type="button"
                onClick={() => onSelect(m.referenceAsset)}
                aria-pressed={active}
                className={cn(
                  'w-full rounded-lg border border-transparent p-3 text-left transition-colors hover:bg-muted',
                  active && 'border-border-strong bg-muted',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{m.referenceAsset}</span>
                  <span className="font-numeric text-xs text-dim">
                    {m.pairs} pair{m.pairs === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <span className="flex flex-1 items-center justify-between rounded-md bg-long/10 px-2 py-0.5 font-numeric text-[10px] text-long">
                    <span>L</span>
                    <span>{m.longNotional} u</span>
                  </span>
                  <span className="flex flex-1 items-center justify-between rounded-md bg-short/10 px-2 py-0.5 font-numeric text-[10px] text-short">
                    <span>S</span>
                    <span>{m.shortNotional} u</span>
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
