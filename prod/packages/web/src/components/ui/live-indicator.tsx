import { cn } from '../../lib/cn.js';

/**
 * Freshness signal (UX-DR3/UX-DR4). `gain` pulse while the data is within the refresh window;
 * flips to `warn` "Stale · last updated {time}" once it ages beyond it. Freshness changes are
 * announced via `aria-live`. `now` is injectable so the stale branch is deterministically testable.
 */
export function LiveIndicator({
  lastUpdated,
  refreshWindowMs,
  now = Date.now(),
  className,
}: {
  lastUpdated: Date | string | number;
  refreshWindowMs: number;
  now?: number;
  className?: string;
}): React.JSX.Element {
  const updatedMs = new Date(lastUpdated).getTime();
  const stale = now - updatedMs > refreshWindowMs;
  const timeLabel = new Date(updatedMs).toLocaleTimeString();
  return (
    <span
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-2 text-xs',
        stale ? 'text-warn' : 'text-gain',
        className,
      )}
    >
      <span aria-hidden="true">●</span>
      {stale ? <span>Stale · last updated {timeLabel}</span> : <span>Live</span>}
    </span>
  );
}
