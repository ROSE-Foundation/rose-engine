import { DeltaIndicator } from '../../components/ui/delta-indicator.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table.js';
import type { Position, PositionMark } from '../../lib/contract-types.js';

/** P&L direction from the signed smallest-units string (no float math — BigInt compare). */
function pnlDirection(units: string): 'up' | 'down' | 'flat' {
  const n = BigInt(units);
  return n > 0n ? 'up' : n < 0n ? 'down' : 'flat';
}

// The DeltaIndicator owns the sign+glyph; its label is the unsigned magnitude only (no double sign).
function magnitude(units: string): string {
  return units.replace(/^-/, '');
}

/** The honest no-price-feed / stale-mark label for the price-dependent columns (UX-DR4). */
function MarkGap({ mark }: { mark: PositionMark }): React.JSX.Element {
  const note =
    mark.status === 'STALE'
      ? 'stale mark'
      : mark.status === 'DIVERGENT'
        ? 'flagged'
        : 'no price feed';
  return (
    <span className="text-dim">
      — <span className="text-[10px]">({note})</span>
    </span>
  );
}

/** The Mark column: live oracle price when OK, the surfaced-but-untrusted price when STALE, else a gap. */
function MarkCell({ mark }: { mark: PositionMark }): React.JSX.Element {
  if (mark.status === 'OK' && mark.markPrice !== null) {
    return <span className="font-numeric tabular-nums">{mark.markPrice}</span>;
  }
  if (mark.status === 'STALE' && mark.markPrice !== null) {
    return (
      <span className="font-numeric tabular-nums text-warn">
        {mark.markPrice} <span className="text-[10px]">(stale)</span>
      </span>
    );
  }
  return <MarkGap mark={mark} />;
}

/** The directional P&L column: a signed glyph delta when OK (never color-only), else the honest gap. */
function PnlCell({ mark }: { mark: PositionMark }): React.JSX.Element {
  if (mark.status === 'OK' && mark.unrealizedPnl !== null) {
    return (
      <DeltaIndicator
        direction={pnlDirection(mark.unrealizedPnl)}
        label={magnitude(mark.unrealizedPnl)}
      />
    );
  }
  return <MarkGap mark={mark} />;
}

/**
 * Open per-user positions (FR-26) with their LIVE marks + directional P&L (Story 8.4). Entry (P₀),
 * size/collateral and the lifecycle/side are real position fields; the Mark, P&L and distance-to-floor
 * columns render the live oracle mark when connected (`OK`) and the documented "no price feed" /
 * "stale" / "flagged" state otherwise (UX-DR4) — a mark is NEVER fabricated. Same columns/layout as
 * the price-feed-placeholder table it replaces (behavioural wiring only, no new visual design).
 */
export function PositionsTable({
  positions,
}: {
  positions: readonly Position[];
}): React.JSX.Element {
  if (positions.length === 0) {
    return <p className="text-muted-foreground">No open positions.</p>;
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH>Market</TH>
          <TH>Side / state</TH>
          <TH>Size / collateral</TH>
          <TH>Entry (P₀)</TH>
          <TH>Mark</TH>
          <TH>P&amp;L</TH>
          <TH>Distance to floor</TH>
        </TR>
      </THead>
      <TBody>
        {positions.map((p) => (
          <TR key={p.id}>
            <TD>{p.referenceAsset}</TD>
            <TD>
              <span className="flex items-center gap-2">
                <span className={p.side === 'LONG' ? 'text-long' : 'text-short'}>{p.side}</span>
                {p.lifecycle === 'CLOSED' && <StatusBadge status="CLOSED" />}
              </span>
            </TD>
            <TD className="font-numeric tabular-nums">{p.sizeUnits}</TD>
            <TD className="font-numeric tabular-nums">{p.entryPrice}</TD>
            <TD>
              <MarkCell mark={p.mark} />
            </TD>
            <TD>
              <PnlCell mark={p.mark} />
            </TD>
            <TD className="font-numeric tabular-nums">
              {p.mark.status === 'OK' && p.mark.distanceToFloor !== null ? (
                p.mark.distanceToFloor
              ) : (
                <span className="text-dim">—</span>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
