import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateUp } from './migrate.js';
import {
  InvalidJournalEntryError,
  UnbalancedEntryError,
  getJournalEntry,
  recordJournalEntry,
} from './repositories/journal-entries.js';

let pool: pg.Pool;
let db: RoseDb;
let eurDebit: string;
let eurCredit: string;
let btcCredit: string;

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  const vcc = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
  const entityId = vcc.rows[0]!.id;
  const mk = async (type: string, asset: string, scale: number) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, $2, $3, $4) RETURNING id`,
        [entityId, type, asset, scale],
      )
    ).rows[0]!.id;
  eurDebit = await mk('BACKING_FLOAT', 'EUR', 2);
  eurCredit = await mk('FEE_INCOME', 'EUR', 2);
  btcCredit = await mk('CLIENT_COLLATERAL', 'BTC', 8);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE journal_entries CASCADE');
});

describe('recordJournalEntry (AC-1)', () => {
  it('records a balanced ≥2-posting entry and persists it', async () => {
    const result = await recordJournalEntry(db, {
      description: 'fee accrual',
      postings: [
        { accountId: eurDebit, direction: 'DEBIT', amount: 100n },
        { accountId: eurCredit, direction: 'CREDIT', amount: 100n },
      ],
    });
    expect(result.entry.description).toBe('fee accrual');
    expect(result.postings).toHaveLength(2);
    expect(result.postings.map((p) => p.amount).sort()).toEqual([100n, 100n]);
  });

  it('stores the optional coupled-pair link when provided', async () => {
    // The journal_entries.coupled_pair_id FK (migration 0003) requires a real pair to exist.
    const pair = await pool.query<{ id: string }>(
      `INSERT INTO coupled_pairs
         (reference_asset, anchor_price, leverage, collateral_pool, floor, long_leg_value, short_leg_value)
       VALUES ('EUR/USD', 1, 1, 0, 0, 0, 0) RETURNING id`,
    );
    const pairId = pair.rows[0]!.id;
    const result = await recordJournalEntry(db, {
      description: 'with pair',
      coupledPairId: pairId,
      postings: [
        { accountId: eurDebit, direction: 'DEBIT', amount: 10n },
        { accountId: eurCredit, direction: 'CREDIT', amount: 10n },
      ],
    });
    expect(result.entry.coupledPairId).toBe(pairId);
  });

  it('round-trips large 18-decimal token magnitudes (bigint beyond MAX_SAFE_INTEGER)', async () => {
    const big = 123456789012345678901234567890n;
    const tk6Debit = (
      await pool.query<{ id: string }>(
        `INSERT INTO accounts (entity_id, type, asset, decimal_scale)
         SELECT id, 'BACKING_FLOAT', 'TKN', 18 FROM entities WHERE code = 'COIN_ISSUER' RETURNING id`,
      )
    ).rows[0]!.id;
    const tk6Credit = (
      await pool.query<{ id: string }>(
        `INSERT INTO accounts (entity_id, type, asset, decimal_scale)
         SELECT id, 'DEPLOYED_CAPITAL', 'TKN', 18 FROM entities WHERE code = 'COIN_ISSUER' RETURNING id`,
      )
    ).rows[0]!.id;
    const { entry } = await recordJournalEntry(db, {
      description: 'big token',
      postings: [
        { accountId: tk6Debit, direction: 'DEBIT', amount: big },
        { accountId: tk6Credit, direction: 'CREDIT', amount: big },
      ],
    });
    const read = await getJournalEntry(db, entry.id);
    expect(read!.postings.map((p) => p.amount).sort()).toEqual([big, big]);
  });

  it('rejects an unbalanced entry and persists nothing (UnbalancedEntryError)', async () => {
    await expect(
      recordJournalEntry(db, {
        description: 'unbalanced',
        postings: [
          { accountId: eurDebit, direction: 'DEBIT', amount: 100n },
          { accountId: eurCredit, direction: 'CREDIT', amount: 50n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries',
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects a cross-asset entry that only nets by raw integer', async () => {
    await expect(
      recordJournalEntry(db, {
        description: 'cross-asset',
        postings: [
          { accountId: eurDebit, direction: 'DEBIT', amount: 100n },
          { accountId: btcCredit, direction: 'CREDIT', amount: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it('rejects fewer than two postings', async () => {
    await expect(
      recordJournalEntry(db, {
        description: 'single',
        postings: [{ accountId: eurDebit, direction: 'DEBIT', amount: 100n }],
      }),
    ).rejects.toBeInstanceOf(InvalidJournalEntryError);
  });

  it('rejects an empty description', async () => {
    await expect(
      recordJournalEntry(db, {
        description: '   ',
        postings: [
          { accountId: eurDebit, direction: 'DEBIT', amount: 100n },
          { accountId: eurCredit, direction: 'CREDIT', amount: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidJournalEntryError);
  });

  it('rejects a binary-float amount (NFR-2) with a typed error — no float can be stored', async () => {
    await expect(
      recordJournalEntry(db, {
        description: 'float',
        postings: [
          // @ts-expect-error intentional misuse: number must be rejected at runtime
          { accountId: eurDebit, direction: 'DEBIT', amount: 100 },
          // @ts-expect-error intentional misuse
          { accountId: eurCredit, direction: 'CREDIT', amount: 100 },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidJournalEntryError);
  });

  it('rejects an invalid posting direction with a typed error', async () => {
    await expect(
      recordJournalEntry(db, {
        description: 'bad-direction',
        postings: [
          // @ts-expect-error intentional misuse: only DEBIT/CREDIT allowed
          { accountId: eurDebit, direction: 'debit', amount: 100n },
          { accountId: eurCredit, direction: 'CREDIT', amount: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidJournalEntryError);
  });

  it('rejects a non-UUID coupledPairId with a typed error', async () => {
    await expect(
      recordJournalEntry(db, {
        description: 'bad-pair',
        coupledPairId: 'not-a-uuid',
        postings: [
          { accountId: eurDebit, direction: 'DEBIT', amount: 100n },
          { accountId: eurCredit, direction: 'CREDIT', amount: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidJournalEntryError);
  });
});

describe('read robustness (review hardening)', () => {
  it('reads back a scale-bearing-but-integer NUMERIC amount (e.g. 100.000) as a bigint', async () => {
    // A non-app writer could store an integer-valued numeric with a non-zero scale; the DB
    // CHECK allows it (amount = trunc(amount)). The read path must still yield a bigint.
    const je = (
      await pool.query<{ id: string }>(
        "INSERT INTO journal_entries (description) VALUES ('scaled-read') RETURNING id",
      )
    ).rows[0]!.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO postings (journal_entry_id, account_id, direction, amount) VALUES ($1, $2, 'DEBIT', 100.000)",
        [je, eurDebit],
      );
      await client.query(
        "INSERT INTO postings (journal_entry_id, account_id, direction, amount) VALUES ($1, $2, 'CREDIT', 100.000)",
        [je, eurCredit],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const read = await getJournalEntry(db, je);
    expect(read!.postings.map((p) => p.amount).sort()).toEqual([100n, 100n]);
  });
});

describe('getJournalEntry (AC-2 — attributable, append-oriented)', () => {
  it('reads back the entry with its postings (attributable audit view)', async () => {
    const { entry } = await recordJournalEntry(db, {
      description: 'auditable',
      postings: [
        { accountId: eurDebit, direction: 'DEBIT', amount: 250n },
        { accountId: eurCredit, direction: 'CREDIT', amount: 250n },
      ],
    });
    const read = await getJournalEntry(db, entry.id);
    expect(read).not.toBeNull();
    expect(read!.entry.id).toBe(entry.id);
    expect(read!.entry.description).toBe('auditable');
    expect(read!.postings).toHaveLength(2);
    expect(read!.postings.every((p) => typeof p.amount === 'bigint')).toBe(true);
  });

  it('returns null for an unknown id', async () => {
    const read = await getJournalEntry(db, '00000000-0000-4000-8000-0000000000ff');
    expect(read).toBeNull();
  });
});
