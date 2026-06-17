// THROWAWAY (Story 7.1) — exact rational arithmetic tests.
import { describe, expect, it } from 'vitest';
import {
  ONE,
  ZERO,
  abs,
  add,
  cmp,
  div,
  isZero,
  lte,
  mul,
  parseDecimal,
  rational,
  sub,
  toApproxString,
} from './rational.js';

describe('rational', () => {
  it('reduces to lowest terms with a positive denominator', () => {
    expect(rational(2n, 4n)).toEqual({ n: 1n, d: 2n });
    expect(rational(-2n, 4n)).toEqual({ n: -1n, d: 2n });
    expect(rational(2n, -4n)).toEqual({ n: -1n, d: 2n });
    expect(rational(0n, 5n)).toEqual({ n: 0n, d: 1n });
  });

  it('refuses a zero denominator', () => {
    expect(() => rational(1n, 0n)).toThrow(RangeError);
  });

  it('parses decimal strings losslessly', () => {
    expect(parseDecimal('1.5')).toEqual({ n: 3n, d: 2n });
    expect(parseDecimal('-0.0025')).toEqual({ n: -1n, d: 400n });
    expect(parseDecimal('100')).toEqual({ n: 100n, d: 1n });
    expect(parseDecimal(' 0.50 ')).toEqual({ n: 1n, d: 2n });
  });

  it('rejects a JS number and malformed strings (NFR-2 — no binary float)', () => {
    // @ts-expect-error binary float is prohibited on money paths
    expect(() => parseDecimal(1.5)).toThrow(TypeError);
    expect(() => parseDecimal('1.2.3')).toThrow(TypeError);
    expect(() => parseDecimal('abc')).toThrow(TypeError);
    expect(() => parseDecimal('')).toThrow(TypeError);
  });

  it('adds, subtracts, multiplies and divides exactly', () => {
    expect(add(parseDecimal('0.1'), parseDecimal('0.2'))).toEqual({ n: 3n, d: 10n }); // exact 0.3
    expect(sub(ONE, parseDecimal('0.25'))).toEqual({ n: 3n, d: 4n });
    expect(mul(parseDecimal('1.5'), parseDecimal('2'))).toEqual({ n: 3n, d: 1n });
    expect(div(ONE, parseDecimal('3'))).toEqual({ n: 1n, d: 3n });
    expect(() => div(ONE, ZERO)).toThrow(RangeError);
  });

  it('compares and takes absolute value', () => {
    expect(cmp(parseDecimal('0.5'), parseDecimal('0.5'))).toBe(0);
    expect(cmp(parseDecimal('-0.5'), parseDecimal('0.5'))).toBe(-1);
    expect(cmp(parseDecimal('2'), ONE)).toBe(1);
    expect(abs(parseDecimal('-0.75'))).toEqual({ n: 3n, d: 4n });
    expect(lte(parseDecimal('0.04'), parseDecimal('0.05'))).toBe(true);
    expect(isZero(sub(parseDecimal('0.3'), add(parseDecimal('0.1'), parseDecimal('0.2'))))).toBe(
      true,
    );
  });

  it('formats a lossy approximation for reporting only', () => {
    expect(toApproxString(parseDecimal('1.5'), 4)).toBe('1.5000');
    expect(toApproxString(parseDecimal('-0.0025'), 4)).toBe('-0.0025');
  });
});
