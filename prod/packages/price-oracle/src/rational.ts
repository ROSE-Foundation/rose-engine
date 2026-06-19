// @rose/price-oracle — exact rational arithmetic over BigInt (NFR-2).
//
// The mark-to-market proportions (r = (P − P₀)/P₀, L·r, the floor f, the distance-to-floor)
// are computed EXACTLY as reduced num/den fractions — never binary float. Inputs (prices,
// leverage, floor, divergence bound) arrive as decimal STRINGS and are parsed losslessly; a JS
// `number` is never accepted.
//
// REGIME NOTE: `/throwaway/coupled-math/src/rational.ts` holds an equivalent helper, but `/prod`
// must NEVER import `/throwaway` (regime boundary, CI-enforced). This is a clean, self-contained
// `/prod` reimplementation with the same NFR-2 guarantee.

/** A reduced rational `n/d` with `d > 0`. */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Builds a reduced rational with a positive denominator. Throws on a zero denominator. */
export function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) {
    throw new RangeError('Rational denominator must be non-zero.');
  }
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) {
    return { n: 0n, d: 1n };
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** True when `value` is a plain decimal string (optional sign, no exponent, no NaN). */
export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value.trim());
}

/**
 * Parses a decimal string (e.g. "1.5", "-0.0025", "100") into an exact `Rational`.
 * Rejects a JS `number` and any non-decimal-string input — binary float is prohibited (NFR-2).
 */
export function parseDecimal(value: string): Rational {
  if (typeof value !== 'string') {
    throw new TypeError(
      'parseDecimal expects a decimal string, never a number (NFR-2 — no binary float).',
    );
  }
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new TypeError(`Invalid decimal string '${value}'.`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const denom = 10n ** BigInt(fracPart.length);
  const magnitude = BigInt(intPart) * denom + BigInt(fracPart || '0');
  return rational(negative ? -magnitude : magnitude, denom);
}

export const ZERO: Rational = { n: 0n, d: 1n };
export const ONE: Rational = { n: 1n, d: 1n };

export function sub(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.n * b.n, a.d * b.d);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.n === 0n) {
    throw new RangeError('Division by zero rational.');
  }
  return rational(a.n * b.d, a.d * b.n);
}

export function abs(a: Rational): Rational {
  return a.n < 0n ? { n: -a.n, d: a.d } : a;
}

/** Sign-aware comparison: -1 if a<b, 0 if a==b, 1 if a>b (both denominators positive). */
export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function lte(a: Rational, b: Rational): boolean {
  return cmp(a, b) <= 0;
}

export function gt(a: Rational, b: Rational): boolean {
  return cmp(a, b) > 0;
}

/** A lossy decimal approximation for human-readable reporting ONLY — never for assertions. */
export function toApproxString(a: Rational, digits = 8): string {
  const scale = 10n ** BigInt(digits);
  const scaled = (a.n * scale) / a.d;
  const negative = scaled < 0n;
  const absScaled = negative ? -scaled : scaled;
  const intPart = absScaled / scale;
  const fracPart = (absScaled % scale).toString().padStart(digits, '0');
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}
