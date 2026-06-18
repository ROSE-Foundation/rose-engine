// Exact integer-units arithmetic for the Coupled-Pair surface (NFR-2 — NO float, NO `number` money
// math). All inputs are the contract's smallest-units integer strings + the decimal `floor` ratio
// string; all outputs are `bigint`. Mirrors the backend `deriveFloorUnits` convention
// (`floorUnits = ⌊(K/2)·f⌋`) so the surface shows the SAME threshold the executor enforces.

/** Parse a non-negative decimal string into (mantissa, fractionDigits) — e.g. "0.60" → (60n, 2). */
function parseDecimal(value: string): { mantissa: bigint; fractionDigits: number } {
  const [intPart, fracPart = ''] = value.split('.');
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return { mantissa: BigInt(digits === '' ? '0' : digits), fractionDigits: fracPart.length };
}

/** Sum the two leg values (V_A + V_B) exactly. */
export function sumLegs(longLegValue: string, shortLegValue: string): bigint {
  return BigInt(longLegValue) + BigInt(shortLegValue);
}

/** True when V_A + V_B === K (the issuer-neutral conservation invariant). */
export function legsBalance(
  longLegValue: string,
  shortLegValue: string,
  collateralPool: string,
): boolean {
  return sumLegs(longLegValue, shortLegValue) === BigInt(collateralPool);
}

/** `floorUnits = ⌊(K/2)·f⌋` — the floor threshold in smallest units, exact. */
export function deriveFloorUnits(collateralPool: string, floor: string): bigint {
  const halfK = BigInt(collateralPool) / 2n;
  const { mantissa, fractionDigits } = parseDecimal(floor);
  return (halfK * mantissa) / 10n ** BigInt(fractionDigits);
}

/** Distance from the lower (losing) leg to the floor threshold; ≤ 0 means breached. */
export function distanceToFloor(
  longLegValue: string,
  shortLegValue: string,
  collateralPool: string,
  floor: string,
): bigint {
  const losing =
    BigInt(longLegValue) < BigInt(shortLegValue) ? BigInt(longLegValue) : BigInt(shortLegValue);
  return losing - deriveFloorUnits(collateralPool, floor);
}

/**
 * Pedagogical leg revaluation for the walkthrough's mark-to-market simulation. Given the collateral
 * `K`, the `leverage` L, the `floor` ratio, and a price move `priceChangeBps` (basis points off the
 * anchor P₀), returns the two leg values such that the issuer-neutral conservation invariant
 * `longLeg + shortLeg = K` holds EXACTLY and neither leg falls below the floor. Pure integer (bigint)
 * math — NO float money (NFR-2).
 *
 * Model: `shortLeg = (K/2)·(1 − L·r)` with `r = priceChangeBps/10000`, then clamp `shortLeg` to
 * `[floorUnits, K − floorUnits]` and set `longLeg = K − shortLeg`. The authoritative Epic-7 reference
 * math lives in `/throwaway` (which `/prod` must not import); this mirrors that invariant for the UI.
 */
export function legsAtPrice(
  collateralPool: string,
  leverage: string,
  floor: string,
  priceChangeBps: number,
): { longLeg: bigint; shortLeg: bigint } {
  const k = BigInt(collateralPool);
  const floorUnits = deriveFloorUnits(collateralPool, floor);
  // Leverage as integer milli-units (e.g. "2.5" → 2500) for exact arithmetic.
  const { mantissa, fractionDigits } = parseDecimal(leverage);
  const lMilli = (mantissa * 1000n) / 10n ** BigInt(fractionDigits);
  const rBps = BigInt(Math.round(priceChangeBps));
  // shortLeg = K/2·(1 − L·r), r = rBps/10000 ⇒ K·(10_000_000 − lMilli·rBps) / 20_000_000.
  let shortLeg = (k * (10_000_000n - lMilli * rBps)) / 20_000_000n;
  const lo = floorUnits;
  const hi = k - floorUnits;
  if (shortLeg < lo) shortLeg = lo;
  if (shortLeg > hi) shortLeg = hi;
  return { longLeg: k - shortLeg, shortLeg };
}
