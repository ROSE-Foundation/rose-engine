// @rose/price-oracle — mark-to-market service (FR-24).
//
// Prices an issued coupled pair from its REAL parameters (anchor P₀, leverage L, collateral pool
// K, floor f) plus a `PriceOracle` quote — it never invents a number. From the coupled-coin
// reference model (architecture §4.2):
//   r   = (P − P₀)/P₀                 deviation from the anchor
//   V_A = (K/2)(1 + L·r)   V_B = (K/2)(1 − L·r)   with V_A + V_B = K exactly
//   buffer = 1 − |L·r|     distance-to-floor = buffer − f
// Entry (P₀ ⇒ r = 0) ⇒ both legs K/2; unrealized P&L per leg = legAtPrice − legAtEntry, and the
// two legs' P&L sum to 0 (delta-neutral).
//
// Trust is fail-closed (§15 oracle integrity): the freshness bound and the divergence band are
// REQUIRED caller inputs — never silently defaulted. A mark is NEVER fabricated: when the feed is
// absent, stale, or implausibly divergent, the trusted P&L fields are `null` and the state is
// explicit. Money is exact — leg values + P&L are integer smallest-units (`bigint`); prices/floor/
// distance are decimal strings (NFR-2).
import { allocate, splitInTwo } from '@rose/shared';
import {
  ONE,
  abs,
  div,
  gt,
  isDecimalString,
  lte,
  mul,
  parseDecimal,
  sub,
  toApproxString,
  type Rational,
} from './rational.js';
import type { PriceQuote } from './price-oracle.js';

/**
 * The real, public parameters of an issued coupled pair needed to mark it. Structural by design:
 * the ledger's `CoupledPairView` satisfies this shape, but the service does NOT depend on
 * `@rose/ledger` — it is a read-only compute seam over any source of these params (NFR-8).
 *
 * The leg split is recomputed from (K, P₀, L) at the live price; the pair's stored leg columns are
 * intentionally NOT consumed here (the formula is the single source of truth for a live mark).
 */
export interface MarkablePair {
  /** The underlying reference (e.g. 'EUR/USD', 'BTC'). */
  readonly referenceAsset: string;
  /** Anchor price P₀ as a decimal string (the pair's `decimal(18,8)` anchor). Must be > 0. */
  readonly anchorPrice: string;
  /** Per-pair leverage L as a decimal string — read from the pair, never hard-coded. Must be > 0. */
  readonly leverage: string;
  /** Collateral pool K in smallest units (the sum of both legs). Must be ≥ 0. */
  readonly collateralPool: bigint;
  /** Floor f as a decimal string. Must be ≥ 0. */
  readonly floor: string;
}

/** Caller-supplied trust inputs for a mark (§15) — required, never defaulted. */
export interface MarkOptions {
  /** Max age (ms) before a quote is `STALE`. Required, non-negative — a parked trust input. */
  readonly freshnessBoundMs: number;
  /**
   * Max plausible |r| = |(P − P₀)/P₀| before the oracle figure is flagged `DIVERGENT` (not
   * trusted). Required, strictly-positive decimal string — a parked trust input (§15).
   */
  readonly maxRelativeDivergence: string;
  /** Evaluation clock; defaults to `new Date()`. Injected for deterministic tests. */
  readonly now?: Date;
}

/** The explicit mark states. A non-`OK` state never carries a trusted P&L. */
export type MarkStatus = 'OK' | 'STALE' | 'NO_FEED' | 'DIVERGENT';

/** A pair of smallest-unit leg magnitudes (long = V_A, short = V_B). */
export interface PairLegs {
  readonly long: bigint;
  readonly short: bigint;
}

/** Provenance of the quote a mark was derived from. */
export interface MarkProvenance {
  readonly source: string;
  readonly asOf: Date;
  readonly sequence?: number;
}

/**
 * A mark-to-market result. The trusted compute fields (`legsAtPrice`, `entryLegs`,
 * `unrealizedPnl`, `distanceToFloor`, `floorBreached`) are non-null ONLY when `status === 'OK'`;
 * otherwise they are `null` (a mark is never fabricated). `markPrice` is `null` only for `NO_FEED`
 * — for `STALE`/`DIVERGENT` the offending figure is surfaced (flagged) but not trusted.
 */
export interface Mark {
  readonly referenceAsset: string;
  readonly status: MarkStatus;
  /** Entry price = anchor P₀ (decimal string). */
  readonly entryPrice: string;
  /** The oracle price used (decimal string), or `null` when there is no feed. */
  readonly markPrice: string | null;
  /** Provenance of the quote, or `null` when there is no feed. */
  readonly provenance: MarkProvenance | null;
  /** The freshness bound (ms) this mark was evaluated against. */
  readonly freshnessBoundMs: number;
  /** Age (ms) of the quote at evaluation (`now − asOf`), or `null` when there is no feed. */
  readonly ageMs: number | null;
  /** Floor f (decimal string) — always surfaced (a pair param). */
  readonly floor: string;
  /** Leg split V_A/V_B at the live price (smallest units, sum to K) — null unless OK. */
  readonly legsAtPrice: PairLegs | null;
  /** Symmetric leg split at entry P₀ (each K/2) — null unless OK. */
  readonly entryLegs: PairLegs | null;
  /** Unrealized P&L per leg = legsAtPrice − entryLegs (sums to 0) — null unless OK. */
  readonly unrealizedPnl: PairLegs | null;
  /** distance-to-floor = buffer(1 − |L·r|) − f, lossy decimal for display — null unless OK. */
  readonly distanceToFloor: string | null;
  /** True when buffer ≤ f (the losing leg has reached the floor) — null unless OK. */
  readonly floorBreached: boolean | null;
  /** Every reason this mark is not a plain `OK` (e.g. `['STALE']`, `['DIVERGENT']`). */
  readonly flags: readonly string[];
}

/** Thrown when the caller's `MarkOptions` trust inputs are absent or invalid (fail-closed, §15). */
export class MarkOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkOptionsError';
  }
}

/** Thrown when a `MarkablePair`'s real parameters are structurally/numerically invalid. */
export class InvalidMarkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMarkInputError';
  }
}

function assertPositiveDecimal(label: string, value: string): Rational {
  if (!isDecimalString(value)) {
    throw new InvalidMarkInputError(`${label} must be a decimal string, got '${value}'.`);
  }
  const r = parseDecimal(value);
  if (r.n <= 0n) {
    throw new InvalidMarkInputError(`${label} must be strictly positive, got '${value}'.`);
  }
  return r;
}

function assertNonNegativeDecimal(label: string, value: string): Rational {
  if (!isDecimalString(value)) {
    throw new InvalidMarkInputError(`${label} must be a decimal string, got '${value}'.`);
  }
  const r = parseDecimal(value);
  if (r.n < 0n) {
    throw new InvalidMarkInputError(`${label} must be non-negative, got '${value}'.`);
  }
  return r;
}

function validateOptions(options: MarkOptions): { maxDivergence: Rational; now: Date } {
  const { freshnessBoundMs, maxRelativeDivergence } = options;
  if (
    typeof freshnessBoundMs !== 'number' ||
    !Number.isFinite(freshnessBoundMs) ||
    freshnessBoundMs < 0
  ) {
    throw new MarkOptionsError(
      `freshnessBoundMs is a required non-negative finite number (a parked trust input, never defaulted), got ${String(freshnessBoundMs)}.`,
    );
  }
  if (!isDecimalString(maxRelativeDivergence)) {
    throw new MarkOptionsError(
      `maxRelativeDivergence is a required decimal string (a parked trust input, never defaulted), got '${String(maxRelativeDivergence)}'.`,
    );
  }
  const maxDivergence = parseDecimal(maxRelativeDivergence);
  if (maxDivergence.n <= 0n) {
    throw new MarkOptionsError(
      `maxRelativeDivergence must be strictly positive, got '${maxRelativeDivergence}'.`,
    );
  }
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new MarkOptionsError('now must be a valid Date.');
  }
  return { maxDivergence, now };
}

/** Exact leg split V_A/V_B at leveraged deviation `lr = a/b` (b > 0). Sums to K exactly. */
function legSplit(collateralPool: bigint, lr: Rational): PairLegs {
  const wLong = lr.d + lr.n; // ∝ (1 + L·r)
  const wShort = lr.d - lr.n; // ∝ (1 − L·r)
  if (wLong < 0n || wShort < 0n) {
    // Unreachable on the OK path (caller gates |L·r| > 1 as DIVERGENT first); defensive only.
    throw new InvalidMarkInputError(
      'Price is outside the barrier (|L·r| > 1): a leg would be negative.',
    );
  }
  const [long, short] = allocate(collateralPool, [wLong, wShort]);
  return { long: long!, short: short! };
}

/**
 * Marks a coupled `pair` against an oracle `quote` (or `null` for no feed) under the caller's
 * trust `options`. Never fabricates a mark: the feed being absent, stale, or implausibly divergent
 * yields an explicit state with `null` trusted fields.
 */
export function markToMarket(
  pair: MarkablePair,
  quote: PriceQuote | null,
  options: MarkOptions,
): Mark {
  const { maxDivergence, now } = validateOptions(options);
  // Validate the pair's real parameters up front (fail loud on a malformed pair).
  const p0 = assertPositiveDecimal('anchorPrice', pair.anchorPrice);
  const leverage = assertPositiveDecimal('leverage', pair.leverage);
  assertNonNegativeDecimal('floor', pair.floor);
  if (typeof pair.collateralPool !== 'bigint' || pair.collateralPool < 0n) {
    throw new InvalidMarkInputError(
      `collateralPool must be a non-negative bigint in smallest units, got ${String(pair.collateralPool)}.`,
    );
  }

  const base = {
    referenceAsset: pair.referenceAsset,
    entryPrice: pair.anchorPrice,
    floor: pair.floor,
    freshnessBoundMs: options.freshnessBoundMs,
  } as const;

  const noTrust = {
    legsAtPrice: null,
    entryLegs: null,
    unrealizedPnl: null,
    distanceToFloor: null,
    floorBreached: null,
  } as const;

  // No feed ⇒ explicit "no price feed" (never a fabricated price).
  if (quote === null) {
    return {
      ...base,
      status: 'NO_FEED',
      markPrice: null,
      provenance: null,
      ageMs: null,
      ...noTrust,
      flags: ['NO_FEED'],
    };
  }

  const provenance: MarkProvenance = {
    source: quote.source,
    asOf: quote.asOf,
    ...(quote.sequence !== undefined ? { sequence: quote.sequence } : {}),
  };
  const ageMs = now.getTime() - quote.asOf.getTime();
  const flags: string[] = [];

  const stale = ageMs > options.freshnessBoundMs;
  if (stale) {
    flags.push('STALE');
  }

  // Divergence / plausibility. A non-decimal or non-positive feed price is a feed-integrity fault:
  // flag it (untrusted), never parse-throw and never trust it.
  if (!isDecimalString(quote.price) || parseDecimal(quote.price).n <= 0n) {
    flags.push('INVALID_PRICE');
  } else {
    const price = parseDecimal(quote.price);
    const r = div(sub(price, p0), p0); // (P − P₀)/P₀
    const lr = mul(leverage, r); // L·r
    // Implausible if |r| exceeds the caller's band, OR the figure would drive a leg strictly
    // negative (|L·r| > 1 ⇒ issuer-neutrality cannot hold) — not trustable as a live mark.
    const divergent = gt(abs(r), maxDivergence) || gt(abs(lr), ONE);
    if (divergent) {
      flags.push('DIVERGENT');
    }

    if (!stale && !divergent) {
      // OK path — compute the trusted mark exactly.
      const legsAtPrice = legSplit(pair.collateralPool, lr);
      const [entryLong, entryShort] = splitInTwo(pair.collateralPool);
      const entryLegs: PairLegs = { long: entryLong, short: entryShort };
      const unrealizedPnl: PairLegs = {
        long: legsAtPrice.long - entryLegs.long,
        short: legsAtPrice.short - entryLegs.short,
      };
      const buffer = sub(ONE, abs(lr)); // 1 − |L·r|
      const f = parseDecimal(pair.floor);
      const distance = sub(buffer, f);
      return {
        ...base,
        status: 'OK',
        markPrice: quote.price,
        provenance,
        ageMs,
        legsAtPrice,
        entryLegs,
        unrealizedPnl,
        distanceToFloor: toApproxString(distance),
        floorBreached: lte(buffer, f),
        flags,
      };
    }
  }

  // Untrusted: surface the offending figure + provenance, but never a trusted P&L.
  // STALE takes precedence in the headline status; both reasons remain in `flags`.
  const status: MarkStatus = stale ? 'STALE' : 'DIVERGENT';
  return {
    ...base,
    status,
    markPrice: quote.price,
    provenance,
    ageMs,
    ...noTrust,
    flags,
  };
}
