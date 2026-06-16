import { cn } from '../../lib/cn.js';
import type { Money } from '../../lib/contract-types.js';

/**
 * The atom of every table (UX-DR2, NFR-2). Renders a money amount from its **decimal string** —
 * NEVER from `smallestUnits` parsed to a `number`, and never any float math. Tabular mono,
 * right-aligned, asset symbol always shown, no truncation. Announces value + unit + scale to SR.
 */
export function MoneyCell({
  money,
  className,
  showAsset = true,
}: {
  money: Money;
  className?: string;
  showAsset?: boolean;
}): React.JSX.Element {
  const label = `${money.decimal} ${money.asset} (scale ${money.scale})`;
  return (
    <span
      className={cn(
        'inline-flex justify-end gap-1 whitespace-nowrap text-right font-numeric tabular-nums',
        className,
      )}
      aria-label={label}
      title={`${money.smallestUnits} smallest units`}
    >
      <span>{money.decimal}</span>
      {showAsset && (
        <span className="text-muted-foreground" aria-hidden="true">
          {money.asset}
        </span>
      )}
    </span>
  );
}
