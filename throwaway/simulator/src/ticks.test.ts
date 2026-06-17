// THROWAWAY (Story 7.2, FR-16) — CSV `timestamp,price` ingestion.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadTicksFromFile, parseTicks } from './index.js';

describe('parseTicks', () => {
  it('parses `timestamp,price` lines in order, keeping prices as decimal strings (NFR-2)', () => {
    const ticks = parseTicks('2026-01-01T00:00:00Z,100\n2026-01-01T01:00:00Z,101.5\n');
    expect(ticks).toEqual([
      { timestamp: '2026-01-01T00:00:00Z', price: '100' },
      { timestamp: '2026-01-01T01:00:00Z', price: '101.5' },
    ]);
    // Prices stay strings — never coerced to JS number.
    expect(typeof ticks[0]!.price).toBe('string');
  });

  it('skips a header row, blank lines, and # comments', () => {
    const csv = ['# a comment', 'timestamp,price', '', '2026-01-01,100', '  ', '2026-01-02,200'].join(
      '\n',
    );
    expect(parseTicks(csv)).toEqual([
      { timestamp: '2026-01-01', price: '100' },
      { timestamp: '2026-01-02', price: '200' },
    ]);
  });

  it('tolerates epoch-style timestamps and accepts the first data line when its price is decimal', () => {
    expect(parseTicks('1735689600,100\n1735693200,99.25')).toEqual([
      { timestamp: '1735689600', price: '100' },
      { timestamp: '1735693200', price: '99.25' },
    ]);
  });

  it('rejects a malformed (non timestamp,price) line', () => {
    expect(() => parseTicks('2026-01-01,100\nGARBAGE_NO_COMMA')).toThrow(SyntaxError);
  });

  it('rejects a non-decimal / float-NaN price after the header (fail loud, never drop a tick)', () => {
    expect(() => parseTicks('timestamp,price\n2026-01-01,100\n2026-01-02,NaN')).toThrow(SyntaxError);
    expect(() => parseTicks('timestamp,price\n2026-01-01,-5')).toThrow(SyntaxError);
    expect(() => parseTicks('timestamp,price\n2026-01-01,0')).toThrow(SyntaxError);
  });

  it('rejects an empty timestamp', () => {
    expect(() => parseTicks('2026-01-01,100\n,200')).toThrow(SyntaxError);
  });

  it('fails loud on a malformed FIRST data row — never swallows numeric corruption as a header', () => {
    // A header-less file whose very first row has a corrupt (digit-bearing) price must throw,
    // not be silently dropped as if it were a header (the module's own "fail loud" contract).
    expect(() => parseTicks('2026-01-01,-5\n2026-01-02,100')).toThrow(SyntaxError);
    expect(() => parseTicks('2026-01-01,0')).toThrow(SyntaxError);
    expect(() => parseTicks('2026-01-01,1.2.3')).toThrow(SyntaxError);
    expect(() => parseTicks('2026-01-01,1,000')).toThrow(SyntaxError);
    // A genuine non-numeric header label (no digits) is still tolerated.
    expect(parseTicks('timestamp,price\n2026-01-01,100')).toEqual([
      { timestamp: '2026-01-01', price: '100' },
    ]);
  });
});

describe('loadTicksFromFile (fixtures)', () => {
  it('loads the EUR/USD fixture', () => {
    const ticks = loadTicksFromFile(fileURLToPath(new URL('../fixtures/eurusd.csv', import.meta.url)));
    expect(ticks.length).toBe(12);
    expect(ticks[0]).toEqual({ timestamp: '2026-01-02T09:00:00Z', price: '1.0850' });
  });

  it('loads the BTC fixture', () => {
    const ticks = loadTicksFromFile(fileURLToPath(new URL('../fixtures/btc.csv', import.meta.url)));
    expect(ticks.length).toBe(12);
    expect(ticks[0]).toEqual({ timestamp: '2026-01-01T00:00:00Z', price: '60000' });
  });
});
