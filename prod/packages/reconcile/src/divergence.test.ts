// Story 5.5 AC-2 — the READ-ONLY ledger↔chain divergence signal, proven against the LOCAL Postgres
// with SYNTHETIC in-memory on-chain supplies (NO Sepolia, NO RPC, NO key). A chain-consistent
// snapshot reports NO divergence; a deliberate mismatch is REPORTED (exact integer delta) but the
// ledger is left UNCHANGED — correction is Story 5.6.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import { buildGroupView } from './group-view.js';
import { loadChainSupplySnapshot, type ChainSupplySnapshot } from './chain-supply.js';

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

// Seeds a mint-like balanced entry: 1000 ROSE_L into a holder (ASSET) account, supply contra
// (LIABILITY) credited — so the ledger ASSET-side quantity for ROSE_L is 1000.
async function seedLedgerSupply(): Promise<void> {
  const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0); // ASSET
  const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0); // LIABILITY (excluded)
  await recordJournalEntry(db, {
    description: 'mint ROSE_L',
    postings: [
      { accountId: holder, direction: 'DEBIT', amount: 1000n },
      { accountId: contra, direction: 'CREDIT', amount: 1000n },
    ],
  });
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

describe('group view — read-only divergence signal (AC-2)', () => {
  it('reports NO divergence when the ledger is chain-consistent', async () => {
    await seedLedgerSupply();
    const chainSupplies: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [{ asset: 'ROSE_L', scale: 0, totalSupply: 1000n }],
    };
    const view = await buildGroupView(db, { now: NOW, chainSupplies });
    expect(view.source).toBe('ledger+chain');
    expect(view.chainComparison.source).toBe('ledger+chain');
    expect(view.chainComparison.anyDivergence).toBe(false);
    const d = view.chainComparison.divergences[0]!;
    expect(d.asset).toBe('ROSE_L');
    expect(d.ledgerQuantity.smallestUnits).toBe('1000');
    expect(d.onChainTotalSupply.smallestUnits).toBe('1000');
    expect(d.divergence.smallestUnits).toBe('0');
    expect(d.diverged).toBe(false);
  });

  it('REPORTS the exact divergence on a deliberate mismatch and leaves the ledger UNCHANGED', async () => {
    await seedLedgerSupply();
    const before = await countEntries();
    const chainSupplies: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [{ asset: 'ROSE_L', scale: 0, totalSupply: 1200n }],
    };
    const view = await buildGroupView(db, { now: NOW, chainSupplies });
    expect(view.chainComparison.anyDivergence).toBe(true);
    const d = view.chainComparison.divergences[0]!;
    expect(d.ledgerQuantity.smallestUnits).toBe('1000');
    expect(d.onChainTotalSupply.smallestUnits).toBe('1200');
    expect(d.divergence.smallestUnits).toBe('200'); // onChain − ledger (chain authoritative, D3)
    expect(d.diverged).toBe(true);
    // READ-ONLY: no correcting entry was posted (that is Story 5.6).
    expect(await countEntries()).toBe(before);
  });

  it('is ledger-only (no divergence check) when no snapshot is supplied', async () => {
    await seedLedgerSupply();
    const view = await buildGroupView(db, { now: NOW });
    expect(view.source).toBe('ledger-only');
    expect(view.chainComparison).toEqual({
      source: 'ledger-only',
      divergences: [],
      anyDivergence: false,
    });
  });
});

describe('loadChainSupplySnapshot — the injected reader seam', () => {
  it('maps the reader over the token list and rejects a non-bigint supply (NFR-2)', async () => {
    const snapshot = await loadChainSupplySnapshot(
      async (t) => (t.asset === 'ROSE_L' ? 1000n : 2000n),
      [
        { asset: 'ROSE_L', scale: 0, address: '0xL' },
        { asset: 'ROSE_S', scale: 0, address: '0xS' },
      ],
    );
    expect(snapshot.source).toBe('ledger+chain');
    expect(snapshot.tokens).toEqual([
      { asset: 'ROSE_L', scale: 0, totalSupply: 1000n },
      { asset: 'ROSE_S', scale: 0, totalSupply: 2000n },
    ]);

    await expect(
      loadChainSupplySnapshot(
        // @ts-expect-error — a float supply is rejected (NFR-2)
        async () => 1.5,
        [{ asset: 'ROSE_L', scale: 0, address: '0xL' }],
      ),
    ).rejects.toThrow();
  });
});
