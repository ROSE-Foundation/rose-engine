// Story 2.4 — embed a coupled pair in a Rose Note, delta-neutral at issuance (FR-12), test-first
// on the invariant. Proves: a note references EXACTLY ONE coupled pair whose legs are at equal
// notional (delta-neutral) at issuance (AC-1), rejected at BOTH the app layer (NotDeltaNeutralError)
// AND the DB layer (BEFORE INSERT trigger, non-bypassable); exactly-one is structural (NOT NULL +
// UNIQUE FK); a bogus FK is rejected; post-issuance leg divergence does NOT invalidate the note;
// and the schema does not encode the parked D1 loss-allocation/composition decision (AC-2).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateUp } from './migrate.js';
import {
  type CreateCoupledPairInput,
  CoupledPairNotFoundError,
  createCoupledPair,
} from './repositories/coupled-pairs.js';
import { NotDeltaNeutralError, createRoseNote, getRoseNote } from './repositories/rose-notes.js';

let pool: pg.Pool;
let db: RoseDb;

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // CASCADE clears rose_notes (FK from coupled_pairs); truncate journal_entries too for isolation.
  await pool.query('TRUNCATE coupled_pairs, journal_entries CASCADE');
});

const basePair: CreateCoupledPairInput = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.10500000',
  leverage: '1',
  collateralPool: 1_000_000n,
  floor: '0.5',
  longLegValue: 500_000n,
  shortLegValue: 500_000n, // delta-neutral: equal notional
};

async function countNotes(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM rose_notes');
  return rows[0]!.n;
}

describe('AC-1 — a Rose Note references exactly one delta-neutral coupled pair at issuance', () => {
  it('creates a note over a delta-neutral pair and reads it back', async () => {
    const pair = await createCoupledPair(db, basePair);
    const note = await createRoseNote(db, { coupledPairId: pair.id });

    expect(note.coupledPairId).toBe(pair.id);
    expect(await countNotes()).toBe(1);

    const fetched = await getRoseNote(db, note.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.coupledPairId).toBe(pair.id);
  });

  it('rejects a note over a non-delta-neutral pair (app guard) and persists nothing', async () => {
    const skewed = await createCoupledPair(db, { ...basePair, longLegValue: 600_000n });
    await expect(createRoseNote(db, { coupledPairId: skewed.id })).rejects.toMatchObject({
      name: 'NotDeltaNeutralError',
      coupledPairId: skewed.id,
      longLegValue: 600_000n,
      shortLegValue: 500_000n,
    });
    expect(await createRoseNote(db, { coupledPairId: skewed.id }).catch((e) => e)).toBeInstanceOf(
      NotDeltaNeutralError,
    );
    expect(await countNotes()).toBe(0);
  });

  it('rejects a RAW insert over a non-delta-neutral pair via the DB trigger (non-bypassable)', async () => {
    const skewed = await createCoupledPair(db, { ...basePair, shortLegValue: 400_000n });
    await expect(
      pool.query('INSERT INTO rose_notes (coupled_pair_id) VALUES ($1)', [skewed.id]),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
    expect(await countNotes()).toBe(0);
  });

  it('allows a raw insert over a delta-neutral pair (trigger passes the happy path)', async () => {
    const pair = await createCoupledPair(db, basePair);
    await pool.query('INSERT INTO rose_notes (coupled_pair_id) VALUES ($1)', [pair.id]);
    expect(await countNotes()).toBe(1);
  });
});

describe('AC-1 — exactly one: at most one note per pair, FK enforced', () => {
  it('rejects a second note over the SAME pair (UNIQUE coupled_pair_id)', async () => {
    const pair = await createCoupledPair(db, basePair);
    await createRoseNote(db, { coupledPairId: pair.id });
    // The drizzle insert path wraps the pg error; the unique_violation code is on `.cause`.
    await expect(createRoseNote(db, { coupledPairId: pair.id })).rejects.toMatchObject({
      cause: { code: '23505' }, // unique_violation
    });
    expect(await countNotes()).toBe(1);
  });

  it('throws CoupledPairNotFoundError for a non-existent pair id (app layer)', async () => {
    await expect(
      createRoseNote(db, { coupledPairId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(CoupledPairNotFoundError);
    expect(await countNotes()).toBe(0);
  });

  it('rejects a raw insert over a non-existent pair (foreign_key_violation)', async () => {
    // For an absent pair the trigger reads NULL legs and passes the row through (it owns only
    // delta-neutrality), so the column's REFERENCES FK constraint is what rejects — a real FK test.
    await expect(
      pool.query('INSERT INTO rose_notes (coupled_pair_id) VALUES ($1)', [
        '00000000-0000-0000-0000-000000000000',
      ]),
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
    expect(await countNotes()).toBe(0);
  });

  it('rejects a raw insert with a NULL coupled_pair_id (the "zero pairs" arm — NOT NULL)', async () => {
    // "Exactly one" lower bound: a note referencing zero pairs is rejected by the NOT NULL column.
    await expect(
      pool.query('INSERT INTO rose_notes (coupled_pair_id) VALUES (NULL)'),
    ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
    expect(await countNotes()).toBe(0);
  });
});

describe('AC-1 — delta-neutrality is non-bypassable: re-pointing a note via raw UPDATE is checked', () => {
  it('rejects an UPDATE that re-points a note to a skewed pair (BEFORE UPDATE backstop)', async () => {
    const neutral = await createCoupledPair(db, basePair);
    const skewed = await createCoupledPair(db, { ...basePair, shortLegValue: 400_000n });
    const note = await createRoseNote(db, { coupledPairId: neutral.id });

    // Re-pointing the note to a non-delta-neutral pair is a fresh issuance against that pair — the
    // trigger now fires on UPDATE (when coupled_pair_id changes) and rejects it (check_violation).
    await expect(
      pool.query('UPDATE rose_notes SET coupled_pair_id = $1 WHERE id = $2', [skewed.id, note.id]),
    ).rejects.toMatchObject({ code: '23514' });

    // The note still points at the original delta-neutral pair.
    const fetched = await getRoseNote(db, note.id);
    expect(fetched!.coupledPairId).toBe(neutral.id);
  });

  it('allows an UPDATE that does not change coupled_pair_id even after the pair legs diverge', async () => {
    const pair = await createCoupledPair(db, basePair);
    const note = await createRoseNote(db, { coupledPairId: pair.id });
    // Post-issuance the pair's own legs diverge (directional risk from strategy)…
    await pool.query('UPDATE coupled_pairs SET long_leg_value = $1 WHERE id = $2', [
      '900000',
      pair.id,
    ]);
    // …and a no-op-FK update of the note (bump updated_at) is NOT blocked by the trigger.
    await pool.query('UPDATE rose_notes SET updated_at = now() WHERE id = $1', [note.id]);
    const fetched = await getRoseNote(db, note.id);
    expect(fetched!.coupledPairId).toBe(pair.id);
  });
});

describe('AC-1 — delta-neutral AT ISSUANCE only (post-issuance divergence allowed)', () => {
  it('does not retroactively invalidate a note when the pair legs later diverge', async () => {
    const pair = await createCoupledPair(db, basePair);
    const note = await createRoseNote(db, { coupledPairId: pair.id });

    // After issuance, the legs diverge (directional risk from strategy). The BEFORE INSERT trigger
    // does not fire on the pair UPDATE, and the existing note remains valid.
    await pool.query('UPDATE coupled_pairs SET long_leg_value = $1 WHERE id = $2', [
      '900000',
      pair.id,
    ]);
    expect(await countNotes()).toBe(1);
    const fetched = await getRoseNote(db, note.id);
    expect(fetched!.coupledPairId).toBe(pair.id);
  });
});

describe('AC-1 — delta-neutral boundary: a 0/0 pair is equal-notional (accepted by design)', () => {
  it('accepts a note over a delta-neutral 0/0 pair (economic substance is enforced upstream)', async () => {
    // 0 == 0 is delta-neutral. This data-model layer does not require positive notional or an
    // ACTIVE/issued pair — economic substance is enforced at issuance (Story 2.3 rejects a zero-value
    // leg) and at live subscription (Epic 6). Locked here so the decision is explicit, not implicit.
    const zeroPair = await createCoupledPair(db, {
      ...basePair,
      longLegValue: 0n,
      shortLegValue: 0n,
    });
    const note = await createRoseNote(db, { coupledPairId: zeroPair.id });
    expect(note.coupledPairId).toBe(zeroPair.id);
    expect(await countNotes()).toBe(1);
  });
});

describe('AC-2 — schema accommodates either D1 interpretation (no loss-allocation column)', () => {
  it('rose_notes has exactly the minimal column set (no composition/loss-allocation columns)', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'rose_notes' ORDER BY column_name`,
    );
    const columns = rows.map((r) => r.column_name).sort();
    expect(columns).toEqual(['coupled_pair_id', 'created_at', 'id', 'updated_at']);
  });
});
