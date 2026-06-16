import { cn } from '../../lib/cn.js';

/**
 * A signed delta as **sign + glyph + semantic color** (UX-DR2) — meaning NEVER rests on color
 * alone (the `▴`/`▾` glyph and the explicit sign carry it, colorblind-safe + AA).
 *
 * `direction` is derived by the caller from decimal strings (no float math here); `label` is the
 * already-formatted magnitude string (e.g. "0.4%").
 */
export function DeltaIndicator({
  direction,
  label,
  className,
}: {
  direction: 'up' | 'down' | 'flat';
  label: string;
  className?: string;
}): React.JSX.Element {
  const glyph = direction === 'up' ? '▴' : direction === 'down' ? '▾' : '–';
  const sign = direction === 'up' ? '+' : direction === 'down' ? '−' : '';
  const color =
    direction === 'up' ? 'text-gain' : direction === 'down' ? 'text-loss' : 'text-muted-foreground';
  return (
    <span
      className={cn('inline-flex items-center gap-1 font-numeric tabular-nums', color, className)}
      aria-label={`${direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'flat'} ${label}`}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>
        {sign}
        {label}
      </span>
    </span>
  );
}
