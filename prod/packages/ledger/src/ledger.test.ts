import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateDown, migrateUp } from './migrate.js';
import {
  AccountPlacementError,
  createAccount,
  isPlacementAllowed,
} from './repositories/accounts.js';

// Integration tests — require a running PostgreSQL (DATABASE_URL or local docker on :5544).
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

describe('entities seed (AC-2)', () => {
  it('seeds exactly the four fixed entity codes, each with a jurisdiction', async () => {
    const { rows } = await pool.query<{ code: string; jurisdiction: string }>(
      'SELECT code, jurisdiction FROM entities',
    );
    // NB: ORDER BY on an enum column sorts by declaration order, so sort by text here.
    expect(rows.map((r) => r.code).sort()).toEqual(['COIN_ISSUER', 'HOLDING', 'TRADING_CO', 'VCC']);
    for (const r of rows) {
      expect(r.jurisdiction.length).toBeGreaterThan(0);
    }
  });

  it('rejects an entity code outside the fixed enum', async () => {
    await expect(
      pool.query("INSERT INTO entities (code, jurisdiction) VALUES ('BOGUS', 'X')"),
    ).rejects.toThrow();
  });
});

describe('account modeling (AC-2)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE accounts CASCADE');
  });

  it('stores entity, type, asset and decimal scale', async () => {
    const account = await createAccount(db, {
      entityCode: 'VCC',
      type: 'BACKING_FLOAT',
      asset: 'EUR',
      decimalScale: 2,
    });
    expect(account.type).toBe('BACKING_FLOAT');
    expect(account.asset).toBe('EUR');
    expect(account.decimalScale).toBe(2);
    expect(account.entityId).toBeTruthy();
  });

  it('rejects an account type outside the fixed enum (raw insert)', async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
    await expect(
      pool.query(
        `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, 'BOGUS', 'EUR', 2)`,
        [rows[0]!.id],
      ),
    ).rejects.toThrow();
  });

  it('enforces UNIQUE(entity_id, type, asset)', async () => {
    await createAccount(db, {
      entityCode: 'VCC',
      type: 'FEE_INCOME',
      asset: 'EUR',
      decimalScale: 2,
    });
    await expect(
      createAccount(db, { entityCode: 'VCC', type: 'FEE_INCOME', asset: 'EUR', decimalScale: 2 }),
    ).rejects.toThrow();
  });

  it('enforces decimal_scale >= 0 at the database', async () => {
    await expect(
      createAccount(db, {
        entityCode: 'VCC',
        type: 'BACKING_FLOAT',
        asset: 'EUR',
        decimalScale: -1,
      }),
    ).rejects.toThrow();
  });
});

describe('routing rule (AC-2)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE accounts CASCADE');
  });

  it('allows a placement permitted by the routing policy', async () => {
    const account = await createAccount(db, {
      entityCode: 'TRADING_CO',
      type: 'DEPLOYED_CAPITAL',
      asset: 'EUR',
      decimalScale: 2,
    });
    expect(account.type).toBe('DEPLOYED_CAPITAL');
  });

  it('refuses DEPLOYED_CAPITAL under VCC (cash/NAV only) with AccountPlacementError', async () => {
    await expect(
      createAccount(db, {
        entityCode: 'VCC',
        type: 'DEPLOYED_CAPITAL',
        asset: 'EUR',
        decimalScale: 2,
      }),
    ).rejects.toBeInstanceOf(AccountPlacementError);
  });

  it('policy predicate matches the documented rule', () => {
    expect(isPlacementAllowed('VCC', 'DEPLOYED_CAPITAL')).toBe(false);
    expect(isPlacementAllowed('VCC', 'NOTE_LIABILITY')).toBe(true);
    expect(isPlacementAllowed('COIN_ISSUER', 'DEPLOYED_CAPITAL')).toBe(true);
    expect(isPlacementAllowed('HOLDING', 'FEE_INCOME')).toBe(true);
  });
});

describe('reversibility (AC-1)', () => {
  it('forward → down → forward all succeed (NFR-5)', async () => {
    // Roll back ALL migrations (entities live in the first one).
    const down = await migrateDown(pool, 99);
    expect(down).toContain('0001_entities_accounts');
    // After rollback the entities table is gone.
    await expect(pool.query('SELECT 1 FROM entities')).rejects.toThrow();

    const up = await migrateUp(pool);
    expect(up).toContain('0001_entities_accounts');
    const { rows } = await pool.query('SELECT code FROM entities');
    expect(rows).toHaveLength(4);
  });

  it('seeds entities with deterministic ids stable across down→up (review hardening)', async () => {
    const before = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
    await migrateDown(pool, 99);
    await migrateUp(pool);
    const after = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
    expect(after.rows[0]!.id).toBe(before.rows[0]!.id);
    expect(after.rows[0]!.id).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('migrateDown rejects invalid steps (review hardening)', async () => {
    await expect(migrateDown(pool, -1)).rejects.toThrow();
    await expect(migrateDown(pool, Number('abc'))).rejects.toThrow();
  });
});

describe('input validation (review hardening)', () => {
  it('rejects a non-integer decimal scale with a domain error, before hitting the DB', async () => {
    await expect(
      createAccount(db, {
        entityCode: 'VCC',
        type: 'BACKING_FLOAT',
        asset: 'EUR',
        decimalScale: 2.5,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
