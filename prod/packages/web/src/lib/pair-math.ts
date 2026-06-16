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
