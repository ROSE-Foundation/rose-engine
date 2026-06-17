// THROWAWAY (Story 7.1, FR-15) — coupled-coin reference math + issuer-neutral invariant.
//
// The load-bearing assertion is `long + short === K` over EXACT smallest-unit integers across
// a price grid within the barrier (SM-2: issuer net = 0), plus no-negative-leg, floor-breach
// detection, and the explicit gap-PAST-the-floor case (the key model-risk condition under
// which issuer-neutrality can break).
import { describe, expect, it } from 'vitest';
import {
  type FloorParams,
  type PairParams,
  buffer,
  evaluate,
  floor,
  floorBreached,
  invariantHolds,
  legValues,
  leveragedDeviation,
  referenceDeviation,
  withinBarrier,
} from './index.js';
import { cmp, parseDecimal } from './rational.js';

// Both P0 pairs run at L=1 in P0 validation (EUR/USD, BTC); leverage is read per-pair, never
// hard-coded — we also cover a non-unit L to prove that.
const fp: FloorParams = { m: '1', g: '0.05' }; // f = m·L·g

describe('referenceDeviation / leveragedDeviation', () => {
  it('computes r = (P − P₀)/P₀ exactly', () => {
    expect(referenceDeviation('150', '100')).toEqual({ n: 1n, d: 2n }); // +0.5
    expect(referenceDeviation('110', '100')).toEqual({ n: 1n, d: 10n }); // +0.1
    expect(referenceDeviation('90', '100')).toEqual({ n: -1n, d: 10n }); // -0.1
  });

  it('scales by per-pair leverage L', () => {
    expect(leveragedDeviation('150', '100', '2')).toEqual({ n: 1n, d: 1n }); // 2·0.5 = 1
  });

  it('refuses a zero anchor', () => {
    expect(() => referenceDeviation('100', '0')).toThrow(RangeError);
  });
});

describe('issuer-neutral invariant V_A + V_B = K (exact, within the barrier) — SM-2', () => {
  // A representative grid of K values incl. odd and tiny pools, to stress the largest-
  // remainder residual policy (one leg absorbs the odd unit; the sum stays exact).
  const collateralPools: bigint[] = [
    1_000_000n,
    999_999n, // odd
    7n, // tiny — extreme rounding pressure
    1_000_000_000_000_000_000n, // 18-decimal token magnitude (BigInt, not float)
  ];

  it('holds exactly across a price grid within the barrier at L=1 (EUR/USD, BTC)', () => {
    const anchorPrice = '100';
    const leverage = '1'; // barrier |r| < 1 ⇒ price in (0, 200)
    for (const collateralPool of collateralPools) {
      const params: PairParams = { anchorPrice, leverage, collateralPool };
      for (let price = 1; price <= 199; price++) {
        const priceStr = String(price);
        expect(withinBarrier(priceStr, anchorPrice, leverage)).toBe(true);
        const legs = legValues(params, priceStr);
        // Exact integer invariant — the whole point (no binary float here).
        expect(legs.long + legs.short).toBe(collateralPool);
        expect(invariantHolds(legs, collateralPool)).toBe(true);
        // No leg negative while within the barrier (AC #3).
        expect(legs.long >= 0n).toBe(true);
        expect(legs.short >= 0n).toBe(true);
      }
    }
  });

  it('holds exactly across the (tighter) barrier at a non-unit L=2', () => {
    const anchorPrice = '100';
    const leverage = '2'; // barrier |r| < 0.5 ⇒ price in (50, 150)
    const collateralPool = 999_999n;
    const params: PairParams = { anchorPrice, leverage, collateralPool };
    for (let price = 51; price <= 149; price++) {
      const priceStr = String(price);
      expect(withinBarrier(priceStr, anchorPrice, leverage)).toBe(true);
      const legs = legValues(params, priceStr);
      expect(legs.long + legs.short).toBe(collateralPool);
      expect(legs.long >= 0n && legs.short >= 0n).toBe(true);
    }
  });

  it('matches the closed-form V_A=(K/2)(1+L·r), V_B=(K/2)(1−L·r) on a worked example', () => {
    // P0=100, P=150, L=1, K=1000 → V_A=750, V_B=250.
    const legs = legValues({ anchorPrice: '100', leverage: '1', collateralPool: 1000n }, '150');
    expect(legs).toEqual({ long: 750n, short: 250n });
  });

  it('puts the odd residual unit on one leg only, never breaking the sum', () => {
    // r=0 ⇒ equal weights; odd K ⇒ one leg gets the extra unit, sum stays exact.
    const legs = legValues({ anchorPrice: '100', leverage: '1', collateralPool: 7n }, '100');
    expect(legs.long + legs.short).toBe(7n);
    expect(legs.long - legs.short).toBe(1n); // long absorbs the residual (deterministic policy)
  });
});

describe('barrier boundary', () => {
  it('at |L·r| = 1 the losing leg is exactly 0 (not negative) and the invariant still holds', () => {
    const params: PairParams = { anchorPrice: '100', leverage: '1', collateralPool: 1000n };
    // P=200 ⇒ r=1 ⇒ short leg = 0.
    expect(withinBarrier('200', '100', '1')).toBe(false); // boundary is not "within"
    const legs = legValues(params, '200');
    expect(legs).toEqual({ long: 1000n, short: 0n });
    expect(invariantHolds(legs, 1000n)).toBe(true);
  });

  it('throws when asked for legs past the barrier (|L·r| > 1)', () => {
    const params: PairParams = { anchorPrice: '100', leverage: '1', collateralPool: 1000n };
    expect(() => legValues(params, '250')).toThrow(RangeError); // r=1.5 ⇒ short would be negative
  });
});

describe('floor f = m·L·g and breach detection (AC #4, #5)', () => {
  it('computes f = m · L · g exactly (scales with per-pair L)', () => {
    expect(floor('1', fp)).toEqual(parseDecimal('0.05')); // 1·1·0.05
    expect(floor('2', fp)).toEqual(parseDecimal('0.1')); // 1·2·0.05
  });

  it('does NOT flag a breach with a comfortable buffer', () => {
    // P=150 ⇒ r=0.5, buffer=0.5 ≫ f=0.05.
    expect(cmp(buffer('150', '100', '1'), floor('1', fp))).toBe(1);
    expect(floorBreached('150', { anchorPrice: '100', leverage: '1' }, fp)).toBe(false);
  });

  it('flags a breach when the buffer 1−|L·r| drops to/below the floor', () => {
    // P=196 ⇒ r=0.96, buffer=0.04 ≤ f=0.05 ⇒ breach (still within the barrier).
    expect(withinBarrier('196', '100', '1')).toBe(true);
    expect(floorBreached('196', { anchorPrice: '100', leverage: '1' }, fp)).toBe(true);
  });
});

describe('gap PAST the floor — the key model-risk condition (AC #5)', () => {
  it('reports barrier-crossed, would-be-negative-leg and floor breach; legs are unrepresentable', () => {
    const params: PairParams = { anchorPrice: '100', leverage: '1', collateralPool: 1000n };
    // A single jump to P=250 ⇒ L·r=1.5 (gap past the floor before a reset could fire).
    const ev = evaluate(params, '250', fp);
    expect(ev.barrierCrossed).toBe(true);
    expect(ev.legWouldBeNegative).toBe(true); // issuer-neutrality CANNOT hold here
    expect(ev.legs).toBeNull(); // no non-negative integer split exists ⇒ V_A+V_B=K cannot be posted
    expect(ev.invariantHolds).toBe(false);
    expect(ev.floorBreached).toBe(true); // buffer = 1−1.5 = −0.5 ≤ f
    expect(cmp(ev.buffer, parseDecimal('0'))).toBe(-1); // buffer is negative
  });

  it('a within-barrier evaluation yields a posted, invariant-holding split', () => {
    const params: PairParams = { anchorPrice: '100', leverage: '1', collateralPool: 1000n };
    const ev = evaluate(params, '150', fp);
    expect(ev.withinBarrier).toBe(true);
    expect(ev.barrierCrossed).toBe(false);
    expect(ev.legs).toEqual({ long: 750n, short: 250n });
    expect(ev.invariantHolds).toBe(true);
    expect(ev.floorBreached).toBe(false);
  });
});
