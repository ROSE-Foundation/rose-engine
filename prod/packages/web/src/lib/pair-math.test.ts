// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  deriveFloorUnits,
  distanceToFloor,
  legsAtPrice,
  legsBalance,
  sumLegs,
} from './pair-math.js';

describe('pair-math (exact BigInt, no float)', () => {
  it('sums the legs and checks the V_A + V_B = K conservation invariant', () => {
    expect(sumLegs('10000', '10000')).toBe(20000n);
    expect(legsBalance('10000', '10000', '20000')).toBe(true);
    expect(legsBalance('5000', '15000', '20000')).toBe(true);
    expect(legsBalance('5000', '14000', '20000')).toBe(false);
  });

  it('derives floorUnits = floor((K/2) * f) exactly from the decimal floor ratio', () => {
    // K=20000 ⇒ K/2=10000; f=0.6 ⇒ 6000 (matches the backend 6.4 fixture).
    expect(deriveFloorUnits('20000', '0.6')).toBe(6000n);
    expect(deriveFloorUnits('20000', '0.55')).toBe(5500n);
    expect(deriveFloorUnits('20001', '0.6')).toBe(6000n); // K/2 floors to 10000
  });

  it('computes distance-to-floor from the losing leg (≤ 0 = breached)', () => {
    expect(distanceToFloor('10000', '10000', '20000', '0.6')).toBe(4000n);
    expect(distanceToFloor('5000', '15000', '20000', '0.6')).toBe(-1000n);
  });

  describe('legsAtPrice (mark-to-market simulation)', () => {
    // K=1_000_000, floor 0.10 ⇒ floorUnits = (K/2)*0.10 = 50_000; legs clamp to [50_000, 950_000].
    const K = '1000000';

    it('keeps longLeg + shortLeg = K exactly at every price across the range (incl. clamped region)', () => {
      // L=1 never hits the floor within ±15%; L=7 drives the short leg into the floor clamp well
      // inside the range — both must still conserve K exactly.
      for (const leverage of ['1', '7']) {
        for (let bps = -1500; bps <= 1500; bps += 10) {
          const { longLeg, shortLeg } = legsAtPrice(K, leverage, '0.10', bps);
          expect(longLeg + shortLeg).toBe(BigInt(K));
        }
      }
    });

    it('is delta-neutral at the anchor (50/50) and diverges in opposite directions', () => {
      expect(legsAtPrice(K, '1', '0.10', 0)).toEqual({ longLeg: 500_000n, shortLeg: 500_000n });
      // +10% at L=1: short = K/2·(1−0.10)=450k, long = 550k.
      expect(legsAtPrice(K, '1', '0.10', 1000)).toEqual({ longLeg: 550_000n, shortLeg: 450_000n });
      // −10%: mirror.
      expect(legsAtPrice(K, '1', '0.10', -1000)).toEqual({ longLeg: 450_000n, shortLeg: 550_000n });
    });

    it('clamps the losing leg at the floor (never below) while preserving the invariant', () => {
      // L=2, +45%: short = K/2·(1−0.90)=50k = floor exactly; long = 950k.
      expect(legsAtPrice(K, '2', '0.10', 4500)).toEqual({ longLeg: 950_000n, shortLeg: 50_000n });
      // L=2, +80% would drive short below floor ⇒ clamped to 50k, long 950k, sum still K.
      const past = legsAtPrice(K, '2', '0.10', 8000);
      expect(past).toEqual({ longLeg: 950_000n, shortLeg: 50_000n });
      expect(past.longLeg + past.shortLeg).toBe(BigInt(K));
    });
  });
});
