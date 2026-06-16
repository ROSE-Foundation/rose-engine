// Coupled-pair repository (FR-6) — the inter-track contract's create/read primitive. A coupled
// pair is persisted as ONE row carrying BOTH legs; there is deliberately no API to create a lone
// leg, mirroring the schema-level "single-leg unrepresentable" guarantee. `leverage` is stored
// and read PER-PAIR from the row, never hard-coded. Smallest-unit magnitudes (K, V_A, V_B) cross
// this boundary as `bigint`; decimal factors/prices (P₀, L, f) cross as decimal strings.
//
// Validation is manual + typed errors (matching the ledger's accounts/journal-entries repos —
// there is no external ingress at this internal layer until Epic 6). This story does NOT model
// lifecycle transitions (Story 2.2), issuance (2.3), Note embedding (2.4), or the V_A+V_B=K
// conservation invariant (Epic 7 / D1 parked).
import { eq, sql } from 'drizzle-orm';
import { assertNotFloat } from '@rose/shared';
import type { RoseExecutor } from '../db.js';
import { coupledPairs } from '../schema/index.js';
import type { CoupledPair, CoupledPairState } from '../schema/index.js';

export interface CreateCoupledPairInput {
  /** The underlying reference (e.g. 'EUR/USD', 'BTC'). */
  readonly referenceAsset: string;
  /** P₀ anchor price as a decimal string (decimal(18,8)). */
  readonly anchorPrice: string;
  /** L leverage as a decimal string — per-pair, never hard-coded. */
  readonly leverage: string;
  /** K collateral pool, integer smallest-units. */
  readonly collateralPool: bigint;
  /** f floor as a decimal string. */
  readonly floor: string;
  /** V_A long-leg value, integer smallest-units. Both legs are required — no lone leg. */
  readonly longLegValue: bigint;
  /** V_B short-leg value, integer smallest-units. Both legs are required — no lone leg. */
  readonly shortLegValue: bigint;
  /** Optional initial lifecycle state; defaults to 'PENDING' at the DB. */
  readonly state?: CoupledPairState;
}

/** A coupled pair with smallest-unit magnitudes (K, V_A, V_B) as bigints. */
export interface CoupledPairView {
  readonly id: string;
  readonly referenceAsset: string;
  readonly anchorPrice: string;
  readonly leverage: string;
  readonly collateralPool: bigint;
  readonly floor: string;
  readonly longLegValue: bigint;
  readonly shortLegValue: bigint;
  readonly state: CoupledPairState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Thrown when a coupled-pair write is structurally/numerically invalid. */
export class InvalidCoupledPairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCoupledPairError';
  }
}

// Strict decimal string: optional sign, digits, optional fractional part. No exponent, no NaN —
// binary-float text must never reach a NUMERIC column (NFR-2).
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

function assertDecimalString(label: string, value: string): void {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new InvalidCoupledPairError(`${label} must be a plain decimal string, got '${value}'.`);
  }
}

// anchor_price is the frozen decimal(18,8) type. The DB would SILENTLY round a higher-precision
// input (e.g. 1.123456789 → 1.12345679); reject it at the boundary so precision loss is explicit
// rather than silent (consistent with the codebase's no-silent-money-rounding stance, NFR-2).
const ANCHOR_PRICE_MAX_SCALE = 8;

function assertMaxFractionalDigits(label: string, value: string, maxScale: number): void {
  const fracPart = value.split('.')[1];
  if (fracPart !== undefined && fracPart.length > maxScale) {
    throw new InvalidCoupledPairError(
      `${label} has ${fracPart.length} fractional digits but the frozen type allows at most ${maxScale}; ` +
        `round to ${maxScale} decimals before persisting (no silent precision loss).`,
    );
  }
}

// All-zero magnitude (any scale/sign): '0', '-0', '0.000', etc.
const ZERO_PATTERN = /^-?0+(\.0+)?$/;

function assertPositiveDecimal(label: string, value: string): void {
  assertDecimalString(label, value);
  if (value.startsWith('-') || ZERO_PATTERN.test(value)) {
    throw new InvalidCoupledPairError(`${label} must be a positive decimal, got '${value}'.`);
  }
}

function assertNonNegativeDecimal(label: string, value: string): void {
  assertDecimalString(label, value);
  if (value.startsWith('-') && !ZERO_PATTERN.test(value)) {
    throw new InvalidCoupledPairError(`${label} must be a non-negative decimal, got '${value}'.`);
  }
}

function assertNonNegativeUnits(label: string, value: bigint): void {
  try {
    assertNotFloat(value); // NFR-2: a JS number/float is never a valid smallest-unit amount
  } catch {
    throw new InvalidCoupledPairError(
      `${label} must be a bigint in smallest units, never a binary float (NFR-2).`,
    );
  }
  if (typeof value !== 'bigint') {
    throw new InvalidCoupledPairError(`${label} must be a bigint in smallest units.`);
  }
  if (value < 0n) {
    throw new InvalidCoupledPairError(`${label} must be a non-negative integer, got ${value}.`);
  }
}

function numericToBigInt(value: string): bigint {
  const [intPart = '0', fracPart] = value.split('.');
  if (fracPart !== undefined && /[^0]/.test(fracPart)) {
    throw new Error(`Non-integer amount '${value}' read from coupled_pairs (smallest-units).`);
  }
  return BigInt(intPart);
}

function toView(row: CoupledPair): CoupledPairView {
  return {
    id: row.id,
    referenceAsset: row.referenceAsset,
    anchorPrice: row.anchorPrice,
    leverage: row.leverage,
    collateralPool: numericToBigInt(row.collateralPool),
    floor: row.floor,
    longLegValue: numericToBigInt(row.longLegValue),
    shortLegValue: numericToBigInt(row.shortLegValue),
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Persists a coupled pair as ONE row carrying BOTH legs. Validates the frozen field types
 * (positive P₀/L, non-negative f, non-negative integer smallest-unit K/V_A/V_B) and inserts.
 * Returns the persisted pair (smallest-unit magnitudes as bigints; `leverage` is the row's own
 * per-pair value). Throws InvalidCoupledPairError on invalid input. There is no API to create a
 * single leg — the structural guarantee is enforced by the schema and reflected here.
 * Accepts a `RoseExecutor` so it can run inside an outer transaction (e.g. issuance, Story 2.3).
 */
export async function createCoupledPair(
  db: RoseExecutor,
  input: CreateCoupledPairInput,
): Promise<CoupledPairView> {
  if (typeof input.referenceAsset !== 'string' || input.referenceAsset.trim().length === 0) {
    throw new InvalidCoupledPairError('referenceAsset must be a non-empty string.');
  }
  assertPositiveDecimal('anchorPrice', input.anchorPrice);
  assertMaxFractionalDigits('anchorPrice', input.anchorPrice, ANCHOR_PRICE_MAX_SCALE);
  assertPositiveDecimal('leverage', input.leverage);
  assertNonNegativeDecimal('floor', input.floor);
  assertNonNegativeUnits('collateralPool', input.collateralPool);
  assertNonNegativeUnits('longLegValue', input.longLegValue);
  assertNonNegativeUnits('shortLegValue', input.shortLegValue);

  const [row] = await db
    .insert(coupledPairs)
    .values({
      referenceAsset: input.referenceAsset.trim(),
      anchorPrice: input.anchorPrice,
      leverage: input.leverage,
      collateralPool: input.collateralPool.toString(),
      floor: input.floor,
      longLegValue: input.longLegValue.toString(),
      shortLegValue: input.shortLegValue.toString(),
      ...(input.state !== undefined ? { state: input.state } : {}),
    })
    .returning();
  if (!row) {
    throw new Error('Coupled-pair insert returned no row.');
  }
  return toView(row);
}

/**
 * Reads a coupled pair by id. `leverage` is returned per-pair from the row, never a constant.
 * Accepts a `RoseExecutor` so a caller inside an outer transaction (e.g. `createRoseNote`, Story
 * 2.4) reads the pair on the SAME transaction; a plain `RoseDb` still satisfies it.
 */
export async function getCoupledPair(
  db: RoseExecutor,
  id: string,
): Promise<CoupledPairView | null> {
  const row = await db.query.coupledPairs.findFirst({ where: eq(coupledPairs.id, id) });
  return row ? toView(row) : null;
}

// ─── Lifecycle state machine (FR-4) ─────────────────────────────────────────────────────────
//
// The explicit, allowed-transitions set is the SINGLE SOURCE OF TRUTH for which lifecycle state
// changes are legal. The DB trigger in migration 0004 mirrors this exact set as the non-bypassable
// backstop (integrity-by-construction, NFR-1) — the two encodings MUST stay in sync (a test
// asserts they agree over all distinct ordered state pairs).
//
// P0 interpretation (epics.md#Story 2.2 / FR-4 — `PENDING → ACTIVE → (REBALANCING | PARTIAL |
// SETTLING) → CLOSED`):
//   • PENDING activates only to ACTIVE (no skipping activation).
//   • ACTIVE enters the rebalance cluster via REBALANCING, or begins wind-down via SETTLING.
//     ACTIVE → PARTIAL is NOT allowed directly: PARTIAL is a *mid-rebalance* transient, reached
//     only from within a rebalance (REBALANCING → PARTIAL).
//   • REBALANCING/PARTIAL can return to ACTIVE (rebalance completed) and route to close only via
//     SETTLING (you settle before you close).
//   • SETTLING is the single pre-close state → CLOSED. CLOSED is terminal (no resurrection).
//   • A same-state update is not a transition (transitionPair rejects it); the DB trigger only
//     guards genuine state changes (NEW.state IS DISTINCT FROM OLD.state).

/** The legal lifecycle transitions, keyed by source state. The single source of truth (FR-4). */
export const COUPLED_PAIR_TRANSITIONS: Readonly<
  Record<CoupledPairState, readonly CoupledPairState[]>
> = Object.freeze({
  PENDING: ['ACTIVE'],
  ACTIVE: ['REBALANCING', 'SETTLING'],
  REBALANCING: ['PARTIAL', 'ACTIVE', 'SETTLING'],
  PARTIAL: ['REBALANCING', 'ACTIVE', 'SETTLING'],
  SETTLING: ['CLOSED'],
  CLOSED: [], // terminal
});

/** True if a pair may move directly from `from` to `to` per the P0 transition set. */
export function isPairTransitionAllowed(from: CoupledPairState, to: CoupledPairState): boolean {
  return COUPLED_PAIR_TRANSITIONS[from].includes(to);
}

/** Thrown when a requested lifecycle transition is not in the allowed set. */
export class IllegalPairTransitionError extends Error {
  readonly pairId: string;
  readonly from: CoupledPairState;
  readonly to: CoupledPairState;
  constructor(pairId: string, from: CoupledPairState, to: CoupledPairState) {
    super(`Illegal coupled-pair lifecycle transition: ${from} -> ${to} (pair ${pairId}).`);
    this.name = 'IllegalPairTransitionError';
    this.pairId = pairId;
    this.from = from;
    this.to = to;
  }
}

/** Thrown when a transition targets a pair id that does not exist. */
export class CoupledPairNotFoundError extends Error {
  readonly pairId: string;
  constructor(pairId: string) {
    super(`Coupled pair '${pairId}' not found.`);
    this.name = 'CoupledPairNotFoundError';
    this.pairId = pairId;
  }
}

/**
 * Moves a coupled pair to `toState`, enforcing the lifecycle state machine (FR-4). Runs in a
 * transaction that locks the row (`SELECT … FOR UPDATE`) so the read-check-write is atomic (no
 * TOCTOU). Throws `CoupledPairNotFoundError` if the pair is absent, or `IllegalPairTransitionError`
 * if the transition is not in `COUPLED_PAIR_TRANSITIONS` (this also rejects a same-state no-op —
 * a transition must change state). On success advances `updated_at` so the change is observable.
 * The DB trigger (migration 0004) is the non-bypassable backstop behind this guard.
 * Accepts a `RoseExecutor` so it can run inside an outer transaction (e.g. issuance, Story 2.3):
 * its own `db.transaction` then becomes a nested savepoint on the passed transaction.
 */
export async function transitionPair(
  db: RoseExecutor,
  pairId: string,
  toState: CoupledPairState,
): Promise<CoupledPairView> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(coupledPairs)
      .where(eq(coupledPairs.id, pairId))
      .for('update');
    if (!current) {
      throw new CoupledPairNotFoundError(pairId);
    }
    if (!isPairTransitionAllowed(current.state, toState)) {
      throw new IllegalPairTransitionError(pairId, current.state, toState);
    }
    const [updated] = await tx
      .update(coupledPairs)
      .set({ state: toState, updatedAt: sql`now()` })
      .where(eq(coupledPairs.id, pairId))
      .returning();
    if (!updated) {
      throw new Error('Coupled-pair transition update returned no row.');
    }
    return toView(updated);
  });
}

// ─── Reset re-anchor / re-base (Story 6.4 — strategy execution) ──────────────────────────────
//
// ADDITIVE primitive: it re-anchors P₀ and re-bases the leg values when a threshold-only reset is
// executed by the strategy executor (Story 6.4). It writes ONLY existing columns (no schema change,
// no new migration) and changes NO existing function. Guarded so it can only run inside the reset
// window (REBALANCING or PARTIAL — the FR-4 mid-rebalance states) and so it conserves K
// (V_A + V_B = K — the issuer-neutral invariant the re-base must not break). It does NOT itself
// transition the lifecycle (the executor drives REBALANCING → ACTIVE via `transitionPair`).

/** Thrown when a reset (re-anchor/re-base) is attempted outside the REBALANCING/PARTIAL window. */
export class CoupledPairResetStateError extends Error {
  readonly pairId: string;
  readonly state: CoupledPairState;
  constructor(pairId: string, state: CoupledPairState) {
    super(
      `Cannot reset coupled pair '${pairId}' in state '${state}': a reset (re-anchor/re-base) is only ` +
        `permitted while the pair is REBALANCING or PARTIAL (the mid-rebalance reset window).`,
    );
    this.name = 'CoupledPairResetStateError';
    this.pairId = pairId;
    this.state = state;
  }
}

export interface ApplyCoupledPairResetInput {
  readonly pairId: string;
  /** New P₀ anchor price (decimal string) — re-anchored to the breach/reset price. */
  readonly newAnchorPrice: string;
  /** New V_A long-leg value, integer smallest-units. V_A + V_B MUST equal the (unchanged) K. */
  readonly newLongLegValue: bigint;
  /** New V_B short-leg value, integer smallest-units. */
  readonly newShortLegValue: bigint;
}

/**
 * Re-anchors P₀ and re-bases the leg values of a coupled pair at a threshold-only reset (Story 6.4).
 * Runs in a row-locking transaction (`SELECT … FOR UPDATE`) so the read-check-write is atomic.
 * Refuses unless the pair is in the reset window (`REBALANCING`/`PARTIAL`) with `CoupledPairResetStateError`;
 * validates the frozen field types (positive decimal anchor at the frozen scale, non-negative integer
 * leg values) like `createCoupledPair`; and asserts `newLongLegValue + newShortLegValue === K`
 * (collateral pool unchanged — the conservation invariant) with `InvalidCoupledPairError`. Advances
 * `updated_at`. Accepts a `RoseExecutor` so it can run inside an outer transaction. ADDITIVE — it
 * changes no existing function, schema, or migration (writes only existing columns).
 */
export async function applyCoupledPairReset(
  db: RoseExecutor,
  input: ApplyCoupledPairResetInput,
): Promise<CoupledPairView> {
  assertPositiveDecimal('newAnchorPrice', input.newAnchorPrice);
  assertMaxFractionalDigits('newAnchorPrice', input.newAnchorPrice, ANCHOR_PRICE_MAX_SCALE);
  assertNonNegativeUnits('newLongLegValue', input.newLongLegValue);
  assertNonNegativeUnits('newShortLegValue', input.newShortLegValue);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(coupledPairs)
      .where(eq(coupledPairs.id, input.pairId))
      .for('update');
    if (!current) {
      throw new CoupledPairNotFoundError(input.pairId);
    }
    if (current.state !== 'REBALANCING' && current.state !== 'PARTIAL') {
      throw new CoupledPairResetStateError(input.pairId, current.state);
    }
    const k = numericToBigInt(current.collateralPool);
    if (input.newLongLegValue + input.newShortLegValue !== k) {
      throw new InvalidCoupledPairError(
        `Reset re-base must conserve K: V_A (${input.newLongLegValue}) + V_B (${input.newShortLegValue}) ` +
          `!= K (${k}).`,
      );
    }
    const [updated] = await tx
      .update(coupledPairs)
      .set({
        anchorPrice: input.newAnchorPrice,
        longLegValue: input.newLongLegValue.toString(),
        shortLegValue: input.newShortLegValue.toString(),
        updatedAt: sql`now()`,
      })
      .where(eq(coupledPairs.id, input.pairId))
      .returning();
    if (!updated) {
      throw new Error('Coupled-pair reset update returned no row.');
    }
    return toView(updated);
  });
}
