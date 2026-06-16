// Unit tests for the wire serializers (Story 6.1, NFR-2). Pure — NO DB. Proves bigint→exact integer
// string, Date→ISO, and that NO `bigint` and NO JS `number` money value escapes (every monetary
// value crosses as a string).
import type { CoupledPairView, RoseNoteView } from '@rose/ledger';
import { describe, expect, it } from 'vitest';
import { serializeCoupledPair, serializeRoseNote } from './serializers.js';

const PAIR: CoupledPairView = {
  id: '11111111-1111-1111-1111-111111111111',
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.10000000',
  leverage: '3',
  collateralPool: 1_000_000_000n,
  floor: '0.50',
  longLegValue: 500_000_000n,
  shortLegValue: 500_000_000n,
  state: 'ACTIVE',
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  updatedAt: new Date('2026-06-16T01:02:03.000Z'),
};

const NOTE: RoseNoteView = {
  id: '22222222-2222-2222-2222-222222222222',
  coupledPairId: PAIR.id,
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  updatedAt: new Date('2026-06-16T00:00:00.000Z'),
};

// Recursively assert NO bigint anywhere in the serialized payload (NFR-2 — bigint must not escape).
function assertNoBigint(value: unknown, path = '$'): void {
  expect(typeof value, `${path} must not be a bigint`).not.toBe('bigint');
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
  }
}

describe('serializeCoupledPair', () => {
  const out = serializeCoupledPair(PAIR);

  it('renders smallest-unit magnitudes as EXACT integer strings (no float)', () => {
    expect(out.collateralPool).toBe('1000000000');
    expect(out.longLegValue).toBe('500000000');
    expect(out.shortLegValue).toBe('500000000');
    expect(typeof out.collateralPool).toBe('string');
  });

  it('passes decimal fields through as their stored decimal strings', () => {
    expect(out.anchorPrice).toBe('1.10000000');
    expect(out.leverage).toBe('3');
    expect(out.floor).toBe('0.50');
  });

  it('renders timestamps as ISO-8601 strings and keeps the state enum', () => {
    expect(out.createdAt).toBe('2026-06-16T00:00:00.000Z');
    expect(out.updatedAt).toBe('2026-06-16T01:02:03.000Z');
    expect(out.state).toBe('ACTIVE');
  });

  it('lets NO bigint escape and round-trips through JSON.stringify', () => {
    assertNoBigint(out);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('preserves a magnitude beyond Number.MAX_SAFE_INTEGER exactly (no precision loss)', () => {
    const big = serializeCoupledPair({ ...PAIR, collateralPool: 9_007_199_254_740_993n });
    expect(big.collateralPool).toBe('9007199254740993');
  });
});

describe('serializeRoseNote', () => {
  it('renders ids and ISO timestamps, no bigint', () => {
    const out = serializeRoseNote(NOTE);
    expect(out).toEqual({
      id: NOTE.id,
      coupledPairId: NOTE.coupledPairId,
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    assertNoBigint(out);
  });
});
