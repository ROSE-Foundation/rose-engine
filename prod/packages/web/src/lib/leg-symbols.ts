/**
 * Deterministic synthetic leg-token symbols for a coupled market's reference asset:
 * `'EUR/USD' → { long: 'rEURUSD-L', short: 'rEURUSD-S' }`. A pure derivation of REAL identifiers
 * (the `r…-L` / `r…-S` convention) — not fabricated market data. The asset is upper-cased so a
 * lowercase input still yields the canonical `r<ASSET>` form.
 */
export function legTokenSymbols(referenceAsset: string): { long: string; short: string } {
  const base = `r${referenceAsset.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
  return { long: `${base}-L`, short: `${base}-S` };
}
