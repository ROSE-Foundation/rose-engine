// Rose Note repository (FR-12) — embeds EXACTLY ONE coupled pair in a Rose Note, delta-neutral at
// issuance. `createRoseNote` reads the referenced pair, refuses unless its two legs are at EQUAL
// notional (delta-neutral / market-neutral on the underlying) at the moment of creation, then
// persists the note. The DB BEFORE INSERT trigger (migration 0005) is the non-bypassable backstop.
//
// "Delta-neutral at issuance" only: the guard binds at creation. After issuance the pair's legs may
// diverge (directional risk from strategy, FR-12) without invalidating the already-issued note.
//
// Smallest-unit leg notionals cross as `bigint`; the delta-neutrality check is a pure bigint
// equality off the already-validated `CoupledPairView` — never a binary float (NFR-2).
//
// AC-2 (D1 parked): this layer models only the Note↔pair link; it encodes NO composition mode
// (bundled vs separate L/S) and NO post-reset loss-allocation.
import { eq } from 'drizzle-orm';
import type { RoseDb, RoseExecutor } from '../db.js';
import { roseNotes } from '../schema/index.js';
import type { RoseNote } from '../schema/index.js';
import { CoupledPairNotFoundError, getCoupledPair } from './coupled-pairs.js';

export interface CreateRoseNoteInput {
  /** The single coupled pair to embed. Exactly one — required, no lone-or-many. */
  readonly coupledPairId: string;
}

/** A Rose Note: the persisted Note↔pair embedding. */
export interface RoseNoteView {
  readonly id: string;
  readonly coupledPairId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Thrown when a note would embed a pair whose legs are not at equal notional at issuance. */
export class NotDeltaNeutralError extends Error {
  readonly coupledPairId: string;
  readonly longLegValue: bigint;
  readonly shortLegValue: bigint;
  constructor(coupledPairId: string, longLegValue: bigint, shortLegValue: bigint) {
    super(
      `Rose Note must embed a delta-neutral coupled pair at issuance: pair '${coupledPairId}' has ` +
        `legs ${longLegValue} <> ${shortLegValue} (long != short notional).`,
    );
    this.name = 'NotDeltaNeutralError';
    this.coupledPairId = coupledPairId;
    this.longLegValue = longLegValue;
    this.shortLegValue = shortLegValue;
  }
}

function toView(row: RoseNote): RoseNoteView {
  return {
    id: row.id,
    coupledPairId: row.coupledPairId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Creates a Rose Note embedding EXACTLY ONE coupled pair, requiring delta-neutrality at issuance
 * (the pair's two legs at equal notional). Throws `CoupledPairNotFoundError` if the pair is absent,
 * `NotDeltaNeutralError` if the legs are not equal notional. Structural guarantees: the single
 * NOT NULL `coupled_pair_id` column makes "exactly one pair" (zero/two are unrepresentable), and the
 * separate UNIQUE constraint makes "at most one note per pair" (1:1 embedding — a documented P0
 * interpretation, not an AC requirement). The DB BEFORE INSERT OR UPDATE trigger is the
 * non-bypassable delta-neutrality backstop behind this guard (it also blocks re-pointing a note to a
 * skewed pair via raw UPDATE).
 *
 * Note: this data-model layer does NOT require the embedded pair to be issued/ACTIVE or to carry
 * positive notional — a delta-neutral 0/0 pair is accepted (0 == 0). Economic substance (positive
 * legs) is enforced upstream at issuance (Story 2.3 rejects a zero-value leg) and at live
 * subscription (Epic 6); keeping this layer minimal is consistent with AC-2.
 * Accepts a `RoseExecutor` so it can run inside an outer transaction (e.g. Epic 6 subscription).
 */
export async function createRoseNote(
  db: RoseExecutor,
  input: CreateRoseNoteInput,
): Promise<RoseNoteView> {
  if (typeof input.coupledPairId !== 'string' || input.coupledPairId.trim().length === 0) {
    throw new CoupledPairNotFoundError(String(input.coupledPairId));
  }

  const pair = await getCoupledPair(db, input.coupledPairId);
  if (!pair) {
    throw new CoupledPairNotFoundError(input.coupledPairId);
  }

  // Delta-neutral at issuance: equal-notional legs. Pure bigint equality (no float, NFR-2).
  if (pair.longLegValue !== pair.shortLegValue) {
    throw new NotDeltaNeutralError(pair.id, pair.longLegValue, pair.shortLegValue);
  }

  const [row] = await db
    .insert(roseNotes)
    .values({ coupledPairId: input.coupledPairId })
    .returning();
  if (!row) {
    throw new Error('Rose Note insert returned no row.');
  }
  return toView(row);
}

/** Reads a Rose Note by id. */
export async function getRoseNote(db: RoseDb, id: string): Promise<RoseNoteView | null> {
  const row = await db.query.roseNotes.findFirst({ where: eq(roseNotes.id, id) });
  return row ? toView(row) : null;
}
