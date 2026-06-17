// THROWAWAY (Story 7.2, FR-16) — threshold-only rebalancing simulator.
//
// Load-bearing consequences (AC #2, #3, #4, #6):
//   • A reset fires ONLY on a floor breach — NEVER on a time interval (proven two ways: a long
//     flat series spanning years fires nothing, and identical prices with different timestamps
//     produce identical resets ⇒ the engine ignores time).
//   • At a reset the current values are LOCKED, P₀ RE-ANCHORS to the breaching price, and the
//     losing holder's loss is LOCKED.
//   • EUR/USD (barrier ~100% away) ⇒ 0 resets; BTC (higher-vol stress) ⇒ ≥ 1 reset.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { type FloorParams, loadFloorParams } from '../../coupled-math/src/index.js';
import { loadTicksFromFile, parseTicks, simulate } from './index.js';

// f = m·L·g. With f = 0.05 at L=1, a reset needs buffer 1−|r| ≤ 0.05 ⇒ |r| ≥ 0.95 (a ~95% move).
const fpTight: FloorParams = { m: '1', g: '0.05' };
// With f = 0.30 a reset needs |r| ≥ 0.70 (a ~70% move) — crossed by the BTC drawdown, never by EUR/USD.
const fpWide: FloorParams = { m: '1', g: '0.30' };

const K = 1000n;
const baseConfig = { initialAnchorPrice: '100', leverage: '1', collateralPool: K, floorParams: fpTight };

describe('threshold-only reset — fires on a floor breach (AC #2, #4)', () => {
  it('locks current values, re-anchors P₀, and locks the losing holder loss at the breaching tick', () => {
    // P=196 ⇒ r=0.96, buffer=0.04 ≤ f=0.05 ⇒ breach; price up ⇒ SHORT is the losing leg.
    const result = simulate(parseTicks('t0,150\nt1,196'), baseConfig);
    expect(result.resets.length).toBe(1);
    const reset = result.resets[0]!;
    expect(reset.tickIndex).toBe(1); // fired at the breaching tick, not the comfortable t0=150
    expect(reset.losingLeg).toBe('short');
    // Locked current values are the exact integer legs at P=196 (long + short === K).
    expect(reset.lockedLong).toBe(980n);
    expect(reset.lockedShort).toBe(20n);
    expect(reset.lockedLong + reset.lockedShort).toBe(K);
    // P₀ re-anchors to the breaching price.
    expect(reset.newAnchorPrice).toBe('196');
    expect(reset.anchorBefore).toBe('100');
    expect(result.finalAnchorPrice).toBe('196');
    // Losing holder's loss = neutral K/2 (500) − locked losing-leg value (20) = 480.
    expect(reset.lockedLoss).toBe(480n);
    expect(reset.gapPastFloor).toBe(false);
  });

  it('does NOT reset while price stays within the floor buffer (not-crossed set, AC #6)', () => {
    // r ∈ {0.10, −0.10, 0.50}: buffers 0.90/0.90/0.50 ≫ f=0.05 ⇒ no breach.
    const result = simulate(parseTicks('t0,110\nt1,90\nt2,150'), baseConfig);
    expect(result.resets).toEqual([]);
    expect(result.finalAnchorPrice).toBe('100'); // anchor never moved
  });
});

describe('NEVER reset on a time interval — the FR-16 invariant (AC #3)', () => {
  it('fires zero resets over a long, flat series no matter how much time elapses', () => {
    // Constant price (r=0, buffer=1) across timestamps spanning years.
    const csv = ['2000-01-01,100', '2010-06-15,100', '2020-12-31,100', '2099-01-01,100'].join('\n');
    expect(simulate(parseTicks(csv), baseConfig).resets).toEqual([]);
  });

  it('produces identical resets for the same prices under wildly different timestamps (time is ignored)', () => {
    const pricesA = parseTicks('2026-01-01T00:00:00Z,150\n2026-01-01T00:00:01Z,196'); // 1 second apart
    const pricesB = parseTicks('1900-01-01,150\n2500-12-31,196'); // 600 years apart
    const ra = simulate(pricesA, baseConfig).resets;
    const rb = simulate(pricesB, baseConfig).resets;
    // Strip the reporting-only timestamp; everything that DRIVES the reset must be identical.
    const drivers = (r: (typeof ra)[number]) => ({
      tickIndex: r.tickIndex,
      price: r.price,
      losingLeg: r.losingLeg,
      lockedLong: r.lockedLong,
      lockedShort: r.lockedShort,
      lockedLoss: r.lockedLoss,
      newAnchorPrice: r.newAnchorPrice,
      gapPastFloor: r.gapPastFloor,
    });
    expect(ra.map(drivers)).toEqual(rb.map(drivers));
    expect(ra.length).toBe(1);
  });
});

describe('re-base after reset — fresh neutral cycle at the new anchor (AC #5)', () => {
  it('re-anchors so the next within-buffer tick does not re-fire, then fires again vs the new anchor', () => {
    // P=200 ⇒ r=1 (barrier): short leg = 0, buffer 0 ≤ f ⇒ breach #1 (short). Re-anchor → 200.
    // P=200 again ⇒ r=0 vs the new anchor ⇒ NO re-fire (proves the re-base). P=8 ⇒ r=−0.96 vs 200
    // ⇒ buffer 0.04 ≤ f ⇒ breach #2 (long).
    const result = simulate(parseTicks('t0,200\nt1,200\nt2,8'), baseConfig);
    expect(result.resets.length).toBe(2);
    const [first, second] = result.resets;
    expect(first!.tickIndex).toBe(0);
    expect(first!.losingLeg).toBe('short');
    expect(first!.lockedShort).toBe(0n);
    expect(first!.lockedLong).toBe(K);
    expect(first!.newAnchorPrice).toBe('200');
    // The repeated 200 (tick 1) did NOT fire — only ticks 0 and 2 did.
    expect(second!.tickIndex).toBe(2);
    expect(second!.anchorBefore).toBe('200'); // measured against the NEW anchor
    expect(second!.losingLeg).toBe('long');
    expect(second!.lockedLong + second!.lockedShort).toBe(K);
    expect(result.finalAnchorPrice).toBe('8');
  });
});

describe('gap PAST the floor — issuer-neutrality break condition (recorded; proven in 7.3)', () => {
  it('flags gapPastFloor and clamps the losing leg to 0 when a single jump crosses the barrier', () => {
    // P=250 ⇒ L·r=1.5 (gap past barrier): no non-negative split ⇒ losing SHORT wiped to 0.
    const result = simulate(parseTicks('t0,250'), baseConfig);
    expect(result.resets.length).toBe(1);
    const reset = result.resets[0]!;
    expect(reset.gapPastFloor).toBe(true);
    expect(reset.losingLeg).toBe('short');
    expect(reset.lockedShort).toBe(0n);
    expect(reset.lockedLong).toBe(K);
    expect(reset.lockedLoss).toBe(500n); // the whole losing half (K/2) is lost
  });
});

describe('historical fixtures — EUR/USD vs BTC under the SAME floor (AC #1, #3, #6)', () => {
  const fixture = (name: string) =>
    loadTicksFromFile(fileURLToPath(new URL(`../fixtures/${name}.csv`, import.meta.url)));

  it('EUR/USD at L=1 fires ZERO resets with a plausible floor', () => {
    const result = simulate(fixture('eurusd'), {
      initialAnchorPrice: '1.0850',
      leverage: '1',
      collateralPool: K,
      floorParams: fpWide,
    });
    expect(result.resets).toEqual([]);
  });

  it('BTC at L=1 fires at least one reset (higher-vol stress of the same invariant)', () => {
    const result = simulate(fixture('btc'), {
      initialAnchorPrice: '60000',
      leverage: '1',
      collateralPool: K,
      floorParams: fpWide,
    });
    expect(result.resets.length).toBeGreaterThanOrEqual(1);
    const first = result.resets[0]!;
    expect(first.losingLeg).toBe('long'); // a drawdown ⇒ the long leg loses
    expect(first.anchorBefore).toBe('60000');
    expect(first.price).toBe('16000'); // the tick that crossed the floor
  });
});

describe('floor params are refuse-if-absent (reused from 7.1, no defaulting)', () => {
  it('refuses to build a config floor when m/g are absent', () => {
    expect(() => loadFloorParams({})).toThrow();
  });
});

describe('refuses a degenerate floor f = m·L·g ≥ 1 — no phantom resets (AC #2)', () => {
  it('throws instead of firing a reset on every tick (incl. r = 0 where no leg is losing)', () => {
    // f = 1·1·1 = 1 ≥ 1 ⇒ buffer ≤ 1 ≤ f on every tick. Without the guard this would emit a
    // phantom reset at the neutral point and mislabel the losing leg.
    const degenerate = {
      initialAnchorPrice: '100',
      leverage: '1',
      collateralPool: K,
      floorParams: { m: '1', g: '1' } as FloorParams,
    };
    expect(() => simulate(parseTicks('t0,100\nt1,100'), degenerate)).toThrow(RangeError);
  });
});
