// The directional-change (intrinsic-time) price-path generator: deterministic for a fixed seed, bounded
// strictly within the ±amplitude envelope, and produces at least one directional-change reversal over a
// cycle (so the path is genuinely event-driven, NOT a monotonic drift or a pure clock-based sine).
import { describe, expect, it } from 'vitest';
import { buildDirectionalChangeSeries } from './directional-change.js';

const ANCHOR = 1.1;
const STEPS = 120;
const AMPLITUDE = 0.07;
const DELTA = 0.01;

function nums(series: { price: string }[]): number[] {
  return series.map((p) => Number(p.price));
}

/** Count sign changes in the step-to-step diffs — each is a local reversal (a directional change). */
function reversals(values: number[]): number {
  let count = 0;
  let prevSign = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) count++;
    if (sign !== 0) prevSign = sign;
  }
  return count;
}

describe('buildDirectionalChangeSeries', () => {
  it('is deterministic — the same seed + params yield the exact same series', () => {
    const a = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: AMPLITUDE,
      dcThreshold: DELTA,
      seed: 12345,
    });
    const b = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: AMPLITUDE,
      dcThreshold: DELTA,
      seed: 12345,
    });
    expect(a).toEqual(b);
    expect(a).toHaveLength(STEPS);
    // A different seed yields a different path (so distinct markets diverge).
    const c = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: AMPLITUDE,
      dcThreshold: DELTA,
      seed: 67890,
    });
    expect(c).not.toEqual(a);
  });

  it('emits strictly-positive 8-dp decimal strings (NFR-2)', () => {
    const series = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: AMPLITUDE,
      dcThreshold: DELTA,
      seed: 7,
    });
    for (const point of series) {
      expect(point.price).toMatch(/^\d+\.\d{8}$/);
      expect(Number(point.price)).toBeGreaterThan(0);
    }
  });

  it('stays strictly within the ±amplitude envelope around the anchor', () => {
    const series = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: AMPLITUDE,
      dcThreshold: DELTA,
      seed: 999,
    });
    const lo = ANCHOR * (1 - AMPLITUDE);
    const hi = ANCHOR * (1 + AMPLITUDE);
    for (const v of nums(series)) {
      // Tiny epsilon for 8-dp rounding; the extreme is allowed to touch the band exactly.
      expect(v).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(v).toBeLessThanOrEqual(hi + 1e-6);
    }
  });

  it('produces at least one directional-change reversal over a cycle (event-driven, not monotonic)', () => {
    // Robust across seeds: the asset hash drives the seed in production, so every market must reverse.
    for (const seed of [1, 2, 3, 42, 100, 65535]) {
      const series = buildDirectionalChangeSeries({
        anchor: ANCHOR,
        steps: STEPS,
        amplitude: AMPLITUDE,
        dcThreshold: DELTA,
        seed,
      });
      expect(reversals(nums(series))).toBeGreaterThanOrEqual(1);
    }
  });

  it('loops with no jump — the first and last samples coincide (palindrome closure)', () => {
    const series = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: AMPLITUDE,
      dcThreshold: DELTA,
      seed: 555,
    });
    expect(series[0]!.price).toBe(series[series.length - 1]!.price);
  });

  it('a zero amplitude collapses to a flat feed at the anchor', () => {
    const series = buildDirectionalChangeSeries({
      anchor: ANCHOR,
      steps: STEPS,
      amplitude: 0,
      dcThreshold: DELTA,
      seed: 3,
    });
    for (const point of series) {
      expect(point.price).toBe(ANCHOR.toFixed(8));
    }
  });
});
