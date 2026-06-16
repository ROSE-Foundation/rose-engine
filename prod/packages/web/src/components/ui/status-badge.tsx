import { cn } from '../../lib/cn.js';
import type { CoupledPairState } from '../../lib/contract-types.js';

/** The data-consistency statuses layered on top of the six lifecycle states. */
export type ConsistencyStatus = 'live' | 'divergent' | 'pending';

export type BadgeStatus = CoupledPairState | ConsistencyStatus;

// Each status maps to a semantic token AND a label — color-mapped but NEVER color-only (UX-DR8).
const STATUS_STYLE: Record<BadgeStatus, string> = {
  PENDING: 'border-warn text-warn',
  ACTIVE: 'border-gain text-gain',
  REBALANCING: 'border-warn text-warn',
  PARTIAL: 'border-warn text-warn',
  SETTLING: 'border-info text-info',
  CLOSED: 'border-border text-muted-foreground',
  live: 'border-gain text-gain',
  divergent: 'border-warn text-warn',
  pending: 'border-warn text-warn',
};

const STATUS_LABEL: Record<BadgeStatus, string> = {
  PENDING: 'Pending',
  ACTIVE: 'Active',
  REBALANCING: 'Rebalancing',
  PARTIAL: 'Partial',
  SETTLING: 'Settling',
  CLOSED: 'Closed',
  live: 'Live',
  divergent: 'Divergent',
  pending: 'Pending tx',
};

/** A pill badge announcing a lifecycle / consistency state — label-bearing, pill radius only. */
export function StatusBadge({
  status,
  className,
}: {
  status: BadgeStatus;
  className?: string;
}): React.JSX.Element {
  const label = STATUS_LABEL[status];
  return (
    <span
      role="status"
      aria-label={`Status: ${label}`}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        STATUS_STYLE[status],
        className,
      )}
    >
      {label}
    </span>
  );
}
