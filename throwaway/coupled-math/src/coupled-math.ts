// THROWAWAY (Story 7.1, FR-15) — coupled-coin reference math + issuer-neutral invariant.
//
// Reference model (addendum §D, from SPEC):
//   r   = (P − P₀) / P₀          # deviation from the anchor
//   V_A = (K/2)·(1 + L·r)        # long leg
//   V_B = (K/2)·(1 − L·r)        # short leg
//   INVARIANT: V_A + V_B = K  for all P  ⇒  issuer net = 0   (SM-2)
//   floor f = m · L · g          # g = worst plausible gap; m = safety margin
//
// EXACTNESS: the proportions (r, L·r, f, buffer) are exact Rationals; the POSTED leg values
// are smallest-unit BigInt integers produced by @rose/shared `allocate`, whose largest-
// remainder policy makes the two parts sum to K EXACTLY (long + short === K) — the canonical
// "V_A + V_B = K primitive". L is read per-pair from `leverage`, never hard-coded.
//
// REGIME: this file lives under /throwaway and imports /prod (allowed). /prod must NEVER
// import /throwaway. /throwaway is not a pnpm-workspace member, so @rose/shared is reached by
// a relative path into /prod source (the regime guard tolerates /throwaway → /prod).
import { allocate } from '../../../prod/packages/shared/src/money.js';
import { type Rational, ONE, abs, cmp, div, gte, lte, mul, parseDecimal, sub } from './rational.js';
import { type FloorParams } from './floor-params.js';

/** A coupled pair's reference-math inputs. `collateralPool` (K) is smallest-unit integer. */
export interface PairParams {
  /** Anchor price P₀ as a decimal string. */
  readonly anchorPrice: string;
  /** Per-pair leverage L as a decimal string (read per call — never hard-coded). */
  readonly leverage: string;
  /** Collateral pool K in smallest units (the sum of both legs). */
  readonly collateralPool: bigint;
}

/** The two leg values in smallest units. Invariant (within the barrier): `long + short === K`. */
export interface LegValues {
  /** Long leg V_A. */
  readonly long: bigint;
  /** Short leg V_B. */
  readonly short: bigint;
}

/** A full one-shot evaluation of the model at a price. */
export interface Evaluation {
  /** Reference deviation r = (P − P₀)/P₀. */
  readonly r: Rational;
  /** Leveraged deviation L·r. */
  readonly leveragedDeviation: Rational;
  /** True while |L·r| < 1 (a leg is strictly positive). */
  readonly withinBarrier: boolean;
  /** True once |L·r| >= 1 (a leg is zero or would be negative). */
  readonly barrierCrossed: boolean;
  /** True when |L·r| > 1 — a leg would be strictly negative ⇒ issuer-neutrality break. */
  readonly legWouldBeNegative: boolean;
  /** Exact integer leg split (null when the barrier is crossed and no non-negative split exists). */
  readonly legs: LegValues | null;
  /** True when legs exist and `long + short === K`. */
  readonly invariantHolds: boolean;
  /** Remaining buffer of the losing leg, 1 − |L·r| (≤ 0 once the barrier is crossed). */
  readonly buffer: Rational;
  /** Floor f = m · L · g. */
  readonly floor: Rational;
  /** True when buffer ≤ f (a reset would fire). */
  readonly floorBreached: boolean;
}

/** Reference deviation r = (P − P₀)/P₀. Refuses a zero anchor (P₀ must be non-zero). */
export function referenceDeviation(price: string, anchorPrice: string): Rational {
  const p = parseDecimal(price);
  const p0 = parseDecimal(anchorPrice);
  if (p0.n === 0n) {
    throw new RangeError('Anchor price P₀ must be non-zero.');
  }
  return div(sub(p, p0), p0);
}

/** Leveraged deviation L·r. */
export function leveragedDeviation(price: string, anchorPrice: string, leverage: string): Rational {
  return mul(parseDecimal(leverage), referenceDeviation(price, anchorPrice));
}

/** True while |L·r| < 1 — both legs are strictly positive (price within the barrier). */
export function withinBarrier(price: string, anchorPrice: string, leverage: string): boolean {
  return cmp(abs(leveragedDeviation(price, anchorPrice, leverage)), ONE) < 0;
}

/**
 * Exact integer leg split V_A/V_B from price. Weights `[b + a, b − a]` (where L·r = a/b, b > 0)
 * are proportional to `(1 + L·r) : (1 − L·r)`; `allocate` makes the parts sum to K exactly.
 * Throws when |L·r| > 1 (a leg would be negative — the barrier is crossed). At |L·r| = 1 the
 * losing leg is exactly 0 (boundary, not negative).
 */
export function legValues(params: PairParams, price: string): LegValues {
  if (params.collateralPool < 0n) {
    throw new RangeError('Collateral pool K must be non-negative.');
  }
  const lr = leveragedDeviation(price, params.anchorPrice, params.leverage);
  const a = lr.n;
  const b = lr.d; // > 0 by Rational invariant
  const wLong = b + a;
  const wShort = b - a;
  if (wLong < 0n || wShort < 0n) {
    throw new RangeError(
      'Price is outside the barrier (|L·r| > 1): a leg would be negative — ' +
        'issuer-neutrality cannot hold. Use evaluate() to inspect the breach condition.',
    );
  }
  const [long, short] = allocate(params.collateralPool, [wLong, wShort]);
  return { long: long!, short: short! };
}

/** The issuer-neutral invariant over exact integers: `long + short === K`. */
export function invariantHolds(legs: LegValues, collateralPool: bigint): boolean {
  return legs.long + legs.short === collateralPool;
}

/** The floor f = m · L · g (all exact). */
export function floor(leverage: string, floorParams: FloorParams): Rational {
  return mul(mul(parseDecimal(floorParams.m), parseDecimal(leverage)), parseDecimal(floorParams.g));
}

/** The losing leg's remaining buffer, 1 − |L·r| (≤ 0 once the barrier is crossed). */
export function buffer(price: string, anchorPrice: string, leverage: string): Rational {
  return sub(ONE, abs(leveragedDeviation(price, anchorPrice, leverage)));
}

/**
 * Floor-breach detection: true when the losing leg's buffer (1 − |L·r|) has dropped to/below
 * the floor f = m·L·g — i.e. a threshold-only reset would fire. A gap PAST the floor (|L·r| ≥ 1)
 * also reports breached, because the buffer is then ≤ 0 ≤ f.
 */
export function floorBreached(
  price: string,
  params: Pick<PairParams, 'anchorPrice' | 'leverage'>,
  floorParams: FloorParams,
): boolean {
  return lte(
    buffer(price, params.anchorPrice, params.leverage),
    floor(params.leverage, floorParams),
  );
}

/** One-shot evaluation of the model at `price`: deviation, barrier, exact legs, invariant, floor. */
export function evaluate(params: PairParams, price: string, floorParams: FloorParams): Evaluation {
  const lr = leveragedDeviation(price, params.anchorPrice, params.leverage);
  const absLr = abs(lr);
  const crossed = gte(absLr, ONE); // |L·r| >= 1 ⇒ a leg is zero or negative
  const negativeLeg = cmp(absLr, ONE) > 0; // |L·r| > 1 ⇒ a leg is strictly negative
  const buf = sub(ONE, absLr);
  const f = floor(params.leverage, floorParams);
  const legs = negativeLeg ? null : legValues(params, price);
  return {
    r: referenceDeviation(price, params.anchorPrice),
    leveragedDeviation: lr,
    withinBarrier: !crossed,
    barrierCrossed: crossed,
    legWouldBeNegative: negativeLeg,
    legs,
    invariantHolds: legs !== null && invariantHolds(legs, params.collateralPool),
    buffer: buf,
    floor: f,
    floorBreached: lte(buf, f),
  };
}
