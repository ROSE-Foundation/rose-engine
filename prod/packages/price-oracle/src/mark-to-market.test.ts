import { describe, expect, it } from 'vitest';
import { CsvReplayPriceOracle } from './adapters/csv-replay-adapter.js';
import {
  InvalidMarkInputError,
  MarkOptionsError,
  markToMarket,
  type MarkOptions,
  type MarkablePair,
} from './mark-to-market.js';
import type { PriceOracle, PriceQuote } from './price-oracle.js';

// A representative issued pair: P₀ = 1.00, L = 1, K = 1_000_000 smallest units, floor f = 0.10.
const PAIR: MarkablePair = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.00',
  leverage: '1',
  collateralPool: 1_000_000n,
  floor: '0.10',
};

const AS_OF = new Date('2026-01-02T10:00:00Z');

function quote(price: string, asOf: Date = AS_OF): PriceQuote {
  return { referenceAsset: 'EUR/USD', price, asOf, source: 'csv-replay', sequence: 7 };
}

// Fresh, generous divergence band, clock pinned to the quote so age = 0.
const OPTS: MarkOptions = { freshnessBoundMs: 60_000, maxRelativeDivergence: '0.50', now: AS_OF };

describe('markToMarket — OK path from real pair params (FR-24, NFR-2)', () => {
  it('at entry P₀ both legs are K/2 and unrealized P&L is zero', () => {
    const m = markToMarket(PAIR, quote('1.00'), OPTS);
    expect(m.status).toBe('OK');
    expect(m.entryPrice).toBe('1.00');
    expect(m.markPrice).toBe('1.00');
    expect(m.legsAtPrice).toEqual({ long: 500_000n, short: 500_000n });
    expect(m.entryLegs).toEqual({ long: 500_000n, short: 500_000n });
    expect(m.unrealizedPnl).toEqual({ long: 0n, short: 0n });
    expect(m.floorBreached).toBe(false);
    expect(m.flags).toEqual([]);
  });

  it('prices legs + delta-neutral P&L from the real params', () => {
    const m = markToMarket(PAIR, quote('1.05'), OPTS);
    expect(m.status).toBe('OK');
    // V_A=(K/2)(1+L·r), V_B=(K/2)(1−L·r), r=0.05 ⇒ 525000 / 475000.
    expect(m.legsAtPrice).toEqual({ long: 525_000n, short: 475_000n });
    expect(m.unrealizedPnl).toEqual({ long: 25_000n, short: -25_000n });
    // Invariants: legs sum to K; P&L is delta-neutral (sums to 0).
    expect(m.legsAtPrice!.long + m.legsAtPrice!.short).toBe(PAIR.collateralPool);
    expect(m.unrealizedPnl!.long + m.unrealizedPnl!.short).toBe(0n);
    expect(m.distanceToFloor).toBe('0.85000000'); // buffer 0.95 − floor 0.10
    expect(m.floorBreached).toBe(false);
  });

  it('carries provenance + freshness (age) on the mark', () => {
    const m = markToMarket(PAIR, quote('1.02', new Date('2026-01-02T09:59:30Z')), OPTS);
    expect(m.status).toBe('OK');
    expect(m.provenance).toEqual({
      source: 'csv-replay',
      asOf: new Date('2026-01-02T09:59:30Z'),
      sequence: 7,
    });
    expect(m.freshnessBoundMs).toBe(60_000);
    expect(m.ageMs).toBe(30_000);
  });

  it('reports floorBreached when the buffer reaches the floor (a real param, not a fabrication)', () => {
    // price 0.10 ⇒ r=-0.9, buffer 0.10 = floor 0.10 ⇒ breached; still a valid OK mark.
    const m = markToMarket(PAIR, quote('0.10'), { ...OPTS, maxRelativeDivergence: '0.95' });
    expect(m.status).toBe('OK');
    expect(m.legsAtPrice).toEqual({ long: 50_000n, short: 950_000n });
    expect(m.legsAtPrice!.long + m.legsAtPrice!.short).toBe(PAIR.collateralPool);
    expect(m.unrealizedPnl!.long + m.unrealizedPnl!.short).toBe(0n);
    expect(m.distanceToFloor).toBe('0.00000000');
    expect(m.floorBreached).toBe(true);
  });
});

describe('markToMarket — never fabricates a mark (§15 oracle integrity)', () => {
  it('absent feed ⇒ explicit NO_FEED with no trusted P&L', () => {
    const m = markToMarket(PAIR, null, OPTS);
    expect(m.status).toBe('NO_FEED');
    expect(m.flags).toEqual(['NO_FEED']);
    expect(m.markPrice).toBeNull();
    expect(m.provenance).toBeNull();
    expect(m.ageMs).toBeNull();
    expect(m.legsAtPrice).toBeNull();
    expect(m.unrealizedPnl).toBeNull();
    expect(m.distanceToFloor).toBeNull();
    expect(m.floorBreached).toBeNull();
    // The entry/floor pair params are still surfaced (they are not oracle-derived).
    expect(m.entryPrice).toBe('1.00');
    expect(m.floor).toBe('0.10');
  });

  it('a price past the freshness bound ⇒ explicit STALE, price surfaced but P&L not trusted', () => {
    const stale = markToMarket(PAIR, quote('1.05', new Date('2026-01-02T09:58:00Z')), OPTS); // 120s old > 60s
    expect(stale.status).toBe('STALE');
    expect(stale.flags).toContain('STALE');
    expect(stale.ageMs).toBe(120_000);
    expect(stale.markPrice).toBe('1.05'); // surfaced for transparency…
    expect(stale.legsAtPrice).toBeNull(); // …but never a silently-stale P&L
    expect(stale.unrealizedPnl).toBeNull();
  });

  it('an implausibly divergent figure (|r| past the band) ⇒ DIVERGENT, flagged not trusted', () => {
    const m = markToMarket(PAIR, quote('2.00'), OPTS); // r = 1.0 > maxDiv 0.50
    expect(m.status).toBe('DIVERGENT');
    expect(m.flags).toContain('DIVERGENT');
    expect(m.markPrice).toBe('2.00');
    expect(m.legsAtPrice).toBeNull();
    expect(m.unrealizedPnl).toBeNull();
  });

  it('a beyond-barrier figure (|L·r| > 1 ⇒ a leg would be negative) ⇒ DIVERGENT even inside the band', () => {
    // r = 2.0 is < a wide band of 10, but |L·r| = 2 > 1 ⇒ never trusted as a live mark.
    const m = markToMarket(PAIR, quote('3.00'), { ...OPTS, maxRelativeDivergence: '10' });
    expect(m.status).toBe('DIVERGENT');
    expect(m.legsAtPrice).toBeNull();
  });

  it('an invalid feed price is flagged INVALID_PRICE / DIVERGENT, never parsed-into-trust', () => {
    expect(markToMarket(PAIR, quote('0'), OPTS).flags).toContain('INVALID_PRICE');
    expect(markToMarket(PAIR, { ...quote('1'), price: 'abc' }, OPTS).status).toBe('DIVERGENT');
    expect(markToMarket(PAIR, quote('0'), OPTS).legsAtPrice).toBeNull();
  });

  it('STALE takes headline precedence when a quote is both stale and divergent (both flagged)', () => {
    const m = markToMarket(PAIR, quote('2.00', new Date('2026-01-02T09:58:00Z')), OPTS);
    expect(m.status).toBe('STALE');
    expect(m.flags).toEqual(expect.arrayContaining(['STALE', 'DIVERGENT']));
    expect(m.legsAtPrice).toBeNull();
  });

  it('divergence is symmetric — a price below the anchor past the band is also DIVERGENT', () => {
    // price 0.40 ⇒ r = −0.6, |r| = 0.6 > maxDiv 0.50.
    const m = markToMarket(PAIR, quote('0.40'), OPTS);
    expect(m.status).toBe('DIVERGENT');
    expect(m.legsAtPrice).toBeNull();
  });
});

describe('markToMarket — barrier boundary (|L·r| = 1 is valid, not fabricated)', () => {
  it('at exactly |L·r| = 1 the losing leg is 0, the mark is OK, and the floor is breached', () => {
    // price 2.00, P₀ 1.00, L 1 ⇒ r = 1, |L·r| = 1 (NOT > 1 ⇒ not divergent under a band of 1).
    const m = markToMarket(PAIR, quote('2.00'), { ...OPTS, maxRelativeDivergence: '1' });
    expect(m.status).toBe('OK');
    expect(m.legsAtPrice).toEqual({ long: 1_000_000n, short: 0n }); // loser leg exactly 0
    expect(m.legsAtPrice!.long + m.legsAtPrice!.short).toBe(PAIR.collateralPool);
    expect(m.unrealizedPnl!.long + m.unrealizedPnl!.short).toBe(0n);
    expect(m.floorBreached).toBe(true); // buffer 0 ≤ floor 0.10
  });
});

describe('markToMarket — fail-closed trust inputs (§15, NFR-4)', () => {
  it('rejects a missing/negative/NaN freshness bound (never defaulted)', () => {
    // @ts-expect-error — omitting the required trust input
    expect(() => markToMarket(PAIR, quote('1'), { maxRelativeDivergence: '0.5' })).toThrow(
      MarkOptionsError,
    );
    expect(() => markToMarket(PAIR, quote('1'), { ...OPTS, freshnessBoundMs: -1 })).toThrow(
      MarkOptionsError,
    );
    expect(() => markToMarket(PAIR, quote('1'), { ...OPTS, freshnessBoundMs: Number.NaN })).toThrow(
      MarkOptionsError,
    );
  });

  it('rejects a missing/invalid/non-positive divergence band (never defaulted)', () => {
    // @ts-expect-error — omitting the required trust input
    expect(() => markToMarket(PAIR, quote('1'), { freshnessBoundMs: 1000 })).toThrow(
      MarkOptionsError,
    );
    expect(() => markToMarket(PAIR, quote('1'), { ...OPTS, maxRelativeDivergence: '0' })).toThrow(
      MarkOptionsError,
    );
    expect(() => markToMarket(PAIR, quote('1'), { ...OPTS, maxRelativeDivergence: '1e3' })).toThrow(
      MarkOptionsError,
    );
  });
});

describe('markToMarket — invalid pair params fail loud', () => {
  it('rejects a non-positive anchor / leverage and a negative collateral pool', () => {
    expect(() => markToMarket({ ...PAIR, anchorPrice: '0' }, quote('1'), OPTS)).toThrow(
      InvalidMarkInputError,
    );
    expect(() => markToMarket({ ...PAIR, leverage: '0' }, quote('1'), OPTS)).toThrow(
      InvalidMarkInputError,
    );
    expect(() => markToMarket({ ...PAIR, floor: '-0.1' }, quote('1'), OPTS)).toThrow(
      InvalidMarkInputError,
    );
    expect(() => markToMarket({ ...PAIR, collateralPool: -1n }, quote('1'), OPTS)).toThrow(
      InvalidMarkInputError,
    );
  });
});

describe('markToMarket — substitutable oracle, unchanged caller (NFR-8)', () => {
  it('prices the same from a CSV/replay adapter and from a fake feed', async () => {
    const real: PriceOracle = CsvReplayPriceOracle.fromCsv(
      'EUR/USD',
      't,price\n2026-01-02T10:00:00Z,1.05',
      { now: AS_OF },
    );
    const fake: PriceOracle = {
      source: 'fake',
      getPrice: () => Promise.resolve(quote('1.05')),
    };
    // Identical caller code regardless of which adapter supplies the quote.
    for (const oracle of [real, fake]) {
      const q = await oracle.getPrice('EUR/USD');
      const m = markToMarket(PAIR, q, OPTS);
      expect(m.status).toBe('OK');
      expect(m.legsAtPrice).toEqual({ long: 525_000n, short: 475_000n });
    }
  });
});
