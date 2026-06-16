// Exact-money primitives (Story 1.2, Architecture §Data Architecture / NFR-2).
//
// Money is an integer number of smallest units (a `bigint`) tagged with its asset's decimal
// scale. Binary floating point is PROHIBITED in PROD — every construction path rejects JS
// `number`. Money crosses boundaries as decimal strings, never as `number`. The
// largest-remainder `allocate`/`splitInTwo` helpers are the deterministic policy that makes
// integer splits preserve their total exactly (the `V_A + V_B = K` primitive).

/** A monetary amount: integer `amount` in the smallest unit of `asset`, at `scale` decimals. */
export interface Money {
  readonly asset: string;
  readonly scale: number;
  readonly amount: bigint;
}

/** Decimal scales for assets known at build time. Tokens supply their scale via `decimals()`. */
export const KNOWN_ASSET_SCALES: Readonly<Record<string, number>> = Object.freeze({
  EUR: 2,
  BTC: 8,
});

/** Returns the decimal scale of a known asset; refuses (never defaults) an unknown asset. */
export function knownScaleOf(asset: string): number {
  const scale = KNOWN_ASSET_SCALES[asset];
  if (scale === undefined) {
    throw new TypeError(
      `Unknown asset '${asset}': no known decimal scale. Pass the scale explicitly (e.g. token decimals()).`,
    );
  }
  return scale;
}

/** Throws if `value` is a JS `number` — binary float is prohibited in PROD (NFR-2). */
export function assertNotFloat(value: unknown): void {
  if (typeof value === 'number') {
    throw new TypeError(
      'Binary float is prohibited for money (NFR-2). Use a bigint in smallest units or fromDecimalString().',
    );
  }
}

function assertValidScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError(`Invalid decimal scale '${scale}': expected a non-negative integer.`);
  }
}

/**
 * Resolves the scale to use: the known scale when `scale` is omitted, else the explicit
 * `scale` — but an explicit scale that contradicts a KNOWN asset's canonical scale is a
 * caller bug and is refused (tokens are unknown assets and may pass any valid scale).
 */
function resolveScale(asset: string, scale?: number): number {
  if (scale === undefined) {
    return knownScaleOf(asset);
  }
  assertValidScale(scale);
  const known = KNOWN_ASSET_SCALES[asset];
  if (known !== undefined && known !== scale) {
    throw new RangeError(
      `Scale ${scale} contradicts the canonical scale ${known} for known asset '${asset}'.`,
    );
  }
  return scale;
}

/** Constructs `Money`, validating that `amount` is a bigint and `scale` is a non-negative integer. */
export function money(asset: string, amount: bigint, scale?: number): Money {
  if (typeof amount !== 'bigint') {
    assertNotFloat(amount);
    throw new TypeError(`Money amount must be a bigint in smallest units, got ${typeof amount}.`);
  }
  const resolvedScale = resolveScale(asset, scale);
  return Object.freeze({ asset, scale: resolvedScale, amount });
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Parses a decimal string (e.g. "12.34") into `Money`. Lossless: rejects excess fractional digits. */
export function fromDecimalString(asset: string, value: string, scale?: number): Money {
  if (typeof value !== 'string') {
    assertNotFloat(value);
    throw new TypeError('fromDecimalString expects a decimal string, never a number (NFR-2).');
  }
  const resolvedScale = resolveScale(asset, scale);
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`Invalid decimal string '${value}' for asset '${asset}'.`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  if (fracPart.length > resolvedScale) {
    throw new RangeError(
      `Decimal string '${value}' has ${fracPart.length} fractional digits, exceeding scale ${resolvedScale} (no silent rounding).`,
    );
  }
  const fracPadded = fracPart.padEnd(resolvedScale, '0');
  const magnitude = BigInt(intPart) * 10n ** BigInt(resolvedScale) + BigInt(fracPadded || '0');
  return Object.freeze({ asset, scale: resolvedScale, amount: negative ? -magnitude : magnitude });
}

/** Formats `Money` as a canonical decimal string (no float), correct for negatives and scale 0. */
export function toDecimalString(m: Money): string {
  if (m.scale === 0) {
    return m.amount.toString();
  }
  const negative = m.amount < 0n;
  const abs = negative ? -m.amount : m.amount;
  const digits = abs.toString().padStart(m.scale + 1, '0');
  const intPart = digits.slice(0, digits.length - m.scale);
  const fracPart = digits.slice(digits.length - m.scale);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

function assertSameDenomination(a: Money, b: Money): void {
  if (a.asset !== b.asset) {
    throw new TypeError(`Asset mismatch: '${a.asset}' vs '${b.asset}'.`);
  }
  if (a.scale !== b.scale) {
    throw new TypeError(`Scale mismatch for '${a.asset}': ${a.scale} vs ${b.scale}.`);
  }
}

/** Adds two same-asset, same-scale amounts. */
export function addMoney(a: Money, b: Money): Money {
  assertSameDenomination(a, b);
  return Object.freeze({ asset: a.asset, scale: a.scale, amount: a.amount + b.amount });
}

/** Subtracts `b` from `a` (same asset and scale). */
export function subMoney(a: Money, b: Money): Money {
  assertSameDenomination(a, b);
  return Object.freeze({ asset: a.asset, scale: a.scale, amount: a.amount - b.amount });
}

/** Negates an amount. */
export function negateMoney(a: Money): Money {
  return Object.freeze({ asset: a.asset, scale: a.scale, amount: -a.amount });
}

/**
 * Allocates `total` across `weights` using the largest-remainder (Hamilton) method, so the
 * returned parts ALWAYS sum to `total` exactly. Residual units go to the largest remainders
 * with a deterministic ascending-index tie-break. All BigInt — never converts to `number`.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new RangeError('allocate requires at least one weight.');
  }
  let weightSum = 0n;
  for (const w of weights) {
    if (w < 0n) throw new RangeError('allocate weights must be non-negative.');
    weightSum += w;
  }
  if (weightSum <= 0n) {
    throw new RangeError('allocate requires a positive weight sum.');
  }

  const floors = weights.map((w) => (total * w) / weightSum);
  const remainders = weights.map((w, i) => total * w - floors[i]! * weightSum);
  const assigned = floors.reduce((s, x) => s + x, 0n);
  const leftover = total - assigned; // residual units to distribute (sign matches total)

  const order = weights.map((_, i) => i);
  if (leftover > 0n) {
    order.sort((i, j) =>
      remainders[j]! > remainders[i]! ? 1 : remainders[j]! < remainders[i]! ? -1 : i - j,
    );
  } else if (leftover < 0n) {
    order.sort((i, j) =>
      remainders[i]! > remainders[j]! ? 1 : remainders[i]! < remainders[j]! ? -1 : i - j,
    );
  }

  const result = [...floors];
  const step = leftover > 0n ? 1n : -1n;
  let remaining = leftover > 0n ? leftover : -leftover;
  for (const idx of order) {
    if (remaining === 0n) break;
    result[idx] = result[idx]! + step;
    remaining -= 1n;
  }
  return result;
}

/** Splits `total` into two parts that always sum to `total` — the `V_A + V_B = K` primitive. */
export function splitInTwo(total: bigint): [bigint, bigint] {
  const [a, b] = allocate(total, [1n, 1n]);
  return [a!, b!];
}
