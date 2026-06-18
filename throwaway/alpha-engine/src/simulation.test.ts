// THROWAWAY — Alpha Engine PoC (docs/alpha_engine_poc_v1.pdf) — main-loop tests.
// Covers the p_int(0) row, two-sided price movement (rises AND falls — no ratchet), the no-trade
// carry-drain invariant, bankruptcy removal + queued-order purge, param validation, and determinism.
import { describe, it, expect } from 'vitest';
import type { Params } from './params.js';
import { DEFAULT_PARAMS } from './params.js';
import { mulberry32 } from './rng.js';
import { runSimulation } from './simulation.js';

describe('runSimulation — default-params dynamics', () => {
  const result = runSimulation(DEFAULT_PARAMS, mulberry32(12345));
  const s = result.series;

  it('emits the initial p_int(0) row at tick 0 with total_capital = K and no trade', () => {
    const first = s[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.t).toBe(0);
      expect(first.pInt).toBe(DEFAULT_PARAMS.x0); // p_int(0) = x0
      expect(first.matchedVolume).toBe(0);
      expect(first.queueDepthLong + first.queueDepthShort).toBe(0);
      expect(first.aliveLong).toBe(DEFAULT_PARAMS.n);
      expect(first.aliveShort).toBe(DEFAULT_PARAMS.n);
      expect(first.totalCapital).toBeCloseTo(DEFAULT_PARAMS.K, 3); // Σ K0 = K at x0
    }
  });

  it('p_int both RISES and FALLS over the run (two-sided crossing, not a ratchet)', () => {
    let strictDecreases = 0;
    let strictIncreases = 0;
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1];
      const cur = s[i];
      if (!prev || !cur) continue;
      if (cur.pInt < prev.pInt - 1e-12) strictDecreases++;
      if (cur.pInt > prev.pInt + 1e-12) strictIncreases++;
    }
    // The whole point of removing the max(prev,…) floor: price must be able to fall, not only rise.
    expect(strictDecreases).toBeGreaterThan(0);
    expect(strictIncreases).toBeGreaterThan(0);
  });

  it('the carry mechanism drains the pool over the run (total_capital strictly falls end-to-end)', () => {
    const first = s[0];
    const last = s[s.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first && last) expect(last.totalCapital).toBeLessThan(first.totalCapital);
  });

  it('is deterministic: same seed ⇒ identical series', () => {
    const again = runSimulation(DEFAULT_PARAMS, mulberry32(12345));
    expect(again.series.length).toBe(s.length);
    expect(again.series[0]).toEqual(s[0]);
    expect(again.series[again.series.length - 1]).toEqual(s[s.length - 1]);
  });
});

describe('runSimulation — no-trade tick carry drain', () => {
  // f=1.0 ⇒ each agent holds ONLY its home leg (longs all-EUR, shorts all-BTC); dBase huge ⇒ no
  // firing ⇒ no orders ever ⇒ NO trade clears on any tick and p_int stays flat at x0. The only flow
  // is the carry drain, so on every (no-trade) tick total_capital falls by EXACTLY the summed carry
  // c·total_capital(t-1) — i.e. total_capital(t) = total_capital(t-1)·(1-c). This replaces the old
  // monotone-drain test that was silently restricted to flat-price ticks.
  const noTrade: Params = {
    n: 5,
    K: 1000,
    x0: 1,
    alpha: 1.5,
    xMin: 20,
    f: 1.0,
    c: 0.001,
    dBase: 1e9,
    q: 16,
    W: 5,
    epsilon: 0.2,
    T: 50,
  };

  it('every tick is a no-trade tick: total_capital drops by exactly the summed carry', () => {
    const result = runSimulation(noTrade, mulberry32(1));
    const s = result.series;
    expect(s.length).toBeGreaterThan(2);
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1];
      const cur = s[i];
      if (!prev || !cur) continue;
      // No trade this tick: price unchanged and nothing matched.
      expect(cur.matchedVolume).toBe(0);
      expect(cur.pInt).toBe(prev.pInt);
      // Strict drain by exactly the summed carry: total(t) = total(t-1)·(1 - c).
      const summedCarry = noTrade.c * prev.totalCapital;
      expect(cur.totalCapital).toBeCloseTo(prev.totalCapital - summedCarry, 6);
      expect(cur.totalCapital).toBeLessThan(prev.totalCapital);
    }
  });
});

describe('runSimulation — bankruptcy removal & termination', () => {
  // No firing (d_base huge) and home-only agents (f=1 ⇒ zero away-leg) with a heavy carry, so the
  // sole leg drains to ≤ ε and every agent dies ⇒ all-dead termination.
  const forced: Params = {
    n: 5,
    K: 1000,
    x0: 1,
    alpha: 1.5,
    xMin: 20,
    f: 1.0,
    c: 0.5,
    dBase: 1e9,
    q: 16,
    W: 5,
    epsilon: 0.2,
    T: 100,
  };

  it('removes agents whose K ≤ ε and terminates all-dead', () => {
    const result = runSimulation(forced, mulberry32(1));
    expect(result.reason).toBe('all-dead');
    expect(result.finalTick).toBeLessThan(forced.T);
    const last = result.series[result.series.length - 1];
    expect(last).toBeDefined();
    if (last) {
      expect(last.aliveLong + last.aliveShort).toBe(0);
      expect(last.queueDepthLong + last.queueDepthShort).toBe(0); // no orders survive dead agents
    }
  });

  it('alive count is monotone non-increasing (no resurrection)', () => {
    const result = runSimulation(forced, mulberry32(1));
    const s = result.series;
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1];
      const cur = s[i];
      if (!prev || !cur) continue;
      expect(cur.aliveLong).toBeLessThanOrEqual(prev.aliveLong);
      expect(cur.aliveShort).toBeLessThanOrEqual(prev.aliveShort);
    }
  });
});

describe('runSimulation — partial mortality with a live order queue', () => {
  // Heavier carry + a moderate ε kill the smallest agents over time while orders stand in the queue,
  // so deaths and a non-empty order queue coexist — exercising removal + queued-order purge.
  const partial: Params = {
    n: 20,
    K: 200_000,
    x0: 1,
    alpha: 1.5,
    xMin: 400,
    f: 0.9,
    c: 0.005,
    dBase: 1.0,
    q: 8,
    W: 5,
    epsilon: 300,
    T: 3000,
  };

  it('queues orders, removes agents that hit ε, and never resurrects them', () => {
    const result = runSimulation(partial, mulberry32(9));
    const s = result.series;

    const maxQueue = Math.max(...s.map((r) => r.queueDepthLong + r.queueDepthShort));
    expect(maxQueue).toBeGreaterThan(0);

    const startAlive = (s[0]?.aliveLong ?? 0) + (s[0]?.aliveShort ?? 0);
    const endAlive = (s[s.length - 1]?.aliveLong ?? 0) + (s[s.length - 1]?.aliveShort ?? 0);
    expect(endAlive).toBeLessThan(startAlive);
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1];
      const cur = s[i];
      if (!prev || !cur) continue;
      expect(cur.aliveLong).toBeLessThanOrEqual(prev.aliveLong);
      expect(cur.aliveShort).toBeLessThanOrEqual(prev.aliveShort);
    }
  });
});

describe('runSimulation — param validation', () => {
  const base = DEFAULT_PARAMS;
  it('throws on non-positive x0, xMin, alpha, or q', () => {
    expect(() => runSimulation({ ...base, x0: 0 }, mulberry32(1))).toThrow(/x0/);
    expect(() => runSimulation({ ...base, xMin: -1 }, mulberry32(1))).toThrow(/xMin/);
    expect(() => runSimulation({ ...base, alpha: 0 }, mulberry32(1))).toThrow(/alpha/);
    expect(() => runSimulation({ ...base, q: -5 }, mulberry32(1))).toThrow(/q/);
  });

  it('accepts the shipped defaults without throwing', () => {
    expect(() => runSimulation({ ...base, T: 1 }, mulberry32(1))).not.toThrow();
  });
});
