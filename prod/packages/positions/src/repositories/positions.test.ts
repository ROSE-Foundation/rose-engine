// Story 8.2 — the off-chain per-user position model. Test-first on the invariants (NFR-6):
//   • exact money round-trip (integer smallest-unit bigints / decimal(18,8) entry);
//   • a position ALWAYS references an issued pair (NOT NULL FK) — no lone-leg representation;
//   • leverage is pinned to 1x (app guard + DB CHECK backstop);
//   • the D1/D1a RESET re-anchors entry, crystallises unrealized→realized, re-bases size (no carry);
//   • a position never outlives a CLOSED pair (both trigger directions);
//   • the layer writes no postings / mints no leg.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  transitionPair,
  type CoupledPairState,
  type RoseDb,
} from '@rose/ledger';
import {
  applyPositionReset,
  ClosedPairError,
  closePosition,
  createPosition,
  getPosition,
  InvalidPositionError,
  PositionLeverageError,
  PositionLifecycleError,
  PositionNotFoundError,
  type CreatePositionInput,
} from './positions.js';

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
  await pool.query('TRUNCATE positions, coupled_pairs CASCADE');
});

const pairInput = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.08500000',
  leverage: '1',
  collateralPool: 1_000_000n,
  floor: '0.30',
  longLegValue: 500_000n,
  shortLegValue: 500_000n,
} as const;

async function seedPair(state?: CoupledPairState): Promise<string> {
  const created = await createCoupledPair(db, { ...pairInput, ...(state ? { state } : {}) });
  return created.id;
}

/** Walks the error `cause` chain and returns the first pg SQLSTATE `code` found, if any. */
function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error || (typeof current === 'object' && current !== null)) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === current) {
      break;
    }
    current = cause;
  }
  return undefined;
}

async function expectRejectionPgCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(pgErrorCode(error)).toBe(code);
    return;
  }
  throw new Error(`Expected a rejection with pg code ${code}, but the promise resolved.`);
}

function positionInput(coupledPairId: string, over: Partial<CreatePositionInput> = {}) {
  return {
    coupledPairId,
    owner: 'subscriber-1',
    referenceAsset: 'EUR/USD',
    side: 'LONG',
    sizeUnits: 500_000n,
    entryPrice: '1.08500000',
    collateral: 250_000n,
    leverage: '1',
    ...over,
  } satisfies CreatePositionInput;
}

describe('createPosition — persistence + frozen money types (AC #1)', () => {
  it('round-trips every field exactly (bigint smallest-units, decimal(18,8) entry)', async () => {
    const pairId = await seedPair();
    const created = await createPosition(db, positionInput(pairId));

    expect(created.coupledPairId).toBe(pairId);
    expect(created.owner).toBe('subscriber-1');
    expect(created.referenceAsset).toBe('EUR/USD');
    expect(created.side).toBe('LONG');
    expect(created.sizeUnits).toBe(500_000n);
    expect(created.entryPrice).toBe('1.08500000');
    expect(created.collateral).toBe(250_000n);
    expect(created.leverage).toBe('1');
    expect(created.realizedPnl).toBe(0n);
    expect(created.unrealizedPnl).toBe(0n);
    expect(created.lifecycle).toBe('OPEN');

    const read = await getPosition(db, created.id);
    expect(read).toEqual(created);
  });

  it('persists a SHORT side and signed (negative) P&L exactly', async () => {
    const pairId = await seedPair();
    const created = await createPosition(
      db,
      positionInput(pairId, { side: 'SHORT', unrealizedPnl: -12_345n, realizedPnl: -1n }),
    );
    expect(created.side).toBe('SHORT');
    expect(created.unrealizedPnl).toBe(-12_345n);
    expect(created.realizedPnl).toBe(-1n);
  });

  it('rejects a non-existent pair (a position must reference an issued pair)', async () => {
    await expect(
      createPosition(db, positionInput('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(ClosedPairError);
  });

  it('a raw insert with no coupled_pair_id is rejected by the NOT NULL FK (no lone leg)', async () => {
    await expect(
      pool.query(
        `INSERT INTO positions (owner, reference_asset, side, size_units, entry_price, collateral)
         VALUES ('o', 'EUR/USD', 'LONG', 1, 1.085, 1)`,
      ),
    ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
  });

  it('rejects a reference asset that does not match the linked pair', async () => {
    const pairId = await seedPair();
    await expect(
      createPosition(db, positionInput(pairId, { referenceAsset: 'BTC/USD' })),
    ).rejects.toBeInstanceOf(InvalidPositionError);
  });

  it('rejects float / over-precision / negative magnitudes (NFR-2)', async () => {
    const pairId = await seedPair();
    await expect(
      createPosition(db, positionInput(pairId, { entryPrice: '1.085000001' })),
    ).rejects.toBeInstanceOf(InvalidPositionError); // > scale 8
    await expect(
      createPosition(db, positionInput(pairId, { sizeUnits: -1n })),
    ).rejects.toBeInstanceOf(InvalidPositionError);
    await expect(
      createPosition(db, positionInput(pairId, { entryPrice: '0' })),
    ).rejects.toBeInstanceOf(InvalidPositionError); // entry must be positive
  });
});

describe('leverage pinned to 1x (AC #2)', () => {
  it('rejects leverage != 1 at the app boundary (PositionLeverageError)', async () => {
    const pairId = await seedPair();
    await expect(
      createPosition(db, positionInput(pairId, { leverage: '2' })),
    ).rejects.toBeInstanceOf(PositionLeverageError);
    await expect(
      createPosition(db, positionInput(pairId, { leverage: '0.5' })),
    ).rejects.toBeInstanceOf(PositionLeverageError);
  });

  it('accepts the canonical 1x and its zero-padded forms', async () => {
    const pairId = await seedPair();
    const a = await createPosition(db, positionInput(pairId, { leverage: '1' }));
    expect(a.leverage).toBe('1');
    const b = await createPosition(db, positionInput(pairId, { leverage: '1.0' }));
    expect(b.leverage).toBe('1.0');
  });

  it('the DB CHECK is the non-bypassable backstop for a raw insert with leverage = 2', async () => {
    const pairId = await seedPair();
    await expect(
      pool.query(
        `INSERT INTO positions (coupled_pair_id, owner, reference_asset, side, size_units, entry_price, collateral, leverage)
         VALUES ($1, 'o', 'EUR/USD', 'LONG', 1, 1.085, 1, 2)`,
        [pairId],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });
});

describe('applyPositionReset — D1/D1a re-anchor / crystallise / re-base (AC #3)', () => {
  it('re-anchors entry, crystallises unrealized→realized, re-bases size, carries no P&L', async () => {
    const pairId = await seedPair();
    const opened = await createPosition(
      db,
      positionInput(pairId, { realizedPnl: 1_000n, unrealizedPnl: 25_000n }),
    );

    const reset = await applyPositionReset(db, {
      positionId: opened.id,
      newAnchorPrice: '1.12000000',
      newSizeUnits: 480_000n,
    });

    // entry re-anchors to the new P₀.
    expect(reset.entryPrice).toBe('1.12000000');
    // unrealized crystallises into realized (1_000 + 25_000), and unrealized resets to 0 (no carry).
    expect(reset.realizedPnl).toBe(26_000n);
    expect(reset.unrealizedPnl).toBe(0n);
    // size re-bases to the pair's fresh symmetric split.
    expect(reset.sizeUnits).toBe(480_000n);
    // still OPEN across the reset; updated_at advanced.
    expect(reset.lifecycle).toBe('OPEN');
    expect(reset.updatedAt.getTime()).toBeGreaterThanOrEqual(opened.updatedAt.getTime());
  });

  it('crystallises a losing (negative) unrealized P&L into realized', async () => {
    const pairId = await seedPair();
    const opened = await createPosition(
      db,
      positionInput(pairId, { realizedPnl: 0n, unrealizedPnl: -40_000n }),
    );
    const reset = await applyPositionReset(db, {
      positionId: opened.id,
      newAnchorPrice: '1.00000000',
      newSizeUnits: 500_000n,
    });
    expect(reset.realizedPnl).toBe(-40_000n);
    expect(reset.unrealizedPnl).toBe(0n);
  });

  it('refuses to reset a CLOSED position (PositionLifecycleError)', async () => {
    const pairId = await seedPair();
    const opened = await createPosition(db, positionInput(pairId));
    await closePosition(db, opened.id);
    await expect(
      applyPositionReset(db, {
        positionId: opened.id,
        newAnchorPrice: '1.10000000',
        newSizeUnits: 500_000n,
      }),
    ).rejects.toBeInstanceOf(PositionLifecycleError);
  });

  it('refuses to reset a missing position (PositionNotFoundError)', async () => {
    await expect(
      applyPositionReset(db, {
        positionId: '00000000-0000-0000-0000-000000000000',
        newAnchorPrice: '1.10000000',
        newSizeUnits: 1n,
      }),
    ).rejects.toBeInstanceOf(PositionNotFoundError);
  });
});

describe('closePosition — lifecycle OPEN → CLOSED (AC #3)', () => {
  it('transitions OPEN → CLOSED and rejects a double-close', async () => {
    const pairId = await seedPair();
    const opened = await createPosition(db, positionInput(pairId));
    const closed = await closePosition(db, opened.id);
    expect(closed.lifecycle).toBe('CLOSED');
    await expect(closePosition(db, opened.id)).rejects.toBeInstanceOf(PositionLifecycleError);
  });
});

describe('a position never outlives a CLOSED pair (AC #3)', () => {
  it('cannot open a position against a CLOSED pair (app guard)', async () => {
    // Drive a fresh pair through its lifecycle to CLOSED (PENDING→ACTIVE→SETTLING→CLOSED).
    const pairId = await seedPair();
    await transitionPair(db, pairId, 'ACTIVE');
    await transitionPair(db, pairId, 'SETTLING');
    await transitionPair(db, pairId, 'CLOSED');
    await expect(createPosition(db, positionInput(pairId))).rejects.toBeInstanceOf(ClosedPairError);
  });

  it('a raw insert of an OPEN position against a CLOSED pair is rejected by the trigger', async () => {
    const pairId = await seedPair();
    await transitionPair(db, pairId, 'ACTIVE');
    await transitionPair(db, pairId, 'SETTLING');
    await transitionPair(db, pairId, 'CLOSED');
    await expect(
      pool.query(
        `INSERT INTO positions (coupled_pair_id, owner, reference_asset, side, size_units, entry_price, collateral)
         VALUES ($1, 'o', 'EUR/USD', 'LONG', 1, 1.085, 1)`,
        [pairId],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation from the trigger
  });

  it('cannot CLOSE a pair while an OPEN position references it (trigger backstop)', async () => {
    const pairId = await seedPair();
    await createPosition(db, positionInput(pairId));
    await transitionPair(db, pairId, 'ACTIVE');
    await transitionPair(db, pairId, 'SETTLING');
    // The trigger fires inside transitionPair's drizzle transaction (the pg error is wrapped).
    await expectRejectionPgCode(transitionPair(db, pairId, 'CLOSED'), '23514');
  });

  it('once the position is CLOSED, the pair may close', async () => {
    const pairId = await seedPair();
    const opened = await createPosition(db, positionInput(pairId));
    await transitionPair(db, pairId, 'ACTIVE');
    await transitionPair(db, pairId, 'SETTLING');
    await closePosition(db, opened.id);
    const closedPair = await transitionPair(db, pairId, 'CLOSED');
    expect(closedPair.state).toBe('CLOSED');
  });
});

describe('no on-chain artifact / no postings (AC #1)', () => {
  it('opening a position writes only the positions table — no postings, no journal entries', async () => {
    const pairId = await seedPair();
    await createPosition(db, positionInput(pairId));
    const { rows: postings } = await pool.query('SELECT count(*)::int AS n FROM postings');
    const { rows: entries } = await pool.query('SELECT count(*)::int AS n FROM journal_entries');
    expect(postings[0].n).toBe(0);
    expect(entries[0].n).toBe(0);
  });
});
