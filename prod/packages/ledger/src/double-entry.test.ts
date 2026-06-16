import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from './db.js';
import { hardReset, migrateUp } from './migrate.js';

// Test-FIRST invariant coverage (NFR-6, FR-3): these drive the database with RAW SQL only —
// no application recording helper exists yet (that is Story 1.6). The point of AC-2 is that
// the DB guarantee holds even when application code is bypassed.
let pool: pg.Pool;
let debitAccount: string;
let creditAccount: string;
let btcDebitAccount: string;
let btcCreditAccount: string;

async function countJournalEntries(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM journal_entries',
  );
  return rows[0]!.n;
}

/** Inserts a journal entry + postings within one transaction; resolves true if COMMIT succeeds. */
async function commitEntry(
  description: string,
  postings: ReadonlyArray<{ account: string; direction: 'DEBIT' | 'CREDIT'; amount: string }>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const je = await client.query<{ id: string }>(
      'INSERT INTO journal_entries (description) VALUES ($1) RETURNING id',
      [description],
    );
    const jeId = je.rows[0]!.id;
    for (const p of postings) {
      await client.query(
        'INSERT INTO postings (journal_entry_id, account_id, direction, amount) VALUES ($1, $2, $3, $4)',
        [jeId, p.account, p.direction, p.amount],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // already aborted
    }
    return false;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = createPool();
  await hardReset(pool);
  await migrateUp(pool);
  // Two raw accounts to post against (raw SQL — no application helper).
  const vcc = await pool.query<{ id: string }>("SELECT id FROM entities WHERE code = 'VCC'");
  const entityId = vcc.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, 'BACKING_FLOAT', 'EUR', 2) RETURNING id`,
    [entityId],
  );
  const b = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, 'FEE_INCOME', 'EUR', 2) RETURNING id`,
    [entityId],
  );
  // BTC accounts (scale 8) for cross-asset / multi-asset tests.
  const c = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, 'CLIENT_COLLATERAL', 'BTC', 8) RETURNING id`,
    [entityId],
  );
  const d = await pool.query<{ id: string }>(
    `INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1, 'NOTE_LIABILITY', 'BTC', 8) RETURNING id`,
    [entityId],
  );
  debitAccount = a.rows[0]!.id;
  creditAccount = b.rows[0]!.id;
  btcDebitAccount = c.rows[0]!.id;
  btcCreditAccount = d.rows[0]!.id;
});

afterAll(async () => {
  await pool.end();
});

describe('double-entry invariant (FR-3, NFR-1, NFR-6)', () => {
  it('commits a balanced entry (Σ debits = Σ credits)', async () => {
    const ok = await commitEntry('balanced', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' },
      { account: creditAccount, direction: 'CREDIT', amount: '100' },
    ]);
    expect(ok).toBe(true);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM journal_entries WHERE description = 'balanced'",
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('fails an unbalanced entry at COMMIT and leaves no partial state', async () => {
    const before = await countJournalEntries();
    const ok = await commitEntry('unbalanced', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' },
      { account: creditAccount, direction: 'CREDIT', amount: '50' },
    ]);
    expect(ok).toBe(false);
    // The journal_entries row must have rolled back too — no partial state.
    expect(await countJournalEntries()).toBe(before);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM journal_entries WHERE description = 'unbalanced'",
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects a single-leg (one-posting) entry — cannot be bypassed by direct writes', async () => {
    const ok = await commitEntry('single-leg', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' },
    ]);
    expect(ok).toBe(false);
  });

  it('is DEFERRED: an intermediate-unbalanced but finally-balanced set commits', async () => {
    // Inserting the debit first leaves the entry transiently unbalanced; a non-deferred
    // (immediate) check would reject it. The deferred constraint only checks at COMMIT.
    const ok = await commitEntry('deferred', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' },
      { account: creditAccount, direction: 'CREDIT', amount: '60' },
      { account: creditAccount, direction: 'CREDIT', amount: '40' },
    ]);
    expect(ok).toBe(true);
  });

  it('rejects a non-positive posting amount (CHECK amount > 0)', async () => {
    const ok = await commitEntry('zero-amount', [
      { account: debitAccount, direction: 'DEBIT', amount: '0' },
      { account: creditAccount, direction: 'CREDIT', amount: '0' },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects an empty description (CHECK non-empty)', async () => {
    const ok = await commitEntry('   ', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' },
      { account: creditAccount, direction: 'CREDIT', amount: '100' },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects a non-integer amount (CHECK amount = trunc(amount); NFR-2)', async () => {
    const ok = await commitEntry('fractional', [
      { account: debitAccount, direction: 'DEBIT', amount: '0.5' },
      { account: creditAccount, direction: 'CREDIT', amount: '0.5' },
    ]);
    expect(ok).toBe(false);
  });
});

describe('per-asset balance (review hardening — cross-asset/scale)', () => {
  it('rejects a cross-asset entry that only nets by raw integer (EUR vs BTC)', async () => {
    const ok = await commitEntry('cross-asset', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' }, // 1.00 EUR
      { account: btcCreditAccount, direction: 'CREDIT', amount: '100' }, // 0.000001 BTC
    ]);
    expect(ok).toBe(false);
  });

  it('commits a multi-asset entry that balances within EACH asset', async () => {
    const ok = await commitEntry('multi-asset-balanced', [
      { account: debitAccount, direction: 'DEBIT', amount: '100' },
      { account: creditAccount, direction: 'CREDIT', amount: '100' },
      { account: btcDebitAccount, direction: 'DEBIT', amount: '50' },
      { account: btcCreditAccount, direction: 'CREDIT', amount: '50' },
    ]);
    expect(ok).toBe(true);
  });

  it('rejects an UPDATE that moves a posting and unbalances the source entry', async () => {
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const a = (
        await client.query<{ id: string }>(
          "INSERT INTO journal_entries (description) VALUES ('move-src') RETURNING id",
        )
      ).rows[0]!.id;
      await client.query(
        "INSERT INTO postings (journal_entry_id, account_id, direction, amount) VALUES ($1, $2, 'DEBIT', 100)",
        [a, debitAccount],
      );
      await client.query(
        "INSERT INTO postings (journal_entry_id, account_id, direction, amount) VALUES ($1, $2, 'CREDIT', 100)",
        [a, creditAccount],
      );
      const b = (
        await client.query<{ id: string }>(
          "INSERT INTO journal_entries (description) VALUES ('move-dst') RETURNING id",
        )
      ).rows[0]!.id;
      // Move A's debit to B, then balance B — leaves A unbalanced (only a credit remains).
      await client.query(
        "UPDATE postings SET journal_entry_id = $1 WHERE journal_entry_id = $2 AND direction = 'DEBIT'",
        [b, a],
      );
      await client.query(
        "INSERT INTO postings (journal_entry_id, account_id, direction, amount) VALUES ($1, $2, 'CREDIT', 100)",
        [b, creditAccount],
      );
      await client.query('COMMIT');
      committed = true;
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already aborted
      }
    } finally {
      client.release();
    }
    // The source entry A is left unbalanced; the deferred check must re-validate OLD too.
    expect(committed).toBe(false);
  });
});
