import type { CoupledPairPosition } from '../../lib/contract-types.js';
import { deriveFloorUnits, legsAtPrice } from '../../lib/pair-math.js';

/**
 * The Exchange "chart" — a REAL graph, not a fabricated price tape. ROSE has no price oracle, so
 * instead of inventing a market price series the chart plots the package's actual PAYOFF: each leg's
 * value (via `legsAtPrice`) as the reference price moves off the anchor P₀, with the floor clamp made
 * visible. Every point is exact product math derived from this market's real K / leverage / floor —
 * nothing is mocked. When a market has no live pair (no parameters to plot), the honest "price feed
 * not connected" empty-state is shown instead (see `ChartPlaceholder`).
 */

// SVG canvas (a viewBox the parent scales to width; the aspect ratio is fixed by the height class).
const W = 600;
const H = 240;
const PAD = { top: 16, right: 12, bottom: 26, left: 12 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const SAMPLES = 121;

/** Parse a decimal string to a JS number for PLOTTING ONLY (pixel positions — never money math). */
function num(value: string): number {
  return Number.parseFloat(value);
}

/** Compact units label for the y-context (e.g. 1_000_000_000n → "1.00B"). Display-only. */
function compactUnits(units: bigint): string {
  const n = Number(units);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(units);
}

/**
 * The basis-point range to sweep on the x-axis. Centred on the anchor and wide enough to show the
 * floor clamp on BOTH sides: the lower leg hits the floor at r = (1 − f)/L; sweep ~1.5× past that.
 */
function sweepRangeBps(leverage: string, floor: string): number {
  const l = num(leverage);
  const f = num(floor);
  if (!Number.isFinite(l) || l <= 0) return 2000;
  const clampR = (1 - f) / l; // fractional price move at which the losing leg reaches the floor
  return Math.min(9000, Math.max(800, Math.round(clampR * 10000 * 1.5)));
}

export function PayoffChart({ pair }: { pair: CoupledPairPosition }): React.JSX.Element {
  const k = BigInt(pair.collateralPool);
  const floorUnits = deriveFloorUnits(pair.collateralPool, pair.floor);
  const rangeBps = sweepRangeBps(pair.leverage, pair.floor);

  const kNum = Number(k) || 1;
  const x = (bps: number): number => PAD.left + ((bps + rangeBps) / (2 * rangeBps)) * PLOT_W;
  const y = (units: bigint): number => PAD.top + (1 - Number(units) / kNum) * PLOT_H;

  // Sample both legs across the price-move range — exact `legsAtPrice` math at every step.
  const longPts: string[] = [];
  const shortPts: string[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const bps = -rangeBps + (i / (SAMPLES - 1)) * (2 * rangeBps);
    const { longLeg, shortLeg } = legsAtPrice(pair.collateralPool, pair.leverage, pair.floor, bps);
    longPts.push(`${x(bps).toFixed(2)},${y(longLeg).toFixed(2)}`);
    shortPts.push(`${x(bps).toFixed(2)},${y(shortLeg).toFixed(2)}`);
  }

  const yMid = y(k / 2n);
  const yFloor = y(floorUnits);
  const yCap = y(k - floorUnits);
  const xAnchor = x(0);
  const lowEdgePct = `−${(rangeBps / 100).toFixed(0)}%`;
  const highEdgePct = `+${(rangeBps / 100).toFixed(0)}%`;

  return (
    <div className="min-h-[180px] flex-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[200px] w-full"
        role="img"
        aria-label={`Payoff curve for ${pair.referenceAsset}: long and short leg value as the reference price moves ${lowEdgePct} to ${highEdgePct} off the anchor ${pair.anchorPrice}, each clamped at the floor.`}
      >
        {/* Floor band — the region neither leg can fall below (the package never goes into debt). */}
        <rect
          x={PAD.left}
          y={yCap}
          width={PLOT_W}
          height={yFloor - yCap}
          fill="var(--gold)"
          opacity={0.05}
        />
        {/* K/2 midline — where the legs cross at the anchor (delta-neutral issuance). */}
        <line
          x1={PAD.left}
          y1={yMid}
          x2={W - PAD.right}
          y2={yMid}
          stroke="var(--border-strong)"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
        {/* Floor + cap guides. */}
        <line x1={PAD.left} y1={yFloor} x2={W - PAD.right} y2={yFloor} stroke="var(--gold)" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
        <line x1={PAD.left} y1={yCap} x2={W - PAD.right} y2={yCap} stroke="var(--gold)" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
        {/* Anchor (P₀) — the current reference, where both legs sit at K/2. */}
        <line x1={xAnchor} y1={PAD.top} x2={xAnchor} y2={H - PAD.bottom} stroke="var(--dim)" strokeWidth={1} strokeDasharray="2 3" />
        <circle cx={xAnchor} cy={yMid} r={3} fill="var(--gold)" />

        {/* The two real payoff curves. */}
        <polyline points={shortPts.join(' ')} fill="none" stroke="var(--short)" strokeWidth={2} strokeLinejoin="round" />
        <polyline points={longPts.join(' ')} fill="none" stroke="var(--long)" strokeWidth={2} strokeLinejoin="round" />
      </svg>

      {/* Axis context + legend (real values, not a fabricated tape). */}
      <div className="mt-1 flex justify-between font-numeric text-[10px] text-dim">
        <span>{lowEdgePct}</span>
        <span>P₀ = {pair.anchorPrice}</span>
        <span>{highEdgePct}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-long">
          <span className="inline-block h-0.5 w-3 bg-long" aria-hidden /> Long leg
        </span>
        <span className="flex items-center gap-1.5 text-short">
          <span className="inline-block h-0.5 w-3 bg-short" aria-hidden /> Short leg
        </span>
        <span className="flex items-center gap-1.5 text-gold">
          <span className="inline-block h-0.5 w-3 bg-gold opacity-60" aria-hidden /> Floor ·{' '}
          {compactUnits(floorUnits)} u
        </span>
        <span className="text-dim">
          Payoff vs reference price · {pair.leverage}× · K = {compactUnits(k)} u
        </span>
      </div>
    </div>
  );
}
