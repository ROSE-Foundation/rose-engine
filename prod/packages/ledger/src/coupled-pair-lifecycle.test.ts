// Story 2.2 — the coupled-pair lifecycle state machine (FR-4), test-first on the invariant.
// Proves a full legal traversal succeeds and every illegal transition is rejected at BOTH layers:
// the typed app-level guard (`transitionPair`) and the non-bypassable DB trigger (migration 0004),
// and that the two encodings agree over all distinct ordered state pairs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateDown, migrateUp } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { migration0004 } from './migrations/0004-coupled-pair-lifecycle.js';
import type { CoupledPairState } from './schema/index.js';
import {
  COUPLED_PAIR_TRANSITIONS,
  CoupledPairNotFoundError,
  IllegalPairTransitionError,
  createCoupledPair,
  getCoupledPair,
  isPairTransitionAllowed,
  transitionPair,
} from './repositories/coupled-pairs.js';

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
  await pool.query('TRUNCATE coupled_pairs CASCADE');
});

const ALL_STATES: readonly CoupledPairState[] = [
  'PENDING',
  'ACTIVE',
  'REBALANCING',
  'PARTIAL',
  'SETTLING',
  'CLOSED',
];

// A complete, valid pair seeded into a chosen start state (INSERT is not guarded by the
// BEFORE UPDATE trigger, so any start state can be seeded directly).
const baseInput = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.10500000',
  leverage: '1',
  collateralPool: 1_000_000n,
  floor: '0.5',
  longLegValue: 500_000n,
  shortLegValue: 500_000n,
} as const;

async function seedPairAt(state: CoupledPairState): Promise<string> {
  const created = await createCoupledPair(db, { ...baseInput, state });
  return created.id;
}

describe('AC-2 — full legal traversal, each state observable (SM-3)', () => {
  it('drives a PENDING pair through PENDING → ACTIVE → REBALANCING → PARTIAL → SETTLING → CLOSED, observing each state', async () => {
    const created = await createCoupledPair(db, baseInput);
    expect(created.state).toBe('PENDING');
    expect((await getCoupledPair(db, created.id))!.state).toBe('PENDING');

    const path: readonly CoupledPairState[] = [
      'ACTIVE',
      'REBALANCING',
      'PARTIAL',
      'SETTLING',
      'CLOSED',
    ];
    for (const next of path) {
      const updated = await transitionPair(db, created.id, next);
      expect(updated.state).toBe(next);
      // The transition is observable by a reader immediately.
      expect((await getCoupledPair(db, created.id))!.state).toBe(next);
    }
    // Every one of the six states was visited exactly once across the traversal.
    const visited = new Set<CoupledPairState>(['PENDING', ...path]);
    expect([...visited].sort()).toEqual([...ALL_STATES].sort());
  });

  it('advances updated_at when a transition occurs', async () => {
    const created = await createCoupledPair(db, baseInput);
    const before = (await getCoupledPair(db, created.id))!.updatedAt.getTime();
    // Ensure the clock advances measurably regardless of timer granularity.
    await pool.query('SELECT pg_sleep(0.01)');
    await transitionPair(db, created.id, 'ACTIVE');
    const after = (await getCoupledPair(db, created.id))!.updatedAt.getTime();
    expect(after).toBeGreaterThan(before);
  });
});

describe('AC-1 — only valid transitions accepted; others rejected explicitly (app layer)', () => {
  it('accepts each legal transition out of every state', async () => {
    for (const from of ALL_STATES) {
      for (const to of COUPLED_PAIR_TRANSITIONS[from]) {
        const id = await seedPairAt(from);
        const updated = await transitionPair(db, id, to);
        expect(updated.state).toBe(to);
      }
    }
  });

  it('rejects representative illegal transitions with a typed IllegalPairTransitionError', async () => {
    const cases: ReadonlyArray<readonly [CoupledPairState, CoupledPairState]> = [
      ['PENDING', 'CLOSED'], // skip the whole lifecycle
      ['PENDING', 'REBALANCING'], // skip ACTIVE
      ['ACTIVE', 'PENDING'], // backward
      ['ACTIVE', 'CLOSED'], // skip SETTLING
      ['ACTIVE', 'PARTIAL'], // PARTIAL is only reachable mid-rebalance, not directly
      ['REBALANCING', 'CLOSED'], // must settle before close
      ['SETTLING', 'ACTIVE'], // settling is one-way toward close
      ['CLOSED', 'ACTIVE'], // resurrection of a terminal pair
      ['CLOSED', 'SETTLING'],
    ];
    for (const [from, to] of cases) {
      const id = await seedPairAt(from);
      await expect(transitionPair(db, id, to)).rejects.toBeInstanceOf(IllegalPairTransitionError);
      // The state is unchanged after a rejected transition.
      expect((await getCoupledPair(db, id))!.state).toBe(from);
    }
  });

  it('rejects a same-state no-op as an illegal transition (a transition must change state)', async () => {
    const id = await seedPairAt('ACTIVE');
    await expect(transitionPair(db, id, 'ACTIVE')).rejects.toBeInstanceOf(
      IllegalPairTransitionError,
    );
  });

  it('carries structured fields on the typed error', async () => {
    const id = await seedPairAt('PENDING');
    await expect(transitionPair(db, id, 'CLOSED')).rejects.toMatchObject({
      name: 'IllegalPairTransitionError',
      pairId: id,
      from: 'PENDING',
      to: 'CLOSED',
    });
  });

  it('throws CoupledPairNotFoundError for an unknown pair id', async () => {
    await expect(
      transitionPair(db, '00000000-0000-4000-8000-0000000000ff', 'ACTIVE'),
    ).rejects.toBeInstanceOf(CoupledPairNotFoundError);
  });
});

describe('PARTIAL is a known transient mid-rebalance state', () => {
  it('is reachable only from within a rebalance and can resume/return/proceed', async () => {
    // Reached from REBALANCING (not directly from ACTIVE).
    const id = await seedPairAt('REBALANCING');
    await transitionPair(db, id, 'PARTIAL');
    expect((await getCoupledPair(db, id))!.state).toBe('PARTIAL');

    // From PARTIAL it can resume the rebalance, return to ACTIVE, or proceed to SETTLING.
    expect(isPairTransitionAllowed('PARTIAL', 'REBALANCING')).toBe(true);
    expect(isPairTransitionAllowed('PARTIAL', 'ACTIVE')).toBe(true);
    expect(isPairTransitionAllowed('PARTIAL', 'SETTLING')).toBe(true);
    // But not directly to CLOSED, nor back to PENDING.
    expect(isPairTransitionAllowed('PARTIAL', 'CLOSED')).toBe(false);
    expect(isPairTransitionAllowed('PARTIAL', 'PENDING')).toBe(false);

    // ACTIVE → PARTIAL is not a legal direct transition.
    expect(isPairTransitionAllowed('ACTIVE', 'PARTIAL')).toBe(false);
  });
});

describe('AC-1 — DB trigger is the non-bypassable backstop (raw SQL, repo bypassed)', () => {
  it('rejects an illegal transition performed via raw UPDATE', async () => {
    const id = await seedPairAt('PENDING');
    await expect(
      pool.query(`UPDATE coupled_pairs SET state = 'CLOSED' WHERE id = $1`, [id]),
    ).rejects.toThrow(/Illegal coupled-pair lifecycle transition/);
    // The row is unchanged.
    expect((await getCoupledPair(db, id))!.state).toBe('PENDING');
  });

  it('accepts a legal transition performed via raw UPDATE', async () => {
    const id = await seedPairAt('PENDING');
    await pool.query(`UPDATE coupled_pairs SET state = 'ACTIVE' WHERE id = $1`, [id]);
    expect((await getCoupledPair(db, id))!.state).toBe('ACTIVE');
  });

  it('leaves non-state updates unaffected (the trigger guards only state changes)', async () => {
    const id = await seedPairAt('ACTIVE');
    // Updating a non-state column on an ACTIVE pair must not trip the lifecycle trigger.
    await pool.query(`UPDATE coupled_pairs SET anchor_price = '1.20000000' WHERE id = $1`, [id]);
    const read = await getCoupledPair(db, id);
    expect(read!.anchorPrice).toBe('1.20000000');
    expect(read!.state).toBe('ACTIVE');
  });

  it('treats a same-state raw UPDATE as a no-op (not a transition) — it is allowed', async () => {
    const id = await seedPairAt('CLOSED');
    // state = state is not a state CHANGE, so the trigger does not fire even for terminal CLOSED.
    await expect(
      pool.query(`UPDATE coupled_pairs SET state = 'CLOSED' WHERE id = $1`, [id]),
    ).resolves.toBeDefined();
    expect((await getCoupledPair(db, id))!.state).toBe('CLOSED');
  });
});

describe('app guard and DB trigger encode the SAME transition set', () => {
  it('agrees on every distinct ordered state pair (30 combinations)', async () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue; // same-state is a no-op, not a transition (see notes)
        const id = await seedPairAt(from);
        const appAllows = isPairTransitionAllowed(from, to);
        let dbAllows = true;
        try {
          await pool.query(`UPDATE coupled_pairs SET state = $2 WHERE id = $1`, [id, to]);
        } catch {
          dbAllows = false;
        }
        expect(
          dbAllows,
          `DB and app disagree on ${from} -> ${to} (app=${appAllows}, db=${dbAllows})`,
        ).toBe(appAllows);
      }
    }
  });
});

describe('migration 0004 reversibility (NFR-5)', () => {
  it('forward → down → forward re-creates the lifecycle trigger and function', async () => {
    // Roll back to before 0004 — derive the step count from MIGRATIONS so appending later
    // migrations never needs this number bumped; the trigger/function must then be gone.
    const stepsToBefore0004 = MIGRATIONS.filter((m) => m.version >= migration0004.version).length;
    await migrateDown(pool, stepsToBefore0004);
    const fnGone = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'enforce_coupled_pair_transition'`,
    );
    expect(fnGone.rows[0]!.n).toBe(0);
    const triggerGone = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_coupled_pairs_lifecycle'`,
    );
    expect(triggerGone.rows[0]!.n).toBe(0);

    // Re-apply 0004; the backstop is restored.
    const applied = await migrateUp(pool);
    expect(applied).toContain(migration0004.version);
    const id = await seedPairAt('PENDING');
    await expect(
      pool.query(`UPDATE coupled_pairs SET state = 'CLOSED' WHERE id = $1`, [id]),
    ).rejects.toThrow(/Illegal coupled-pair lifecycle transition/);
  });
});
