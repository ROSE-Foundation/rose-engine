// Story 2.3 — record a coupled-pair issuance as ONE balanced journal entry (FR-13), test-first
// on the invariant. Proves: a successful issuance produces exactly one balanced entry linked to
// the pair capturing both legs, the pair is created and ACTIVE, and the entry is reflected in
// account balances (AC-1); and that a single-leg / unbalanced / lone-posting issuance is rejected
// and persists NOTHING — the whole transaction rolls back, so no orphan pair remains (AC-2).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateUp } from './migrate.js';
import { InvalidJournalEntryError, UnbalancedEntryError } from './repositories/journal-entries.js';
import { SingleLegIssuanceError, issueCoupledPair } from './repositories/issuance.js';

let pool: pg.Pool;
let db: RoseDb;
let longAcct: string; // EUR(2) — long-leg deployed capital
let shortAcct: string; // EUR(2) — short-leg deployed capital
let fundingAcct: string; // EUR(2) — backing float (funding source)
let btcAcct: string; // BTC(8) — to force a cross-asset imbalance

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
  longAcct = await mk('DEPLOYED_CAPITAL', 'EUR', 2);
  shortAcct = await mk('CLIENT_COLLATERAL', 'EUR', 2);
  fundingAcct = await mk('BACKING_FLOAT', 'EUR', 2);
  btcAcct = await mk('FEE_INCOME', 'BTC', 8);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // CASCADE clears postings/journal_entries; truncate pairs too (FK from journal_entries).
  await pool.query('TRUNCATE coupled_pairs, journal_entries CASCADE');
});

const basePair = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.10500000',
  leverage: '1',
  collateralPool: 1_000_000n,
  floor: '0.5',
  longLegValue: 500_000n,
  shortLegValue: 500_000n,
} as const;

async function countPairs(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM coupled_pairs');
  return rows[0]!.n;
}
async function countEntries(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM journal_entries',
  );
  return rows[0]!.n;
}

describe('AC-1 — issuance posts exactly one balanced entry linked to the pair, capturing both legs', () => {
  it('records a single balanced journal entry linked to the pair with both legs, and activates it', async () => {
    const { pair, entry } = await issueCoupledPair(db, {
      pair: basePair,
      description: 'issue EUR/USD coupled pair',
      // Long leg deployed (debit), funded by the short-leg credit. One balanced entry, both legs.
      longLeg: { postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 500_000n }] },
      shortLeg: { postings: [{ accountId: fundingAcct, direction: 'CREDIT', amount: 500_000n }] },
    });

    // The pair was created (both legs) and issuance activated it.
    expect(pair.state).toBe('ACTIVE');
    expect(pair.longLegValue).toBe(500_000n);
    expect(pair.shortLegValue).toBe(500_000n);

    // Exactly ONE journal entry, linked to the pair, capturing both legs.
    expect(await countPairs()).toBe(1);
    expect(await countEntries()).toBe(1);
    expect(entry.entry.coupledPairId).toBe(pair.id);
    expect(entry.postings).toHaveLength(2);
  });
});

// Helper: a properly balanced issuance (two leg debits funded by one credit).
function balancedIssuanceInput(description = 'issue EUR/USD coupled pair') {
  return {
    pair: basePair,
    description,
    longLeg: {
      postings: [{ accountId: longAcct, direction: 'DEBIT' as const, amount: 500_000n }],
    },
    shortLeg: {
      postings: [
        { accountId: shortAcct, direction: 'DEBIT' as const, amount: 300_000n },
        { accountId: fundingAcct, direction: 'CREDIT' as const, amount: 800_000n },
      ],
    },
  };
}

describe('AC-1 — balanced issuance reflected in account balances', () => {
  it('produces one balanced entry (Σdebits=Σcredits) capturing both legs, reflected in balances', async () => {
    const { pair, entry } = await issueCoupledPair(db, balancedIssuanceInput());

    expect(pair.state).toBe('ACTIVE');
    expect(await countPairs()).toBe(1);
    expect(await countEntries()).toBe(1);
    expect(entry.entry.coupledPairId).toBe(pair.id);

    // Both legs are present in the single entry's postings.
    expect(entry.postings).toHaveLength(3);
    const byAccount = new Map(entry.postings.map((p) => [p.accountId, p]));
    expect(byAccount.get(longAcct)!.direction).toBe('DEBIT');
    expect(byAccount.get(shortAcct)!.direction).toBe('DEBIT');
    expect(byAccount.get(fundingAcct)!.direction).toBe('CREDIT');

    // The entry balances per asset: Σ debits = Σ credits = 800_000.
    const debits = entry.postings
      .filter((p) => p.direction === 'DEBIT')
      .reduce((s, p) => s + p.amount, 0n);
    const credits = entry.postings
      .filter((p) => p.direction === 'CREDIT')
      .reduce((s, p) => s + p.amount, 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(800_000n);

    // Reflected in per-account balances (DEBIT − CREDIT), recomputed from the DB postings.
    const { rows } = await pool.query<{ account_id: string; bal: string }>(
      `SELECT account_id,
              sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text AS bal
         FROM postings GROUP BY account_id`,
    );
    const bal = new Map(rows.map((r) => [r.account_id, BigInt(r.bal)]));
    expect(bal.get(longAcct)).toBe(500_000n);
    expect(bal.get(shortAcct)).toBe(300_000n);
    expect(bal.get(fundingAcct)).toBe(-800_000n);
  });
});

describe('AC-2 — a single-leg issuance is impossible (and persists nothing)', () => {
  it('rejects an issuance whose long leg has no postings (SingleLegIssuanceError)', async () => {
    await expect(
      issueCoupledPair(db, {
        pair: basePair,
        description: 'single-leg (no long postings)',
        longLeg: { postings: [] },
        shortLeg: {
          postings: [{ accountId: shortAcct, direction: 'DEBIT', amount: 100_000n }],
        },
      }),
    ).rejects.toBeInstanceOf(SingleLegIssuanceError);
    expect(await countPairs()).toBe(0);
    expect(await countEntries()).toBe(0);
  });

  it('rejects an issuance whose short leg has no postings (SingleLegIssuanceError)', async () => {
    await expect(
      issueCoupledPair(db, {
        pair: basePair,
        description: 'single-leg (no short postings)',
        longLeg: { postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 100_000n }] },
        shortLeg: { postings: [] },
      }),
    ).rejects.toMatchObject({
      name: 'SingleLegIssuanceError',
      leg: 'short',
      reason: 'no-postings',
    });
    expect(await countPairs()).toBe(0);
    expect(await countEntries()).toBe(0);
  });

  it('rejects an issuance with a zero-value leg and rolls back the pair (transactional)', async () => {
    await expect(
      issueCoupledPair(db, {
        pair: { ...basePair, shortLegValue: 0n }, // economically a single leg
        description: 'zero short leg',
        longLeg: { postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 500_000n }] },
        shortLeg: {
          postings: [{ accountId: fundingAcct, direction: 'CREDIT', amount: 500_000n }],
        },
      }),
    ).rejects.toMatchObject({
      name: 'SingleLegIssuanceError',
      leg: 'short',
      reason: 'non-positive-value',
    });
    // The pair insert is rolled back too — proves the guard runs inside the one transaction.
    expect(await countPairs()).toBe(0);
    expect(await countEntries()).toBe(0);
  });
});

describe('AC-2 — an unbalanced / lone-leg entry is rejected and the whole issuance rolls back', () => {
  it('rejects an unbalanced issuance and persists nothing (no orphan pair)', async () => {
    await expect(
      issueCoupledPair(db, {
        pair: basePair,
        description: 'unbalanced issuance',
        longLeg: { postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 500_000n }] },
        shortLeg: {
          postings: [{ accountId: fundingAcct, direction: 'CREDIT', amount: 400_000n }], // 500≠400
        },
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    expect(await countPairs()).toBe(0);
    expect(await countEntries()).toBe(0);
  });

  it('rejects a cross-asset issuance that only nets by raw integer', async () => {
    await expect(
      issueCoupledPair(db, {
        pair: basePair,
        description: 'cross-asset issuance',
        longLeg: { postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 500_000n }] },
        shortLeg: { postings: [{ accountId: btcAcct, direction: 'CREDIT', amount: 500_000n }] },
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    expect(await countPairs()).toBe(0);
  });

  it('rejects an issuance that reduces to a single posting (the ≥2-posting rule)', async () => {
    // Both legs post to the SAME account/direction → would be one net posting; still must be ≥2
    // postings AND balance. Here it is a lone debit with no credit → rejected, nothing persists.
    await expect(
      issueCoupledPair(db, {
        pair: basePair,
        description: 'lone-leg issuance',
        longLeg: { postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 250_000n }] },
        shortLeg: { postings: [{ accountId: shortAcct, direction: 'DEBIT', amount: 250_000n }] },
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    expect(await countPairs()).toBe(0);
    expect(await countEntries()).toBe(0);
  });

  it('rejects an issuance with a binary-float posting amount (NFR-2) and persists nothing', async () => {
    await expect(
      issueCoupledPair(db, {
        pair: basePair,
        description: 'bad amount issuance',
        longLeg: {
          // @ts-expect-error intentional misuse: a binary float amount must be rejected (NFR-2)
          postings: [{ accountId: longAcct, direction: 'DEBIT', amount: 500_000 }],
        },
        shortLeg: {
          postings: [{ accountId: fundingAcct, direction: 'CREDIT', amount: 500_000n }],
        },
      }),
    ).rejects.toBeInstanceOf(InvalidJournalEntryError);
    expect(await countPairs()).toBe(0);
    expect(await countEntries()).toBe(0);
  });
});
