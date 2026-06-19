import { describe, expect, it } from 'vitest';
import {
  ONE,
  abs,
  cmp,
  div,
  gt,
  isDecimalString,
  lte,
  mul,
  parseDecimal,
  rational,
  sub,
  toApproxString,
} from './rational.js';

describe('rational — exact decimal parsing (NFR-2)', () => {
  it('parses decimal strings losslessly into reduced fractions', () => {
    expect(parseDecimal('0.5')).toEqual({ n: 1n, d: 2n });
    expect(parseDecimal('100')).toEqual({ n: 100n, d: 1n });
    expect(parseDecimal('-0.0025')).toEqual({ n: -1n, d: 400n });
    expect(parseDecimal('1.10')).toEqual({ n: 11n, d: 10n });
  });

  it('rejects a JS number and non-decimal text (no binary float)', () => {
    // @ts-expect-error — a number is never a valid money/price input
    expect(() => parseDecimal(0.1)).toThrow(TypeError);
    expect(() => parseDecimal('1e3')).toThrow(TypeError);
    expect(() => parseDecimal('NaN')).toThrow(TypeError);
    expect(() => parseDecimal('1,000')).toThrow(TypeError);
  });

  it('isDecimalString gates plain decimals only', () => {
    expect(isDecimalString('1.5')).toBe(true);
    expect(isDecimalString('-2')).toBe(true);
    expect(isDecimalString('1e3')).toBe(false);
    expect(isDecimalString(0.1)).toBe(false);
    expect(isDecimalString(undefined)).toBe(false);
  });

  it('arithmetic is exact', () => {
    expect(sub(parseDecimal('1.05'), parseDecimal('1.00'))).toEqual({ n: 1n, d: 20n });
    expect(mul(parseDecimal('2'), parseDecimal('0.5'))).toEqual(ONE);
    expect(div(parseDecimal('1'), parseDecimal('4'))).toEqual({ n: 1n, d: 4n });
    expect(abs(parseDecimal('-3.5'))).toEqual({ n: 7n, d: 2n });
  });

  it('comparisons are sign-aware', () => {
    expect(cmp(parseDecimal('0.1'), parseDecimal('0.2'))).toBe(-1);
    expect(gt(abs(parseDecimal('-1.5')), ONE)).toBe(true);
    expect(lte(parseDecimal('1'), ONE)).toBe(true);
    expect(gt(parseDecimal('1'), ONE)).toBe(false);
  });

  it('rational refuses a zero denominator and div-by-zero', () => {
    expect(() => rational(1n, 0n)).toThrow(RangeError);
    expect(() => div(ONE, parseDecimal('0'))).toThrow(RangeError);
  });

  it('toApproxString is for display only (lossy decimal)', () => {
    expect(toApproxString(parseDecimal('0.5'), 4)).toBe('0.5000');
    expect(toApproxString(parseDecimal('-1.25'), 2)).toBe('-1.25');
    // 1/3 is irrational in base-10 — truncated for display, never used in assertions.
    expect(toApproxString(div(ONE, parseDecimal('3')), 6)).toBe('0.333333');
  });
});
