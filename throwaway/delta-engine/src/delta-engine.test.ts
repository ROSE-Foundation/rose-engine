// THROWAWAY — tests for the Delta Engine trading strategy (paper §5). Deterministic + seedable.
import { describe, it, expect } from 'vitest';
import {
  computeSilencedFlags,
  decideTrade,
  decomposeDc,
  deltaToCsv,
  deltaToJson,
  fitLine,
  lineAt,
  opposite,
  runDeltaEngine,
  type ExecState,
} from './delta-engine.js';

/** A deterministic multi-frequency price series (fast ripple over a slow swing). */
function multiFreqSeries(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(100 + 12 * Math.sin(i / 40) + 4 * Math.sin(i / 3.3) + 1.5 * Math.sin(i / 1.7));
  }
  return out;
}

describe('directional-change operator (§5.1 multi-scale intrinsic time)', () => {
  it('decomposes a known series into the expected reversals + overshoot extrema', () => {
    // up to 110, reverse down (>2%) confirmed at idx2 → peak (1,110); down to 100, reverse up
    // confirmed at idx4 → trough (3,100).
    const events = decomposeDc([100, 110, 107, 100, 113], 0.02);
    expect(events.map((e) => e.direction)).toEqual(['down', 'up']);
    expect(events[0]!.extreme).toEqual({ index: 1, price: 110 });
    expect(events[1]!.extreme).toEqual({ index: 3, price: 100 });
  });

  it('is δ-monotone: a larger threshold never yields MORE directional changes', () => {
    const prices: number[] = [];
    for (let i = 0; i < 800; i++) {
      prices.push(100 * Math.exp(0.0008 * i + 0.03 * Math.sin(i / 7) + 0.012 * Math.sin(i / 2.3)));
    }
    const counts = [0.005, 0.01, 0.02, 0.04, 0.08].map((d) => decomposeDc(prices, d).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('rejects a non-positive threshold', () => {
    expect(() => decomposeDc([1, 2], 0)).toThrow();
  });
});

describe('decision landscapes (§5.2 support/resistance fits)', () => {
  it('fits a RISING resistance line to an up-trend of peaks', () => {
    const line = fitLine([
      { index: 0, price: 100 },
      { index: 5, price: 110 },
      { index: 10, price: 120 },
    ]);
    expect(line).not.toBeNull();
    expect(line!.slope).toBeGreaterThan(0);
    expect(lineAt(line!, 15)).toBeCloseTo(130, 6);
  });

  it('fits a FALLING support line to a down-trend of troughs, and a lower price breaches it', () => {
    const sup = fitLine([
      { index: 0, price: 100 },
      { index: 5, price: 98 },
      { index: 10, price: 96 },
    ])!;
    expect(sup.slope).toBeLessThan(0);
    const supportAt12 = lineAt(sup, 12);
    // A price below the fitted support line is a downward breakout (breach of support).
    expect(94 < supportAt12).toBe(true);
  });

  it('returns null for no points and a flat line for a single point', () => {
    expect(fitLine([])).toBeNull();
    expect(fitLine([{ index: 3, price: 42 }])).toEqual({ slope: 0, intercept: 42 });
  });
});

describe('breakout signals (§5.3) over a run', () => {
  it('produces up AND down breakouts and records representative support/resistance', () => {
    const result = runDeltaEngine({ prices: multiFreqSeries(700) });
    const dirs = new Set(
      result.series.flatMap((r) => r.scales.map((s) => s.breakout).filter((b) => b !== null)),
    );
    expect(dirs.has('up')).toBe(true);
    expect(dirs.has('down')).toBe(true);
    // At least some ticks have a fitted resistance and support to breach.
    expect(result.series.some((r) => r.scales.some((s) => s.resistance !== null))).toBe(true);
    expect(result.series.some((r) => r.scales.some((s) => s.support !== null))).toBe(true);
  });
});

describe('contrarian rule + ±u execution (§5.4 + §5.6)', () => {
  it('opens a contrarian u: an up breakout from flat goes SHORT (−u)', () => {
    const d = decideTrade({ pos: 0, initiatingDir: null }, { up: true, down: false, coarsest: 'up' }, 1);
    expect(d.exec).toEqual({ dir: 'up', side: 'SELL', size: 1, reason: 'open' });
    expect(d.next).toEqual({ pos: -1, initiatingDir: 'up' });
  });

  it('IGNORES a trend-continuation breakout (same direction as the initiating trend)', () => {
    const short: ExecState = { pos: -1, initiatingDir: 'up' };
    const d = decideTrade(short, { up: true, down: false, coarsest: 'up' }, 1);
    expect(d.exec).toBeNull();
    expect(d.next).toEqual(short); // position unchanged
  });

  it('only a REVERSAL breakout trades, flipping with an offsetting 2u', () => {
    const short: ExecState = { pos: -1, initiatingDir: 'up' };
    const d = decideTrade(short, { up: false, down: true, coarsest: 'down' }, 1);
    expect(d.exec).toEqual({ dir: 'down', side: 'BUY', size: 2, reason: 'reversal' });
    expect(d.next).toEqual({ pos: 1, initiatingDir: 'down' });
  });

  it('keeps net exposure ALWAYS in {+u, 0, −u} over a run, flipping only via 2u', () => {
    const u = 3;
    const result = runDeltaEngine({ prices: multiFreqSeries(700), u });
    for (const row of result.series) {
      expect([u, 0, -u]).toContain(row.netExposure);
    }
    expect(result.summary.maxAbsExposure).toBe(u);
    for (const t of result.trades) {
      expect(t.size === u || t.size === 2 * u).toBe(true);
      if (t.reason === 'reversal') expect(t.size).toBe(2 * u);
      else expect(t.size).toBe(u);
      expect([u, -u]).toContain(t.netExposureAfter);
    }
  });
});

describe('feedback loop — DC-count silencing (§5.5)', () => {
  it('silences a scale whose DC count is out of sync with the others, none when on-law', () => {
    const thresholds = [0.0025, 0.005, 0.01, 0.02];
    // Clean power-law-like counts (monotone) → nobody out of sync.
    expect(computeSilencedFlags(thresholds, [40, 20, 10, 5], 1.25)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // A gross outlier at the coarsest scale (80 where ~5 is implied) → it is silenced.
    expect(computeSilencedFlags(thresholds, [40, 20, 10, 80], 1.25)[3]).toBe(true);
  });

  it('does not silence with fewer than three active scales (law under-determined)', () => {
    expect(computeSilencedFlags([0.0025, 0.005, 0.01], [10, 0, 0], 0.1)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('silences ≥1 agent on ≥1 tick over a suitable multi-frequency fixture', () => {
    const result = runDeltaEngine({ prices: multiFreqSeries(700), silenceTolerance: 0.5 });
    expect(result.summary.silencedTickCount).toBeGreaterThan(0);
    expect(result.series.some((r) => r.silencedScales > 0)).toBe(true);
  });
});

describe('PnL decoupling (§5.6 — no take-profit / stop-loss)', () => {
  it('holds a losing position through continuation breakouts; closes ONLY on a reversal', () => {
    // Open short on an up breakout, then feed many continuation up breakouts (price running AGAINST
    // the short): a PnL-target strategy would stop out, the Delta Engine does not trade at all.
    let st: ExecState = { pos: 0, initiatingDir: null };
    st = decideTrade(st, { up: true, down: false, coarsest: 'up' }, 1).next;
    expect(st.pos).toBe(-1);
    for (let k = 0; k < 50; k++) {
      const d = decideTrade(st, { up: true, down: false, coarsest: 'up' }, 1);
      expect(d.exec).toBeNull(); // never closes on a price/PnL move
      st = d.next;
    }
    expect(st.pos).toBe(-1);
    // The position changes ONLY when a contrarian reversal finally fires.
    const flip = decideTrade(st, { up: false, down: true, coarsest: 'down' }, 1);
    expect(flip.exec!.reason).toBe('reversal');
    expect(flip.next.pos).toBe(1);
  });
});

describe('determinism + serializers', () => {
  it('same config + same input ⇒ byte-identical output series', () => {
    const prices = multiFreqSeries(500);
    const a = deltaToJson(runDeltaEngine({ prices, seed: 99 }));
    const b = deltaToJson(runDeltaEngine({ prices, seed: 99 }));
    expect(a).toBe(b);
  });

  it('accepts a timestamp,price tick series and emits a CSV with one row per tick', () => {
    const ticks = multiFreqSeries(120).map((p, i) => ({ timestamp: `t${i}`, price: String(p) }));
    const result = runDeltaEngine({ ticks });
    const csv = deltaToCsv(result.series);
    const rows = csv.trimEnd().split('\n');
    expect(rows[0]).toContain('net_exposure');
    expect(rows.length).toBe(result.series.length + 1); // header + one row per tick
  });

  it('throws when no price source is supplied', () => {
    expect(() => runDeltaEngine({})).toThrow(/no price source/);
  });

  it('opposite() inverts a direction', () => {
    expect(opposite('up')).toBe('down');
    expect(opposite('down')).toBe('up');
  });
});
