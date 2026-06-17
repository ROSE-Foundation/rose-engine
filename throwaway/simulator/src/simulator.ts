// THROWAWAY (Story 7.2, FR-16) — threshold-only rebalancing simulator over historical ticks.
//
// THE WHOLE POINT (FR-16): a coupled pair is reset (rebalanced) ONLY when a losing leg breaches
// the floor `f = m·L·g` — i.e. on a PRICE EVENT (intrinsic time), NEVER on a clock/interval.
// Clock-based rebalancing of a leveraged position would import leveraged-ETF volatility decay
// (the "intrinsic time" trap). So the reset decision below reads PRICE ONLY: it never branches
// on `tick.timestamp`, elapsed time, the tick index, or any cadence. `timestamp` is recorded on
// the reset event for human/audit reporting only.
//
// RESET SEMANTICS (D1/D1a RESOLVED): separate L/S, directional — the losing-leg holder bears the
// locked loss; the winner is the counterparty funded from pool K. At a reset we (a) LOCK the
// current dollar values (the exact integer legs at the breaching price), (b) RE-ANCHOR P₀ to the
// breaching price, and (c) LOCK the losing holder's loss (K/2 − locked losing-leg value). The
// pair then re-bases to a fresh symmetric K/2:K/2 split at the new anchor (a new neutral cycle,
// no carried P&L). The balanced settlement journal-every-reset + no-negative-leg proof + full
// lifecycle traversal are Story 7.3 — NOT here.
//
// REGIME: /throwaway. Reuses its sibling @throwaway/coupled-math (the 7.1 reference math) and the
// /prod exact-integer split primitive (@rose/shared `splitInTwo`) by relative path — the
// tolerated /throwaway → /prod direction. /prod must NEVER import this.
import { splitInTwo } from '../../../prod/packages/shared/src/money.js';
import {
  type FloorParams,
  type PairParams,
  ONE,
  ZERO,
  cmp,
  evaluate,
  floor,
  gte,
  toApproxString,
} from '../../coupled-math/src/index.js';
import { type Tick } from './ticks.js';

/** Which leg is the losing (shrinking) leg at a reset. */
export type LosingLeg = 'long' | 'short';

/** Inputs to a threshold-only replay. */
export interface SimConfig {
  /** Initial anchor price P₀ as a decimal string. */
  readonly initialAnchorPrice: string;
  /** Per-pair leverage L as a decimal string (read here — never hard-coded). */
  readonly leverage: string;
  /** Collateral pool K in smallest units (conserved across resets in this sim). */
  readonly collateralPool: bigint;
  /** Floor params m, g (load via @throwaway/coupled-math `loadFloorParams` — refuse-if-absent). */
  readonly floorParams: FloorParams;
}

/**
 * A single reset, fired ONLY by a floor breach (never by a clock). Captures the lock + re-anchor
 * + locked loss so Story 7.3 can journal it as the audit artifact.
 */
export interface ResetEvent {
  /** Index of the breaching tick in the input series. */
  readonly tickIndex: number;
  /** Timestamp of the breaching tick (reporting/audit ONLY — never drives the reset). */
  readonly timestamp: string;
  /** Breaching price (= the new anchor). */
  readonly price: string;
  /** The anchor that was breached (the cycle's P₀ before this reset). */
  readonly anchorBefore: string;
  /** Leveraged deviation L·r at the breach, lossy decimal — human reporting ONLY, never asserted. */
  readonly leveragedDeviationApprox: string;
  /** Which leg lost (`short` when L·r > 0 / price up; `long` when L·r < 0 / price down). */
  readonly losingLeg: LosingLeg;
  /** Locked long-leg value (smallest units) at the breaching price. */
  readonly lockedLong: bigint;
  /** Locked short-leg value (smallest units) at the breaching price. */
  readonly lockedShort: bigint;
  /** Locked loss of the losing holder = (neutral K/2 for that leg) − (locked losing-leg value). */
  readonly lockedLoss: bigint;
  /** New anchor P₀ after re-anchoring (= `price`). */
  readonly newAnchorPrice: string;
  /** True when the breach was a single gap PAST the barrier (|L·r| > 1, legs unrepresentable) —
   *  the issuer-neutrality break condition (losing leg clamped to 0). At exactly |L·r| = 1 the
   *  losing leg is 0 (not negative), legs exist, and this stays false. Formally reported in 7.3. */
  readonly gapPastFloor: boolean;
}

/** Outcome of a threshold-only replay. */
export interface SimResult {
  /** Every reset that fired, in tick order (empty ⇒ the floor was never breached). */
  readonly resets: ResetEvent[];
  /** Number of ticks replayed. */
  readonly ticksProcessed: number;
  /** Anchor P₀ after the last reset (or the initial anchor if none fired). */
  readonly finalAnchorPrice: string;
}

/**
 * Replays `ticks` against a coupled pair, firing a reset ONLY when the losing leg breaches the
 * floor. The reset condition consults the PRICE ONLY — `tick.timestamp` is never read by the
 * decision (proving event-driven / intrinsic-time rebalancing, FR-16). After each reset the
 * anchor moves to the breaching price and the cycle re-bases to a fresh symmetric split.
 */
export function simulate(ticks: readonly Tick[], config: SimConfig): SimResult {
  if (config.collateralPool < 0n) {
    throw new RangeError('Collateral pool K must be non-negative.');
  }
  // Refuse a degenerate floor f = m·L·g ≥ 1. The losing-leg buffer (1 − |L·r|) is at most 1, so
  // f ≥ 1 would breach on EVERY tick — including the neutral point r = 0, where NO leg is losing —
  // firing phantom resets and corrupting the (falsifiability-critical, SM-C1) reset-rate metric.
  // Fail closed rather than emit meaningless resets. This also makes the r = 0 tiebreak below
  // genuinely unreachable (a real breach always has |L·r| > 0).
  const f = floor(config.leverage, config.floorParams);
  if (gte(f, ONE)) {
    throw new RangeError(
      `Refusing to simulate: floor f = m·L·g = ${toApproxString(f)} ≥ 1 consumes the entire ` +
        `losing-leg buffer, so a reset would fire on every tick (including r = 0). Require m·L·g < 1.`,
    );
  }
  // The neutral baseline each cycle starts from: K/2 : K/2 (exact, deterministic residual).
  const [neutralLong, neutralShort] = splitInTwo(config.collateralPool);

  let anchor = config.initialAnchorPrice;
  const resets: ResetEvent[] = [];

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const params: PairParams = {
      anchorPrice: anchor,
      leverage: config.leverage,
      collateralPool: config.collateralPool,
    };

    // PRICE-ONLY decision. `tick.timestamp` is deliberately NOT passed in — the reset is driven
    // by the floor breach alone (FR-16: intrinsic time, never a clock).
    const ev = evaluate(params, tick.price, config.floorParams);
    if (!ev.floorBreached) {
      continue;
    }

    // Losing leg: L·r > 0 (price up) ⇒ short shrinks; L·r < 0 (price down) ⇒ long shrinks.
    // A real breach always has |L·r| > 0 (the f ≥ 1 guard above rules out a breach at r = 0), so
    // the r = 0 tiebreak is unreachable and the >= 0 branch is only ever taken for L·r > 0.
    const losingLeg: LosingLeg = cmp(ev.leveragedDeviation, ZERO) >= 0 ? 'short' : 'long';

    let lockedLong: bigint;
    let lockedShort: bigint;
    let gapPastFloor = false;
    if (ev.legs !== null) {
      // Within (or at) the barrier: lock the exact integer legs (long + short === K).
      lockedLong = ev.legs.long;
      lockedShort = ev.legs.short;
    } else {
      // Gap PAST the barrier (|L·r| > 1): no non-negative integer split exists — the losing leg
      // is wiped to 0 and the winner holds the whole pool. This is the issuer-neutrality-break
      // condition that Story 7.3 formally proves/reports; here we record it and flag it.
      gapPastFloor = true;
      if (losingLeg === 'short') {
        lockedShort = 0n;
        lockedLong = config.collateralPool;
      } else {
        lockedLong = 0n;
        lockedShort = config.collateralPool;
      }
    }

    const lockedLoss =
      losingLeg === 'short' ? neutralShort - lockedShort : neutralLong - lockedLong;

    resets.push({
      tickIndex: i,
      timestamp: tick.timestamp,
      price: tick.price,
      anchorBefore: anchor,
      leveragedDeviationApprox: toApproxString(ev.leveragedDeviation),
      losingLeg,
      lockedLong,
      lockedShort,
      lockedLoss,
      newAnchorPrice: tick.price,
      gapPastFloor,
    });

    // Re-anchor to the breaching price; the cycle re-bases to the fresh symmetric K/2:K/2 split
    // (implicit: at the new anchor r = 0, so the next evaluate() yields the neutral legs).
    anchor = tick.price;
  }

  return { resets, ticksProcessed: ticks.length, finalAnchorPrice: anchor };
}
