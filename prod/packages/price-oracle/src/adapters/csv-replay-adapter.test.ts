import { describe, expect, it } from 'vitest';
import { CsvReplayPriceOracle, parseReplayCsv } from './csv-replay-adapter.js';
import type { PriceOracle } from '../price-oracle.js';

const CSV = `# EUR/USD replay ticks (timestamp,price)
timestamp,price
2026-01-02T09:00:00Z,1.0850
2026-01-02T10:00:00Z,1.0862

2026-01-02T11:00:00Z,1.0841
`;

describe('parseReplayCsv', () => {
  it('tolerates header, comment, and blank lines; keeps decimal-string prices', () => {
    const ticks = parseReplayCsv(CSV);
    expect(ticks).toHaveLength(3);
    expect(ticks[0]!.price).toBe('1.0850');
    expect(ticks[0]!.asOf.toISOString()).toBe('2026-01-02T09:00:00.000Z');
    expect(ticks[2]!.price).toBe('1.0841');
  });

  it('fails loud on a malformed / non-positive / float-shaped price (NFR-2)', () => {
    expect(() => parseReplayCsv('t,price\n2026-01-02T09:00:00Z,-5')).toThrow(SyntaxError);
    expect(() => parseReplayCsv('t,price\n2026-01-02T09:00:00Z,0')).toThrow(SyntaxError);
    expect(() => parseReplayCsv('t,price\n2026-01-02T09:00:00Z,1e3')).toThrow(SyntaxError);
    expect(() => parseReplayCsv('2026-01-02T09:00:00Z')).toThrow(SyntaxError);
    expect(() => parseReplayCsv('t,price\nnot-a-date,1.08')).toThrow(SyntaxError);
  });
});

describe('CsvReplayPriceOracle — read-only replay (FR-24)', () => {
  it('returns the latest tick at or before the replay clock', async () => {
    const oracle = CsvReplayPriceOracle.fromCsv('EUR/USD', CSV, {
      now: new Date('2026-01-02T10:30:00Z'),
    });
    const quote = await oracle.getPrice('EUR/USD');
    expect(quote).not.toBeNull();
    expect(quote!.price).toBe('1.0862');
    expect(quote!.asOf.toISOString()).toBe('2026-01-02T10:00:00.000Z');
    expect(quote!.source).toBe('csv-replay');
    expect(quote!.referenceAsset).toBe('EUR/USD');
  });

  it('advances deterministically via setNow (no wall clock)', async () => {
    const oracle = CsvReplayPriceOracle.fromCsv('EUR/USD', CSV, {
      now: new Date('2026-01-02T09:00:00Z'),
    });
    expect((await oracle.getPrice('EUR/USD'))!.price).toBe('1.0850');
    oracle.setNow(new Date('2026-01-02T11:59:00Z'));
    expect((await oracle.getPrice('EUR/USD'))!.price).toBe('1.0841');
  });

  it('returns null for an unknown asset, an empty feed, and a clock before the first tick', async () => {
    const oracle = CsvReplayPriceOracle.fromCsv('EUR/USD', CSV, {
      now: new Date('2026-01-02T08:00:00Z'),
    });
    expect(await oracle.getPrice('BTC')).toBeNull(); // unknown asset
    expect(await oracle.getPrice('EUR/USD')).toBeNull(); // clock before first tick
    const empty = new CsvReplayPriceOracle({ BTC: [] });
    expect(await empty.getPrice('BTC')).toBeNull(); // empty feed
  });

  it('is substitutable behind the PriceOracle port (NFR-8)', async () => {
    // Any object satisfying the read-only port is a drop-in; the port has no write method.
    const fake: PriceOracle = {
      source: 'fake',
      getPrice: () =>
        Promise.resolve({
          referenceAsset: 'BTC',
          price: '60000',
          asOf: new Date('2026-01-02T00:00:00Z'),
          source: 'fake',
        }),
    };
    const real: PriceOracle = CsvReplayPriceOracle.fromCsv(
      'BTC',
      't,price\n2026-01-02T00:00:00Z,60000',
      {
        now: new Date('2026-01-02T01:00:00Z'),
      },
    );
    for (const oracle of [fake, real]) {
      const quote = await oracle.getPrice('BTC');
      expect(quote!.price).toBe('60000');
    }
  });
});
