import { describe, expect, it } from 'vitest';
import {
  addMoney,
  allocate,
  assertNotFloat,
  fromDecimalString,
  knownScaleOf,
  money,
  negateMoney,
  splitInTwo,
  subMoney,
  toDecimalString,
  KNOWN_ASSET_SCALES,
} from './money.js';

describe('asset scales', () => {
  it('exposes known scales (EUR=2, BTC=8)', () => {
    expect(KNOWN_ASSET_SCALES.EUR).toBe(2);
    expect(KNOWN_ASSET_SCALES.BTC).toBe(8);
    expect(knownScaleOf('EUR')).toBe(2);
    expect(knownScaleOf('BTC')).toBe(8);
  });

  it('refuses an unknown asset (never guesses/defaults a scale)', () => {
    expect(() => knownScaleOf('XYZ')).toThrow(/unknown asset/i);
  });
});

describe('money() constructor', () => {
  it('stores an integer bigint in smallest units with the asset scale', () => {
    const m = money('EUR', 1234n);
    expect(m).toEqual({ asset: 'EUR', scale: 2, amount: 1234n });
  });

  it('accepts an explicit scale for tokens (decimals() supplied by caller)', () => {
    const m = money('TKN', 5n, 18);
    expect(m).toEqual({ asset: 'TKN', scale: 18, amount: 5n });
  });

  it('rejects a non-bigint amount (binary float prohibited)', () => {
    // @ts-expect-error intentional misuse: number must be rejected at runtime
    expect(() => money('EUR', 12.34)).toThrow(/float|bigint/i);
    // @ts-expect-error intentional misuse
    expect(() => money('EUR', 1234)).toThrow(/float|bigint/i);
  });

  it('rejects a negative or non-integer scale', () => {
    expect(() => money('TKN', 1n, -1)).toThrow(/scale/i);
    expect(() => money('TKN', 1n, 1.5)).toThrow(/scale/i);
  });
});

describe('assertNotFloat', () => {
  it('throws on a JS number', () => {
    expect(() => assertNotFloat(1.5)).toThrow(/float/i);
    expect(() => assertNotFloat(0)).toThrow(/float/i);
  });
  it('passes through bigints and strings', () => {
    expect(() => assertNotFloat(5n)).not.toThrow();
    expect(() => assertNotFloat('5')).not.toThrow();
  });
});

describe('decimal-string (de)serialization', () => {
  it('parses a decimal string into smallest units', () => {
    expect(fromDecimalString('EUR', '12.34')).toEqual({ asset: 'EUR', scale: 2, amount: 1234n });
    expect(fromDecimalString('EUR', '12')).toEqual({ asset: 'EUR', scale: 2, amount: 1200n });
    expect(fromDecimalString('EUR', '0.05')).toEqual({ asset: 'EUR', scale: 2, amount: 5n });
  });

  it('parses negatives and zero scale', () => {
    expect(fromDecimalString('EUR', '-7.01').amount).toBe(-701n);
    expect(fromDecimalString('JPY', '-7', 0).amount).toBe(-7n);
  });

  it('rejects more fractional digits than scale (lossless only — no silent rounding)', () => {
    expect(() => fromDecimalString('EUR', '12.345')).toThrow(/scale|fractional/i);
  });

  it('rejects non-numeric / NaN / Infinity / empty / non-string', () => {
    expect(() => fromDecimalString('EUR', 'abc')).toThrow();
    expect(() => fromDecimalString('EUR', '')).toThrow();
    expect(() => fromDecimalString('EUR', 'NaN')).toThrow();
    expect(() => fromDecimalString('EUR', 'Infinity')).toThrow();
    // @ts-expect-error intentional misuse: number input must be rejected
    expect(() => fromDecimalString('EUR', 12.34)).toThrow(/float|string/i);
  });

  it('serializes to a canonical decimal string (no float), incl. negatives and zero scale', () => {
    expect(toDecimalString(money('EUR', 1234n))).toBe('12.34');
    expect(toDecimalString(money('EUR', 5n))).toBe('0.05');
    expect(toDecimalString(money('EUR', -701n))).toBe('-7.01');
    expect(toDecimalString(money('JPY', -7n, 0))).toBe('-7');
    expect(toDecimalString(money('BTC', 100000000n))).toBe('1.00000000');
  });

  it('round-trips for large 18-decimal token magnitudes beyond Number.MAX_SAFE_INTEGER', () => {
    const big = money('TKN', 123456789012345678901234567890n, 18);
    expect(fromDecimalString('TKN', toDecimalString(big), 18)).toEqual(big);
  });
});

describe('exact arithmetic', () => {
  it('adds and subtracts same-asset money', () => {
    expect(addMoney(money('EUR', 100n), money('EUR', 23n))).toEqual(money('EUR', 123n));
    expect(subMoney(money('EUR', 100n), money('EUR', 23n))).toEqual(money('EUR', 77n));
    expect(negateMoney(money('EUR', 100n))).toEqual(money('EUR', -100n));
  });

  it('throws on asset or scale mismatch', () => {
    expect(() => addMoney(money('EUR', 1n), money('BTC', 1n))).toThrow(/asset|scale/i);
    expect(() => addMoney(money('TKN', 1n, 6), money('TKN', 1n, 18))).toThrow(/scale/i);
  });
});

describe('deterministic allocation (one part absorbs the residual)', () => {
  it('splitInTwo always sums to the total (V_A + V_B = K), incl. odd totals', () => {
    expect(splitInTwo(100n)).toEqual([50n, 50n]);
    const [a, b] = splitInTwo(101n);
    expect(a + b).toBe(101n);
    expect([a, b]).toEqual([51n, 50n]); // deterministic: first absorbs the residual
  });

  it('allocate distributes by weight and preserves the total exactly', () => {
    const parts = allocate(100n, [1n, 1n, 1n]);
    expect(parts.reduce((s, x) => s + x, 0n)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]); // largest-remainder, deterministic tie-break
  });

  it('preserves totals for large bigint magnitudes', () => {
    const total = 10n ** 30n + 7n;
    const parts = allocate(total, [2n, 1n]);
    expect(parts.reduce((s, x) => s + x, 0n)).toBe(total);
  });

  it('rejects non-positive weight sum and negative weights', () => {
    expect(() => allocate(10n, [])).toThrow();
    expect(() => allocate(10n, [0n, 0n])).toThrow();
    expect(() => allocate(10n, [-1n, 2n])).toThrow();
  });
});

describe('scale guard for known assets', () => {
  it('refuses an explicit scale that contradicts a known asset', () => {
    expect(() => money('EUR', 1n, 8)).toThrow(/scale|contradict/i);
    expect(() => fromDecimalString('EUR', '1.23456789', 8)).toThrow(/scale|contradict/i);
  });
  it('accepts an explicit scale that matches the known asset', () => {
    expect(money('EUR', 1n, 2)).toEqual(money('EUR', 1n));
  });
  it('accepts any valid scale for an unknown asset (token decimals())', () => {
    expect(money('TKN', 1n, 18).scale).toBe(18);
    expect(money('TKN', 1n, 6).scale).toBe(6);
  });
});

describe('runtime immutability', () => {
  it('freezes returned Money objects (readonly is not only compile-time)', () => {
    expect(Object.isFrozen(money('EUR', 100n))).toBe(true);
    expect(Object.isFrozen(fromDecimalString('EUR', '1.00'))).toBe(true);
    expect(Object.isFrozen(addMoney(money('EUR', 1n), money('EUR', 2n)))).toBe(true);
    expect(Object.isFrozen(negateMoney(money('EUR', 1n)))).toBe(true);
  });
});
