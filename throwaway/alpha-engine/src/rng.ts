// THROWAWAY — Alpha Engine PoC (docs/alpha_engine_poc_v1.pdf). Seedable PRNG + Pareto sampler.
//
// Determinism is a Boundary constraint: a seeded PRNG makes runs and tests reproduce exactly.
// mulberry32 is a tiny, well-distributed 32-bit generator — adequate for an R&D market sim.
//
// REGIME: lives under /throwaway, Node stdlib only.

/** A pseudo-random generator: each call returns a float in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — a deterministic 32-bit PRNG seeded by a single integer.
 * Same seed ⇒ identical stream, so a run (and its tests) reproduce bit-for-bit.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws one Pareto(xMin, alpha) sample from a uniform `u` in [0, 1) via inverse-CDF.
 *
 * For the Pareto CDF F(x) = 1 - (xMin/x)^alpha, the inverse is x = xMin · u^(-1/alpha) (u and
 * 1-u are both uniform, so we use u directly). Result is always ≥ xMin — many small values, a
 * heavy tail of large ones, matching the spec's "many small agents, few large" (§4).
 */
export function paretoSample(xMin: number, alpha: number, u: number): number {
  // Guard u against 0 (mulberry32 can emit exactly 0), which would blow up to Infinity.
  const uu = u <= 0 ? Number.EPSILON : u;
  return xMin / Math.pow(uu, 1 / alpha);
}
