import { cn } from '../../lib/cn.js';
import type { Covenant } from '../../lib/contract-types.js';

// Each covenant status maps to a semantic token + glyph + label — color-mapped but NEVER color-only
// (UX-DR8): the glyph and label carry the meaning for AA / colorblind readers.
const STATUS_STYLE: Record<
  Covenant['status'],
  { text: string; bar: string; glyph: string; label: string }
> = {
  PASS: { text: 'text-gain', bar: 'bg-gain', glyph: '✓', label: 'Pass' },
  WATCH: { text: 'text-warn', bar: 'bg-warn', glyph: '◑', label: 'Watch' },
  BREACH: { text: 'text-loss', bar: 'bg-loss', glyph: '✕', label: 'Breach' },
  NA: { text: 'text-muted-foreground', bar: 'bg-muted-foreground', glyph: '–', label: 'N/A' },
};

/** Basis points → percent for display (6670 bps → 66.7%). Presentation only — not a money path. */
function bpsToPercent(bps: number): number {
  return bps / 100;
}

function clampPercent(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

/**
 * One bright-line covenant: a horizontal bar filled to the current ratio, a marker at the configured
 * threshold (floor/ceiling), the current/threshold footer, and a PASS/WATCH/BREACH/NA badge.
 */
export function CovenantBar({ covenant }: { covenant: Covenant }): React.JSX.Element {
  const style = STATUS_STYLE[covenant.status];
  const thresholdPct = bpsToPercent(covenant.thresholdBps);
  const currentPct = covenant.currentBps === null ? null : bpsToPercent(covenant.currentBps);
  const fillPct = currentPct === null ? 0 : clampPercent(currentPct);
  const markerPct = clampPercent(thresholdPct);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{covenant.label}</span>
        <span
          role="status"
          aria-label={`Status: ${style.label}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-current px-2 py-0.5 text-xs font-medium',
            style.text,
          )}
        >
          <span aria-hidden>{style.glyph}</span>
          {style.label}
        </span>
      </div>

      <div className="relative mt-3 h-2 rounded-full bg-muted">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', style.bar)}
          style={{ width: `${fillPct}%` }}
        />
        {/* Threshold marker — the floor/ceiling line the bar must stay on the safe side of. */}
        <div
          className="absolute -inset-y-0.5 w-0.5 bg-foreground"
          style={{ left: `${markerPct}%` }}
          aria-hidden
        />
      </div>

      <div className="mt-2 flex items-center justify-between font-numeric text-xs text-muted-foreground">
        <span
          aria-label={`current ${currentPct === null ? 'unavailable' : `${currentPct.toFixed(1)} percent`}`}
        >
          {currentPct === null ? '—' : `${currentPct.toFixed(1)}%`}
        </span>
        <span>
          {covenant.kind === 'floor' ? 'floor' : 'ceiling'} {thresholdPct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
