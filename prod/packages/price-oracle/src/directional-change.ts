// @rose/price-oracle — directional-change (intrinsic-time) price-path generator.
//
// The project's own thesis (PRD §1/§4.7 — intrinsic time / directional change) says a realistic price
// path is event-driven, NOT clock-driven: rather than oscillating on a fixed period, the market alternates
// directional RUNS, overshooting until it reverses by a δ threshold (a directional-change event), then
// runs the other way. This module builds such a path around an anchor for the paper replay feed — a pure,
// deterministic, READ-ONLY function (no Math.random, no wall clock, writes nothing). It is a substitute
// for the clock-based sine; the money/mark logic is unchanged (it still consumes 8-dp decimal-string
// prices, NFR-2).
//
// Determinism: a small in-module SEEDED PRNG (mulberry32) keyed off a numeric `seed` (the paper oracle
// derives it from the asset name + settings) makes the same inputs always produce the same series.
//
// Bounded + looping: the raw δ-threshold random walk is rescaled so its extreme touches exactly
// ±`amplitude` (so the path never leaves the trust-band envelope the operator dialled, keeping the demo
// marks valid), and the series is built as a PALINDROME (out then mirrored back) so wall-clock replay can
// loop it end-to-start with no violent jump (the first and last samples coincide).

/** Inputs to {@link buildDirectionalChangeSeries}. */
export interface DirectionalChangeParams {
  /** The pair anchor price P₀ the path oscillates around. */
  readonly anchor: number;
  /** The number of points in one full looping cycle (must be ≥ 2). */
  readonly steps: number;
  /** The fractional envelope: the path stays within ±`amplitude` of the anchor (0 ⇒ a flat feed). */
  readonly amplitude: number;
  /** The δ directional-change threshold (fraction): a reversal of ≥ δ flips the run direction. */
  readonly dcThreshold: number;
  /** The PRNG seed (deterministic — the same seed yields the same path). */
  readonly seed: number;
}

/** One generated point: a strictly-positive 8-dp decimal-string price (NFR-2). */
export interface DirectionalChangePoint {
  readonly price: string;
}

/** Fraction of a directional run that is trend-biased overshoot (vs symmetric noise). Shapes the runs. */
const OVERSHOOT_BIAS = 0.35;

/**
 * A small, fast, seedable PRNG (mulberry32). Deterministic and self-contained — NEVER `Math.random`, so
 * a given seed reproduces the exact same sequence. Returns a float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a directional-change (intrinsic-time) price path around `anchor`.
 *
 * The path is an intrinsic-time random walk: it accumulates directional moves (trend-biased so runs
 * overshoot); when the cumulative move retraces from the current run's extreme by ≥ `dcThreshold` (δ), a
 * directional-change event is registered and the run direction flips. The raw walk is then linearly
 * rescaled so its largest deviation equals exactly `amplitude` (keeping every point within ±`amplitude`
 * of the anchor — a linear rescale preserves the reversal structure), and laid out as a PALINDROME so the
 * series loops seamlessly (the first and last samples coincide — no jump when replay wraps).
 *
 * Pure + deterministic: same params ⇒ identical output; reads no clock and writes nothing.
 */
export function buildDirectionalChangeSeries(
  params: DirectionalChangeParams,
): DirectionalChangePoint[] {
  const { anchor, amplitude, dcThreshold, seed } = params;
  const steps = Math.max(2, Math.floor(params.steps));
  const rng = mulberry32(seed);

  // Generate the FIRST half of the cycle as a δ-threshold directional-change walk in relative space (a
  // fraction of the anchor). The second half mirrors it (palindrome) for a seamless loop.
  const halfLen = Math.ceil(steps / 2);
  const raw: number[] = [];
  let r = 0; // cumulative relative deviation from the anchor
  let dir = 1; // current run direction (+1 up, -1 down)
  let extreme = 0; // the run's most-favourable deviation since the last directional change
  for (let i = 0; i < halfLen; i++) {
    const noise = rng() * 2 - 1; // symmetric noise in [-1, 1)
    r += (noise + OVERSHOOT_BIAS * dir) * dcThreshold; // trend-biased step (overshoot)
    if (dir === 1) {
      if (r > extreme) {
        extreme = r; // still running up — extend the overshoot
      } else if (extreme - r >= dcThreshold) {
        dir = -1; // retraced ≥ δ from the up-extreme ⇒ directional change → down run
        extreme = r;
      }
    } else {
      if (r < extreme) {
        extreme = r; // still running down
      } else if (r - extreme >= dcThreshold) {
        dir = 1; // retraced ≥ δ from the down-extreme ⇒ directional change → up run
        extreme = r;
      }
    }
    raw.push(r);
  }

  // Lay out the full cycle as a palindrome (out then mirrored back). `idx` walks 0…halfLen-1 then mirrors
  // back toward 0, so the cycle's first and last samples are identical ⇒ replay loops with no jump.
  const relative: number[] = [];
  for (let i = 0; i < steps; i++) {
    const idx = i < halfLen ? i : steps - 1 - i;
    relative.push(raw[idx]!);
  }

  // Rescale so the largest absolute deviation is exactly `amplitude` — the path then fills, but never
  // leaves, the ±amplitude envelope. A linear scale preserves every directional-change reversal.
  let maxAbs = 0;
  for (const v of relative) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? amplitude / maxAbs : 0;

  return relative.map((v) => ({ price: (anchor * (1 + v * scale)).toFixed(8) }));
}
