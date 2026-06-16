import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateDown, migrateUp } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { migration0003 } from './migrations/0003-coupled-pairs.js';
import {
  InvalidCoupledPairError,
  createCoupledPair,
  getCoupledPair,
  type CreateCoupledPairInput,
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

// A complete, valid pair (P0 validation uses L=1 for both EUR/USD and BTC).
const validInput = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.10500000',
  leverage: '1',
  collateralPool: 1_000_000n,
  floor: '0.5',
  longLegValue: 500_000n,
  shortLegValue: 500_000n,
} as const;

describe('AC-1 — frozen fields & frozen types', () => {
  it('persists a pair carrying every frozen field and round-trips the values', async () => {
    const created = await createCoupledPair(db, validInput);
    const read = await getCoupledPair(db, created.id);
    expect(read).not.toBeNull();
    expect(read!.referenceAsset).toBe('EUR/USD');
    expect(read!.anchorPrice).toBe('1.10500000');
    expect(read!.leverage).toBe('1');
    expect(read!.collateralPool).toBe(1_000_000n);
    expect(read!.floor).toBe('0.5');
    expect(read!.longLegValue).toBe(500_000n);
    expect(read!.shortLegValue).toBe(500_000n);
    expect(read!.state).toBe('PENDING');
    expect(read!.createdAt).toBeInstanceOf(Date);
    expect(read!.updatedAt).toBeInstanceOf(Date);
  });

  it('freezes the column types: anchor_price decimal(18,8), the smallest-unit NUMERICs, text, enum, timestamptz', async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, udt_name, numeric_precision, numeric_scale, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'coupled_pairs'
       ORDER BY ordinal_position`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    // anchor_price is decimal(18,8).
    expect(byName.get('anchor_price')!.data_type).toBe('numeric');
    expect(byName.get('anchor_price')!.numeric_precision).toBe(18);
    expect(byName.get('anchor_price')!.numeric_scale).toBe(8);

    // leverage / collateral_pool / floor / both legs are unconstrained NUMERIC (not bigint).
    for (const col of [
      'leverage',
      'collateral_pool',
      'floor',
      'long_leg_value',
      'short_leg_value',
    ]) {
      expect(byName.get(col)!.data_type).toBe('numeric');
      expect(byName.get(col)!.numeric_precision).toBeNull();
    }

    expect(byName.get('reference_asset')!.data_type).toBe('text');
    // state is the coupled_pair_state enum (USER-DEFINED type).
    expect(byName.get('state')!.udt_name).toBe('coupled_pair_state');
    // timestamps are timestamptz.
    expect(byName.get('created_at')!.data_type).toBe('timestamp with time zone');
    expect(byName.get('updated_at')!.data_type).toBe('timestamp with time zone');

    // Both legs are NOT NULL — the structural single-leg guarantee.
    expect(byName.get('long_leg_value')!.is_nullable).toBe('NO');
    expect(byName.get('short_leg_value')!.is_nullable).toBe('NO');
  });

  it('exposes exactly the six lifecycle states and defaults to PENDING', async () => {
    const { rows } = await pool.query<{ label: string }>(
      `SELECT e.enumlabel AS label
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'coupled_pair_state'
       ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual([
      'PENDING',
      'ACTIVE',
      'REBALANCING',
      'PARTIAL',
      'SETTLING',
      'CLOSED',
    ]);

    // Default applies when state is omitted.
    const created = await createCoupledPair(db, validInput);
    expect(created.state).toBe('PENDING');
  });

  it('rejects a non-glossary state value at the DB (enum is structural)', async () => {
    await expect(
      pool.query(
        `INSERT INTO coupled_pairs
           (reference_asset, anchor_price, leverage, collateral_pool, floor, long_leg_value, short_leg_value, state)
         VALUES ('BTC', 1, 1, 0, 0, 0, 0, 'OPEN')`,
      ),
    ).rejects.toThrow();
  });

  it('round-trips 18-decimal token magnitudes (NUMERIC, beyond int64) for K and the legs', async () => {
    const big = 123_456_789_012_345_678_901_234_567_890n;
    const created = await createCoupledPair(db, {
      ...validInput,
      referenceAsset: 'BTC',
      collateralPool: big,
      longLegValue: big - 1n,
      shortLegValue: 1n,
    });
    const read = await getCoupledPair(db, created.id);
    expect(read!.collateralPool).toBe(big);
    expect(read!.longLegValue).toBe(big - 1n);
    expect(read!.shortLegValue).toBe(1n);
  });
});

describe('AC-2 — single-leg unrepresentable; leverage per-pair', () => {
  it('has no separate legs table — a leg cannot exist on its own', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('legs', 'pair_legs', 'coupled_pair_legs')`,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot persist a pair missing the long leg (NOT NULL)', async () => {
    await expect(
      pool.query(
        `INSERT INTO coupled_pairs
           (reference_asset, anchor_price, leverage, collateral_pool, floor, short_leg_value)
         VALUES ('EUR/USD', 1, 1, 0, 0, 0)`,
      ),
    ).rejects.toThrow(/long_leg_value/);
  });

  it('cannot persist a pair missing the short leg (NOT NULL)', async () => {
    await expect(
      pool.query(
        `INSERT INTO coupled_pairs
           (reference_asset, anchor_price, leverage, collateral_pool, floor, long_leg_value)
         VALUES ('EUR/USD', 1, 1, 0, 0, 0)`,
      ),
    ).rejects.toThrow(/short_leg_value/);
  });

  it('the repository exposes no way to create a lone leg — both legs are required inputs', async () => {
    // @ts-expect-error longLegValue is required: a single-leg create does not type-check.
    const loneLeg: CreateCoupledPairInput = { ...validInput, longLegValue: undefined };
    await expect(createCoupledPair(db, loneLeg)).rejects.toBeInstanceOf(InvalidCoupledPairError);
  });

  it('reads leverage PER-PAIR from the row (different L values are not collapsed to a constant)', async () => {
    const eurusd = await createCoupledPair(db, {
      ...validInput,
      referenceAsset: 'EUR/USD',
      leverage: '1',
    });
    const levered = await createCoupledPair(db, {
      ...validInput,
      referenceAsset: 'BTC',
      leverage: '3.5',
    });
    expect((await getCoupledPair(db, eurusd.id))!.leverage).toBe('1');
    expect((await getCoupledPair(db, levered.id))!.leverage).toBe('3.5');
  });

  it('enforces the frozen field guards (positive P₀/L, non-negative f, integer smallest-units)', async () => {
    await expect(createCoupledPair(db, { ...validInput, anchorPrice: '0' })).rejects.toBeInstanceOf(
      InvalidCoupledPairError,
    );
    await expect(createCoupledPair(db, { ...validInput, leverage: '0' })).rejects.toBeInstanceOf(
      InvalidCoupledPairError,
    );
    await expect(createCoupledPair(db, { ...validInput, floor: '-0.1' })).rejects.toBeInstanceOf(
      InvalidCoupledPairError,
    );
    await expect(
      // @ts-expect-error a binary float is never a valid smallest-unit amount (NFR-2)
      createCoupledPair(db, { ...validInput, collateralPool: 1000 }),
    ).rejects.toBeInstanceOf(InvalidCoupledPairError);
    await expect(
      createCoupledPair(db, { ...validInput, shortLegValue: -1n }),
    ).rejects.toBeInstanceOf(InvalidCoupledPairError);
    await expect(
      createCoupledPair(db, { ...validInput, referenceAsset: '  ' }),
    ).rejects.toBeInstanceOf(InvalidCoupledPairError);
  });

  it('rejects an over-precision anchor_price instead of silently rounding it (frozen decimal(18,8))', async () => {
    // The DB would silently round 1.123456789 → 1.12345679; the repo surfaces the precision loss.
    await expect(
      createCoupledPair(db, { ...validInput, anchorPrice: '1.123456789' }),
    ).rejects.toBeInstanceOf(InvalidCoupledPairError);
    // Exactly 8 fractional digits is accepted.
    const ok = await createCoupledPair(db, { ...validInput, anchorPrice: '1.12345678' });
    expect(ok.anchorPrice).toBe('1.12345678');
  });

  it('DB CHECK is the backstop: a fractional smallest-unit is rejected even via raw SQL (repo bypassed)', async () => {
    await expect(
      pool.query(
        `INSERT INTO coupled_pairs
           (reference_asset, anchor_price, leverage, collateral_pool, floor, long_leg_value, short_leg_value)
         VALUES ('EUR/USD', 1, 1, 1000.5, 0, 0, 0)`,
      ),
    ).rejects.toThrow(/collateral_pool_nonneg_int/);
  });
});

describe('journal_entries.coupled_pair_id FK (migration 0003)', () => {
  it('rejects a journal entry referencing a non-existent pair', async () => {
    await expect(
      pool.query(
        `INSERT INTO journal_entries (description, coupled_pair_id)
         VALUES ('orphan', '00000000-0000-4000-8000-0000000000aa')`,
      ),
    ).rejects.toThrow();
  });

  it('accepts a journal entry referencing a real pair', async () => {
    const pair = await createCoupledPair(db, validInput);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO journal_entries (description, coupled_pair_id) VALUES ('linked', $1) RETURNING id`,
      [pair.id],
    );
    expect(rows[0]!.id).toBeTruthy();
  });
});

describe('migration 0003 reversibility (NFR-5)', () => {
  it('forward → down → forward leaves coupled_pairs present again', async () => {
    // Roll back to before 0003 — derive the step count from MIGRATIONS so appending later
    // migrations (as stories 2.2/2.4 did with 0004/0005) never needs this number bumped.
    const stepsToBefore0003 = MIGRATIONS.filter((m) => m.version >= migration0003.version).length;
    await migrateDown(pool, stepsToBefore0003);
    const goneCheck = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.coupled_pairs') IS NOT NULL AS present`,
    );
    expect(goneCheck.rows[0]!.present).toBe(false);
    // The FK and enum type are gone too.
    const enumGone = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_type WHERE typname = 'coupled_pair_state'`,
    );
    expect(enumGone.rows[0]!.n).toBe(0);

    const applied = await migrateUp(pool);
    expect(applied).toContain(migration0003.version);
    const backCheck = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.coupled_pairs') IS NOT NULL AS present`,
    );
    expect(backCheck.rows[0]!.present).toBe(true);
  });
});
