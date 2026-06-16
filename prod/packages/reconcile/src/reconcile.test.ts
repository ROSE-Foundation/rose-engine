// Story 5.6 — reconcile-and-CORRECT toward the chain (FR-10 / NFR-9, D3), proven against the LOCAL
// Postgres with SYNTHETIC in-memory on-chain supplies (NO Sepolia, NO RPC, NO key). A deliberate
// ledger↔chain mismatch is REPORTED and CORRECTED via a journaled, balanced double-entry; a
// chain-consistent ledger is left untouched (idempotence).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import {
  InvalidCorrectionAccountsError,
  reconcileLedgerToChain,
  serializeReconciliationReport,
  UnreconciledDivergenceError,
  type TokenCorrectionAccounts,
} from './reconcile.js';
import type { ChainSupplySnapshot } from './chain-supply.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
const NOW = new Date('2026-06-16T00:00:00.000Z');

async function entityId(code: string): Promise<string> {
  const r = await pool.query<{ id: string }>('SELECT id FROM entities WHERE code = $1', [code]);
  return r.rows[0]!.id;
}

async function mkAccount(
  code: string,
  type: string,
  asset: string,
  scale: number,
): Promise<string> {
  const eid = await entityId(code);
  const r = await pool.query<{ id: string }>(
    'INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1,$2,$3,$4) RETURNING id',
    [eid, type, asset, scale],
  );
  return r.rows[0]!.id;
}

async function countEntries(): Promise<number> {
  const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM journal_entries');
  return r.rows[0]!.n;
}

async function holderNet(accountId: string): Promise<bigint> {
  // DEBIT-normal ASSET account: net = debit − credit.
  const r = await pool.query<{ debit: string; credit: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)  AS debit,
       COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS credit
     FROM postings WHERE account_id = $1`,
    [accountId],
  );
  return BigInt(r.rows[0]!.debit.split('.')[0]!) - BigInt(r.rows[0]!.credit.split('.')[0]!);
}

// Seeds a mint-like balanced entry of `qty` ROSE_L into the holder (ASSET), contra (LIABILITY).
async function seedLedger(holder: string, contra: string, qty: bigint): Promise<void> {
  await recordJournalEntry(db, {
    description: 'seed mint ROSE_L',
    postings: [
      { accountId: holder, direction: 'DEBIT', amount: qty },
      { accountId: contra, direction: 'CREDIT', amount: qty },
    ],
  });
}

function snapshotOf(asset: string, scale: number, totalSupply: bigint): ChainSupplySnapshot {
  return { source: 'ledger+chain', tokens: [{ asset, scale, totalSupply }] };
}

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
  await pool.query(
    'TRUNCATE accounts, journal_entries, postings, coupled_pairs, rose_notes, outbox_events CASCADE',
  );
});

describe('reconcileLedgerToChain — correct toward chain (AC-2)', () => {
  it('CORRECTS a positive mismatch (chain > ledger) with ONE balanced journaled entry', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);
    const before = await countEntries();

    const corrections: TokenCorrectionAccounts[] = [
      { asset: 'ROSE_L', scale: 0, holderAccountId: holder, contraAccountId: contra },
    ];
    const report = await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), {
      now: NOW,
      corrections,
    });

    // Reported AND corrected.
    expect(report.anyDivergence).toBe(true);
    expect(report.anyCorrected).toBe(true);
    expect(report.corrections).toBe(1);
    const t = report.tokens[0]!;
    expect(t.divergence.smallestUnits).toBe('200'); // onChain − ledger (D3)
    expect(t.corrected).toBe(true);
    expect(t.journalEntryId).not.toBeNull();
    expect(t.ledgerQuantityAfter.smallestUnits).toBe('1200');

    // Exactly ONE correcting entry; holder ASSET net rose by 200; re-derived quantity == chain.
    expect(await countEntries()).toBe(before + 1);
    expect(await holderNet(holder)).toBe(1200n);

    // The correcting entry is balanced (the DB trigger would have rejected an unbalanced one) and its
    // description names the signed divergence (auditable, never silent).
    const desc = await pool.query<{ description: string }>(
      'SELECT description FROM journal_entries WHERE id = $1',
      [t.journalEntryId],
    );
    expect(desc.rows[0]!.description).toContain('+200');
    expect(desc.rows[0]!.description.toLowerCase()).toContain('chain');
  });

  it('CORRECTS a negative mismatch (chain < ledger) by lowering the holder toward chain', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_S', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_S', 0);
    await seedLedger(holder, contra, 1000n);

    const report = await reconcileLedgerToChain(db, snapshotOf('ROSE_S', 0, 850n), {
      now: NOW,
      corrections: [
        { asset: 'ROSE_S', scale: 0, holderAccountId: holder, contraAccountId: contra },
      ],
    });

    const t = report.tokens[0]!;
    expect(t.divergence.smallestUnits).toBe('-150'); // chain has less
    expect(t.corrected).toBe(true);
    expect(t.ledgerQuantityAfter.smallestUnits).toBe('850');
    expect(await holderNet(holder)).toBe(850n); // re-derived quantity equals the chain
  });

  it('re-deriving the ledger ASSET-side quantity after correction equals the chain (idempotent second run)', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);
    const corrections: TokenCorrectionAccounts[] = [
      { asset: 'ROSE_L', scale: 0, holderAccountId: holder, contraAccountId: contra },
    ];

    await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), { now: NOW, corrections });
    const afterFirst = await countEntries();

    // Second run against the SAME chain state ⇒ no divergence ⇒ no new entry.
    const report2 = await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), {
      now: NOW,
      corrections,
    });
    expect(report2.anyCorrected).toBe(false);
    expect(report2.tokens[0]!.divergence.smallestUnits).toBe('0');
    expect(await countEntries()).toBe(afterFirst);
  });
});

describe('reconcileLedgerToChain — idempotence on a consistent ledger (AC-3)', () => {
  it('posts NOTHING when the ledger already matches the chain', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);
    const before = await countEntries();

    const report = await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1000n), {
      now: NOW,
      corrections: [
        { asset: 'ROSE_L', scale: 0, holderAccountId: holder, contraAccountId: contra },
      ],
    });
    expect(report.anyDivergence).toBe(false);
    expect(report.anyCorrected).toBe(false);
    expect(report.corrections).toBe(0);
    expect(await countEntries()).toBe(before);
  });
});

describe('reconcileLedgerToChain — reporting & NFR-2 (AC-1, AC-2)', () => {
  it('surfaces consolidated internal-consistency flags (AC-1)', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);

    const report = await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1000n), {
      now: NOW,
      corrections: [],
    });
    const row = report.internalConsistency.find((r) => r.asset === 'ROSE_L' && r.scale === 0);
    expect(row).toBeDefined();
    expect(row!.balanced).toBe(true);
    expect(report.anyImbalance).toBe(false);
  });

  it('report JSON contains NO bigint and round-trips through JSON.stringify (NFR-2)', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);

    const report = await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), {
      now: NOW,
      corrections: [
        { asset: 'ROSE_L', scale: 0, holderAccountId: holder, contraAccountId: contra },
      ],
    });
    const json = serializeReconciliationReport(report);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toMatch(/\d+n[\s,}]/); // no bigint literal leaked
    const parsed = JSON.parse(json) as {
      tokens: Array<{ divergence: { decimal: string }; onChainTotalSupply: { decimal: string } }>;
    };
    expect(parsed.tokens[0]!.divergence.decimal).toBe('200'); // onChain − ledger, exact integer
    expect(parsed.tokens[0]!.onChainTotalSupply.decimal).toBe('1200'); // scale 0 ⇒ exact integer
  });
});

describe('reconcileLedgerToChain — uncorrectable divergence (fail-loud option)', () => {
  it('REPORTS a diverged token with no mapping as uncorrectable (non-strict)', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);
    const before = await countEntries();

    const report = await reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), {
      now: NOW,
      corrections: [], // no mapping for ROSE_L
    });
    const t = report.tokens[0]!;
    expect(t.diverged).toBe(true);
    expect(t.correctable).toBe(false);
    expect(t.corrected).toBe(false);
    expect(report.anyCorrected).toBe(false);
    expect(await countEntries()).toBe(before); // nothing posted
  });

  it('THROWS UnreconciledDivergenceError in strict mode and rolls back (no entry)', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);
    const before = await countEntries();

    await expect(
      reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), {
        now: NOW,
        corrections: [],
        strict: true,
      }),
    ).rejects.toThrow(UnreconciledDivergenceError);
    expect(await countEntries()).toBe(before);
  });

  it('THROWS when a holder account is not ASSET-classified (would break idempotence)', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await seedLedger(holder, contra, 1000n);

    await expect(
      reconcileLedgerToChain(db, snapshotOf('ROSE_L', 0, 1200n), {
        now: NOW,
        // holder/contra swapped: the LIABILITY account is given as the "holder" (not ASSET).
        corrections: [
          { asset: 'ROSE_L', scale: 0, holderAccountId: contra, contraAccountId: holder },
        ],
      }),
    ).rejects.toThrow(InvalidCorrectionAccountsError);
  });
});
