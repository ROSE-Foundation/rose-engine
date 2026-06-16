// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveFloorUnits, distanceToFloor, legsBalance, sumLegs } from './pair-math.js';

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
});
