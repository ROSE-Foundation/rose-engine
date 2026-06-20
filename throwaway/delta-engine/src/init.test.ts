// THROWAWAY — Delta Engine PoC (docs/alpha_engine_poc_v1.pdf) — initialisation tests.
// Covers §4 (per-side rescale to K/2, balance init) and §7 (d_i ∝ K0_i, the firing-frequency law).
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from './params.js';
import { mulberry32 } from './rng.js';
import { initAgents, k0Min } from './init.js';

describe('initAgents', () => {
  it('creates 2n agents (n per side)', () => {
    const agents = initAgents(DEFAULT_PARAMS, mulberry32(1));
    expect(agents).toHaveLength(2 * DEFAULT_PARAMS.n);
    expect(agents.filter((a) => a.side === 'LONG')).toHaveLength(DEFAULT_PARAMS.n);
    expect(agents.filter((a) => a.side === 'SHORT')).toHaveLength(DEFAULT_PARAMS.n);
  });

  it('rescales each side to sum exactly K/2 in EUR terms', () => {
    const agents = initAgents(DEFAULT_PARAMS, mulberry32(7));
    const sumSide = (side: 'LONG' | 'SHORT'): number =>
      agents.filter((a) => a.side === side).reduce((s, a) => s + a.K0, 0);
    expect(sumSide('LONG')).toBeCloseTo(DEFAULT_PARAMS.K / 2, 3);
    expect(sumSide('SHORT')).toBeCloseTo(DEFAULT_PARAMS.K / 2, 3);
  });

  it('opens balances so eur + btc·x0 = K0 (longs EUR-heavy, shorts BTC-heavy)', () => {
    const agents = initAgents(DEFAULT_PARAMS, mulberry32(3));
    for (const a of agents) {
      expect(a.eur + a.btc * DEFAULT_PARAMS.x0).toBeCloseTo(a.K0, 6);
      if (a.side === 'LONG') expect(a.eur).toBeGreaterThan(a.btc * DEFAULT_PARAMS.x0);
      else expect(a.btc * DEFAULT_PARAMS.x0).toBeGreaterThan(a.eur);
    }
  });

  it('scales the firing threshold with capital: d_i ∝ K0_i (⇒ larger fires proportionally rarer)', () => {
    const agents = initAgents(DEFAULT_PARAMS, mulberry32(11));
    const min = k0Min(agents);
    // d_i = d_base·(K0_i/K0_min): the smallest agent has d = d_base; the ratio d_i/d_j == K0_i/K0_j.
    for (const a of agents) {
      expect(a.d).toBeCloseTo(DEFAULT_PARAMS.dBase * (a.K0 / min), 9);
    }
    // An agent with 4× the capital has 4× the threshold ⇒ fires every (d/c) ticks ⇒ ~4× rarer.
    const sorted = [...agents].sort((x, y) => x.K0 - y.K0);
    const small = sorted[0];
    const big = sorted[sorted.length - 1];
    expect(small).toBeDefined();
    expect(big).toBeDefined();
    if (small && big) {
      const k0Ratio = big.K0 / small.K0;
      const dRatio = big.d / small.d;
      // Firing period ∝ d (period = ceil(d/c)), so the threshold ratio IS the rarity ratio.
      expect(dRatio).toBeCloseTo(k0Ratio, 9);
    }
  });
});
