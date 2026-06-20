// THROWAWAY — tests for the deterministic seeded sample price series.
import { describe, it, expect } from 'vitest';
import { sampleSeries } from './sample-series.js';
import { decomposeDc } from './delta-engine.js';

describe('sampleSeries', () => {
  it('is deterministic: same seed ⇒ identical series', () => {
    expect(sampleSeries(12345, 200)).toEqual(sampleSeries(12345, 200));
  });

  it('differs across seeds', () => {
    expect(sampleSeries(1, 200)).not.toEqual(sampleSeries(2, 200));
  });

  it('emits strictly-positive prices of the requested length', () => {
    const s = sampleSeries(7, 150);
    expect(s).toHaveLength(150);
    expect(s.every((p) => p > 0 && Number.isFinite(p))).toBe(true);
  });

  it('has multi-scale directional-change structure (events at every default scale)', () => {
    const prices = sampleSeries(12345, 1200);
    for (const d of [0.0025, 0.005, 0.01, 0.02]) {
      expect(decomposeDc(prices, d).length).toBeGreaterThan(0);
    }
  });
});
