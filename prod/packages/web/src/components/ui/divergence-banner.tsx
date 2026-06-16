import { cn } from '../../lib/cn.js';
import type { ChainComparison } from '../../lib/contract-types.js';

/**
 * Ledger↔chain divergence banner (FR-10, UX-DR4). Shown ONLY when reconcile reports a mismatch;
 * states that the ledger was corrected toward the chain and links to the journaled correcting
 * entry. Carries a glyph + text (never color-only). The UI signals; it never corrects (that is
 * `@rose/reconcile`).
 */
export function DivergenceBanner({
  chainComparison,
  onViewEntry,
  correctingEntryId,
  className,
}: {
  chainComparison: ChainComparison;
  onViewEntry?: (entryId: string | null) => void;
  correctingEntryId?: string | null;
  className?: string;
}): React.JSX.Element | null {
  if (!chainComparison.anyDivergence) return null;
  const diverged = chainComparison.divergences.filter((d) => d.diverged);
  const assets = diverged.map((d) => d.asset).join(', ');
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center justify-between gap-3 rounded-md bg-warn px-4 py-2 text-warn-foreground',
        className,
      )}
    >
      <span>
        <span aria-hidden="true" className="mr-2">
          ⚠
        </span>
        Ledger ↔ chain divergence detected{assets ? ` on ${assets}` : ''}. Ledger corrected toward
        chain.
      </span>
      <button
        type="button"
        className="shrink-0 font-medium underline"
        onClick={() => onViewEntry?.(correctingEntryId ?? null)}
      >
        View entry
      </button>
    </div>
  );
}
