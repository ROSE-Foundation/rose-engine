// Position repository (FR-23) — the off-chain per-user position layer's create/read/lifecycle
// primitives. A position is a DERIVED off-chain row layered over an issued coupled pair: it never
// mints/holds a single on-chain leg and writes NO postings (it imports neither the chain package
// nor `postTransfer`). It composes only the ledger's `RoseExecutor` to read/write the `positions`
// table.
//
// Money exactness (NFR-2): smallest-unit magnitudes (size_units, collateral, realized/unrealized
// P&L) cross this boundary as `bigint`; entry_price (= anchor P₀) and leverage cross as decimal
// strings. P&L is SIGNED (a loss is negative — D1 separate L/S). Validation is manual + typed
// errors, mirroring the ledger's coupled-pairs repo (no external ingress at this internal layer).
//
// Lifecycle OPEN → (RESET) → CLOSED. RESET (`applyPositionReset`) is the D1/D1a settlement boundary
// of the underlying pair — it re-anchors `entry` to the new P₀, crystallises unrealized P&L into
// realized/withdrawable, and re-bases `size` on the pair's fresh symmetric split (no carried P&L).
// The position stays OPEN across resets; `closePosition` is the terminal transition (the economic
// redeem/burn close is Story 8.3). A position never outlives a CLOSED pair (DB-trigger backstop).
import { and, eq, sql } from 'drizzle-orm';
import { assertNotFloat } from '@rose/shared';
import { coupledPairs, type RoseExecutor } from '@rose/ledger';
import { positions } from '../schema/positions.js';
import type { Position, PositionLifecycle, PositionSide } from '../schema/positions.js';

export interface CreatePositionInput {
  /** The issued coupled pair this position is layered over. Required — no position without a pair. */
  readonly coupledPairId: string;
  /** The per-user owner reference (a non-empty identifier). */
  readonly owner: string;
  /** The underlying reference (e.g. 'EUR/USD', 'BTC') — must match the linked pair's asset. */
  readonly referenceAsset: string;
  /** Directional side. */
  readonly side: PositionSide;
  /** size/units, integer smallest-units (non-negative). */
  readonly sizeUnits: bigint;
  /** entry = anchor P₀ as a decimal string (decimal(18,8)). */
  readonly entryPrice: string;
  /** collateral, integer smallest-units (non-negative). */
  readonly collateral: bigint;
  /** leverage as a decimal string — modelled for forward extensibility, but P0 rejects anything but '1'. */
  readonly leverage: string;
  /** realized P&L, signed integer smallest-units. Defaults to 0n (a position opens flat). */
  readonly realizedPnl?: bigint;
  /** unrealized P&L, signed integer smallest-units. Defaults to 0n (entry == mark at open). */
  readonly unrealizedPnl?: bigint;
}

/** A position with smallest-unit magnitudes as bigints; prices/leverage as decimal strings. */
export interface PositionView {
  readonly id: string;
  readonly coupledPairId: string;
  readonly owner: string;
  readonly referenceAsset: string;
  readonly side: PositionSide;
  readonly sizeUnits: bigint;
  readonly entryPrice: string;
  readonly collateral: bigint;
  readonly leverage: string;
  readonly realizedPnl: bigint;
  readonly unrealizedPnl: bigint;
  readonly lifecycle: PositionLifecycle;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Thrown when a position write is structurally/numerically invalid. */
export class InvalidPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPositionError';
  }
}

/** Thrown when a position is created with leverage other than 1x (P0 pins leverage to 1x). */
export class PositionLeverageError extends Error {
  readonly leverage: string;
  constructor(leverage: string) {
    super(
      `Position leverage is pinned to 1x in P0; got '${leverage}'. Leveraged positions (>1x) are post-P0.`,
    );
    this.name = 'PositionLeverageError';
    this.leverage = leverage;
  }
}

/** Thrown when a position operation targets an id that does not exist. */
export class PositionNotFoundError extends Error {
  readonly positionId: string;
  constructor(positionId: string) {
    super(`Position '${positionId}' not found.`);
    this.name = 'PositionNotFoundError';
    this.positionId = positionId;
  }
}

/** Thrown when a lifecycle operation is illegal for the position's current state. */
export class PositionLifecycleError extends Error {
  readonly positionId: string;
  readonly lifecycle: PositionLifecycle;
  constructor(positionId: string, lifecycle: PositionLifecycle, message: string) {
    super(message);
    this.name = 'PositionLifecycleError';
    this.positionId = positionId;
    this.lifecycle = lifecycle;
  }
}

/** Thrown when a position is opened against a missing or CLOSED coupled pair. */
export class ClosedPairError extends Error {
  readonly coupledPairId: string;
  constructor(coupledPairId: string, message: string) {
    super(message);
    this.name = 'ClosedPairError';
    this.coupledPairId = coupledPairId;
  }
}

// Strict decimal string: optional sign, digits, optional fractional part. No exponent/NaN — a
// binary-float text must never reach a NUMERIC column (NFR-2).
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
// entry_price is the frozen decimal(18,8) type; reject higher precision rather than silently round.
const ENTRY_PRICE_MAX_SCALE = 8;
// All-zero magnitude (any scale/sign): '0', '-0', '0.000', etc.
const ZERO_PATTERN = /^-?0+(\.0+)?$/;

function assertDecimalString(label: string, value: string): void {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new InvalidPositionError(`${label} must be a plain decimal string, got '${value}'.`);
  }
}

function assertMaxFractionalDigits(label: string, value: string, maxScale: number): void {
  const fracPart = value.split('.')[1];
  if (fracPart !== undefined && fracPart.length > maxScale) {
    throw new InvalidPositionError(
      `${label} has ${fracPart.length} fractional digits but the frozen type allows at most ${maxScale}; ` +
        `round to ${maxScale} decimals before persisting (no silent precision loss).`,
    );
  }
}

function assertPositiveDecimal(label: string, value: string): void {
  assertDecimalString(label, value);
  if (value.startsWith('-') || ZERO_PATTERN.test(value)) {
    throw new InvalidPositionError(`${label} must be a positive decimal, got '${value}'.`);
  }
}

function assertNonNegativeUnits(label: string, value: bigint): void {
  assertIntegerUnits(label, value);
  if (value < 0n) {
    throw new InvalidPositionError(`${label} must be a non-negative integer, got ${value}.`);
  }
}

function assertIntegerUnits(label: string, value: bigint): void {
  try {
    assertNotFloat(value); // NFR-2: a JS number/float is never a valid smallest-unit amount
  } catch {
    throw new InvalidPositionError(
      `${label} must be a bigint in smallest units, never a binary float (NFR-2).`,
    );
  }
  if (typeof value !== 'bigint') {
    throw new InvalidPositionError(`${label} must be a bigint in smallest units.`);
  }
}

function numericToBigInt(label: string, value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart] = unsigned.split('.');
  if (fracPart !== undefined && /[^0]/.test(fracPart)) {
    throw new Error(`Non-integer ${label} '${value}' read from positions (smallest-units).`);
  }
  const magnitude = BigInt(intPart);
  return negative ? -magnitude : magnitude;
}

function toView(row: Position): PositionView {
  return {
    id: row.id,
    coupledPairId: row.coupledPairId,
    owner: row.owner,
    referenceAsset: row.referenceAsset,
    side: row.side,
    sizeUnits: numericToBigInt('size_units', row.sizeUnits),
    entryPrice: row.entryPrice,
    collateral: numericToBigInt('collateral', row.collateral),
    leverage: row.leverage,
    realizedPnl: numericToBigInt('realized_pnl', row.realizedPnl),
    unrealizedPnl: numericToBigInt('unrealized_pnl', row.unrealizedPnl),
    lifecycle: row.lifecycle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Persists a position layered over an issued coupled pair. Validates the frozen money types
 * (positive entry P₀ at scale 8, non-negative integer size/collateral, signed-integer P&L),
 * REJECTS `leverage !== '1'` (P0 pins leverage to 1x — `PositionLeverageError`), and confirms the
 * referenced pair exists, matches `referenceAsset`, and is not CLOSED (a position never opens
 * against a CLOSED pair — `ClosedPairError`; the DB trigger is the non-bypassable backstop).
 * Returns the persisted `PositionView`. Writes ONLY the `positions` table — no posting, no mint.
 * Accepts a `RoseExecutor` so it can run inside an outer transaction (e.g. the 8.3 open flow).
 */
export async function createPosition(
  db: RoseExecutor,
  input: CreatePositionInput,
): Promise<PositionView> {
  if (typeof input.owner !== 'string' || input.owner.trim().length === 0) {
    throw new InvalidPositionError('owner must be a non-empty string.');
  }
  if (typeof input.referenceAsset !== 'string' || input.referenceAsset.trim().length === 0) {
    throw new InvalidPositionError('referenceAsset must be a non-empty string.');
  }
  if (input.side !== 'LONG' && input.side !== 'SHORT') {
    throw new InvalidPositionError(`side must be 'LONG' or 'SHORT', got '${String(input.side)}'.`);
  }
  // P0 leverage rule: reject anything but exactly 1x BEFORE touching the DB (the CHECK is backstop).
  assertDecimalString('leverage', input.leverage);
  if (!isExactlyOne(input.leverage)) {
    throw new PositionLeverageError(input.leverage);
  }
  assertPositiveDecimal('entryPrice', input.entryPrice);
  assertMaxFractionalDigits('entryPrice', input.entryPrice, ENTRY_PRICE_MAX_SCALE);
  assertNonNegativeUnits('sizeUnits', input.sizeUnits);
  assertNonNegativeUnits('collateral', input.collateral);
  const realizedPnl = input.realizedPnl ?? 0n;
  const unrealizedPnl = input.unrealizedPnl ?? 0n;
  assertIntegerUnits('realizedPnl', realizedPnl);
  assertIntegerUnits('unrealizedPnl', unrealizedPnl);

  // Read the pair: it must exist, match the reference asset, and not be CLOSED. The NOT NULL FK +
  // the BEFORE INSERT trigger are the DB backstops; these checks give precise typed errors.
  const [pair] = await db
    .select({ referenceAsset: coupledPairs.referenceAsset, state: coupledPairs.state })
    .from(coupledPairs)
    .where(eq(coupledPairs.id, input.coupledPairId));
  if (!pair) {
    throw new ClosedPairError(
      input.coupledPairId,
      `Coupled pair '${input.coupledPairId}' not found; a position must reference an issued pair.`,
    );
  }
  if (pair.referenceAsset !== input.referenceAsset.trim()) {
    throw new InvalidPositionError(
      `referenceAsset '${input.referenceAsset}' does not match the linked pair's asset '${pair.referenceAsset}'.`,
    );
  }
  if (pair.state === 'CLOSED') {
    throw new ClosedPairError(
      input.coupledPairId,
      `Cannot open a position against CLOSED coupled pair '${input.coupledPairId}'.`,
    );
  }

  const [row] = await db
    .insert(positions)
    .values({
      coupledPairId: input.coupledPairId,
      owner: input.owner.trim(),
      referenceAsset: input.referenceAsset.trim(),
      side: input.side,
      sizeUnits: input.sizeUnits.toString(),
      entryPrice: input.entryPrice,
      collateral: input.collateral.toString(),
      leverage: input.leverage,
      realizedPnl: realizedPnl.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
    })
    .returning();
  if (!row) {
    throw new Error('Position insert returned no row.');
  }
  return toView(row);
}

/** Reads a position by id. */
export async function getPosition(db: RoseExecutor, id: string): Promise<PositionView | null> {
  const [row] = await db.select().from(positions).where(eq(positions.id, id));
  return row ? toView(row) : null;
}

/** Filter options for {@link listPositionsByOwner} (an optional reference-asset narrowing). */
export interface ListPositionsByOwnerInput {
  /** The per-user owner reference (a non-empty identifier). Required. */
  readonly owner: string;
  /** Optional reference asset to narrow the listing (e.g. one market). */
  readonly referenceAsset?: string;
}

/**
 * Lists a single owner's positions (the per-user directional view, FR-26). A READ-ONLY query over
 * the `positions` table — it writes nothing and mints no leg. Filters by `owner` (required, trimmed,
 * non-empty) and an optional `referenceAsset`; returns OPEN and CLOSED positions ordered by
 * `created_at` (stable for the API/terminal). Reuses `toView` so the frozen money types (bigint
 * magnitudes / decimal-string prices) and signed P&L cross the boundary exactly (NFR-2). This is the
 * read primitive the 8.4 `GET /positions` endpoint composes with the 8.1 mark-to-market service.
 */
export async function listPositionsByOwner(
  db: RoseExecutor,
  input: ListPositionsByOwnerInput,
): Promise<PositionView[]> {
  if (typeof input.owner !== 'string' || input.owner.trim().length === 0) {
    throw new InvalidPositionError('owner must be a non-empty string.');
  }
  const owner = input.owner.trim();
  const filters =
    input.referenceAsset !== undefined && input.referenceAsset.trim().length > 0
      ? and(eq(positions.owner, owner), eq(positions.referenceAsset, input.referenceAsset.trim()))
      : eq(positions.owner, owner);
  const rows = await db.select().from(positions).where(filters).orderBy(positions.createdAt);
  return rows.map(toView);
}

export interface ApplyPositionResetInput {
  readonly positionId: string;
  /** New P₀ anchor price (decimal string) — the position re-anchors to the pair's new anchor. */
  readonly newAnchorPrice: string;
  /** New size/units, integer smallest-units — the fresh symmetric re-base (no carried P&L). */
  readonly newSizeUnits: bigint;
}

/**
 * Applies the D1/D1a settlement boundary to an OPEN position when the underlying pair resets:
 *   • re-anchors `entry` to the new P₀ (`newAnchorPrice`),
 *   • CRYSTALLISES the stored unrealized P&L into realized/withdrawable (`realized += unrealized`),
 *   • zeroes unrealized P&L (no carried P&L into the new cycle),
 *   • re-bases `size` to the pair's fresh symmetric split (`newSizeUnits`).
 * Runs in a row-locking transaction (`SELECT … FOR UPDATE`) so the read-check-write is atomic.
 * Refuses a CLOSED position (`PositionLifecycleError`) and a missing one (`PositionNotFoundError`);
 * validates the frozen field types. The position stays OPEN across the reset. Accepts a
 * `RoseExecutor` so it can run inside the pair-reset transaction (8.3+).
 */
export async function applyPositionReset(
  db: RoseExecutor,
  input: ApplyPositionResetInput,
): Promise<PositionView> {
  assertPositiveDecimal('newAnchorPrice', input.newAnchorPrice);
  assertMaxFractionalDigits('newAnchorPrice', input.newAnchorPrice, ENTRY_PRICE_MAX_SCALE);
  assertNonNegativeUnits('newSizeUnits', input.newSizeUnits);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(positions)
      .where(eq(positions.id, input.positionId))
      .for('update');
    if (!current) {
      throw new PositionNotFoundError(input.positionId);
    }
    if (current.lifecycle !== 'OPEN') {
      throw new PositionLifecycleError(
        input.positionId,
        current.lifecycle,
        `Cannot reset position '${input.positionId}' in lifecycle '${current.lifecycle}': only OPEN positions reset.`,
      );
    }
    const realized = numericToBigInt('realized_pnl', current.realizedPnl);
    const unrealized = numericToBigInt('unrealized_pnl', current.unrealizedPnl);
    const crystallisedRealized = realized + unrealized;

    const [updated] = await tx
      .update(positions)
      .set({
        entryPrice: input.newAnchorPrice,
        sizeUnits: input.newSizeUnits.toString(),
        realizedPnl: crystallisedRealized.toString(),
        unrealizedPnl: '0',
        updatedAt: sql`now()`,
      })
      .where(eq(positions.id, input.positionId))
      .returning();
    if (!updated) {
      throw new Error('Position reset update returned no row.');
    }
    return toView(updated);
  });
}

/**
 * Transitions an OPEN position to CLOSED (the terminal lifecycle move). Runs in a row-locking
 * transaction. Rejects a double-close (`PositionLifecycleError`) and a missing position
 * (`PositionNotFoundError`). This is the LIFECYCLE transition only — the economic close (redeem/
 * burn over the FR-21 path, with balanced journal entries) is Story 8.3. Advances `updated_at`.
 */
export async function closePosition(db: RoseExecutor, positionId: string): Promise<PositionView> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(positions)
      .where(eq(positions.id, positionId))
      .for('update');
    if (!current) {
      throw new PositionNotFoundError(positionId);
    }
    if (current.lifecycle === 'CLOSED') {
      throw new PositionLifecycleError(
        positionId,
        current.lifecycle,
        `Position '${positionId}' is already CLOSED (no re-close).`,
      );
    }
    const [updated] = await tx
      .update(positions)
      .set({ lifecycle: 'CLOSED', updatedAt: sql`now()` })
      .where(and(eq(positions.id, positionId), eq(positions.lifecycle, 'OPEN')))
      .returning();
    if (!updated) {
      throw new Error('Position close update returned no row.');
    }
    return toView(updated);
  });
}

// '1', '1.0', '01', '1.000' — all exactly one. Reject '1.0001', '2', '0.5', etc.
function isExactlyOne(value: string): boolean {
  if (value.startsWith('-')) {
    return false;
  }
  const [intPart = '0', fracPart] = value.split('.');
  const intIsOne = BigInt(intPart) === 1n;
  const fracIsZero = fracPart === undefined || !/[^0]/.test(fracPart);
  return intIsOne && fracIsZero;
}
