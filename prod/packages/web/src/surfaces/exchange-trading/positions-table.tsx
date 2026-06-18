import { StatusBadge } from '../../components/ui/status-badge.js';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table.js';
import type { CoupledPairPosition } from '../../lib/contract-types.js';
import { deriveFloorUnits, distanceToFloor } from '../../lib/pair-math.js';

/**
 * Open coupled-pair positions. Entry (anchor), size/collateral (K), distance-to-floor and the
 * floored max-loss are REAL (from `pair-math` on live params). The live "Mark" and "P&L" columns
 * require a price feed that is not wired, so they render an explicit empty-state — never fabricated.
 */
export function PositionsTable({
  pairs,
}: {
  pairs: readonly CoupledPairPosition[];
}): React.JSX.Element {
  if (pairs.length === 0) {
    return <p className="text-muted-foreground">No open pairs.</p>;
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH>Market</TH>
          <TH>State</TH>
          <TH>Size / collateral (K)</TH>
          <TH>Entry (P₀)</TH>
          <TH>Mark</TH>
          <TH>P&amp;L</TH>
          <TH>Distance to floor</TH>
        </TR>
      </THead>
      <TBody>
        {pairs.map((p) => {
          const floorUnits = deriveFloorUnits(p.collateralPool, p.floor);
          const distance = distanceToFloor(
            p.longLegValue,
            p.shortLegValue,
            p.collateralPool,
            p.floor,
          );
          const near = distance <= floorUnits / 5n;
          return (
            <TR key={p.id}>
              <TD>{p.referenceAsset}</TD>
              <TD>
                <StatusBadge status={p.state} />
              </TD>
              <TD className="font-numeric tabular-nums">{p.collateralPool}</TD>
              <TD className="font-numeric tabular-nums">{p.anchorPrice}</TD>
              <TD className="text-dim">
                — <span className="text-[10px]">(price feed)</span>
              </TD>
              <TD className="text-dim">
                — <span className="text-[10px]">(price feed)</span>
              </TD>
              <TD
                className={
                  near ? 'font-numeric tabular-nums text-warn' : 'font-numeric tabular-nums'
                }
                aria-label={`distance to floor ${distance.toString()}`}
              >
                {distance >= 0n ? distance.toString() : `${distance.toString()} (breached)`}
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
