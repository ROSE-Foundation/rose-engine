// THROWAWAY — a deterministic, seeded SAMPLE price series for exercising the Delta Engine.
//
// The package's emergent-price market (p_int) is a sticky step function (long flat plateaus, a few
// violent jumps) — structurally a poor showcase for a directional-change trading strategy. For the
// demo asset we therefore synthesise a richer, FX-like price path that produces directional changes
// at every scale. It is a multi-scale mean-reverting geometric walk driven ONLY by the package's
// seeded PRNG (mulberry32) — NO Math.random — so it reproduces bit-for-bit from a seed.
//
// (run-delta.ts ALSO runs the Delta Engine on the genuine emergent p_int, demonstrating that the
// strategy can trade the package's own market; this fixture is purely for a legible visualisation.)
//
// REGIME: lives under /throwaway, Node stdlib only.
import { mulberry32 } from './rng.js';

/**
 * Builds a deterministic length-`n` price series from `seed`. A slowly-varying momentum term layered
 * over per-tick noise and a gentle pull back toward the anchor price yields reversals across multiple
 * δ scales (so all DC scales see activity, and breakouts/silencing fire).
 */
export function sampleSeries(seed: number, n: number, anchor = 1): number[] {
  const rng = mulberry32(seed);
  const prices: number[] = [];
  let logP = Math.log(anchor);
  let momentum = 0;
  const logAnchor = Math.log(anchor);
  for (let i = 0; i < n; i++) {
    // slow, persistent momentum (autoregressive) — the source of multi-scale trends
    momentum = momentum * 0.985 + (rng() - 0.5) * 0.0016;
    // per-tick noise + a weak mean-reversion toward the anchor keeps the path bounded
    const noise = (rng() - 0.5) * 0.004;
    const revert = (logAnchor - logP) * 0.01;
    logP += momentum + noise + revert;
    prices.push(Math.exp(logP));
  }
  return prices;
}
