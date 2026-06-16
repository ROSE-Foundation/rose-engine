// Story 5.5 — the human-readable text rendering (FR-9). Built from the same DB-backed GroupView the
// JSON view uses; asserts the text contains the entities, per-account-type rows, the consolidated
// group NAV, the coupled-pair position, and the divergence/no-divergence result, with amounts as
// exact formatted decimals (never raw smallest-units, never floats).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import { buildGroupView } from './group-view.js';
import { renderGroupViewText } from './group-view-text.js';
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

describe('renderGroupViewText', () => {
  it('renders entities, account rows, consolidated NAV, pair, and a no-divergence result', async () => {
    const float = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2);
    const liab = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2);
    await recordJournalEntry(db, {
      description: 'subscribe',
      postings: [
        { accountId: float, direction: 'DEBIT', amount: 150050n },
        { accountId: liab, direction: 'CREDIT', amount: 150050n },
      ],
    });
    await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.10500000',
      leverage: '2',
      collateralPool: 1_000_000n,
      floor: '0.5',
      longLegValue: 500_000n,
      shortLegValue: 500_000n,
      state: 'ACTIVE',
    });

    const chainSupplies: ChainSupplySnapshot = { source: 'ledger+chain', tokens: [] };
    const view = await buildGroupView(db, { now: NOW, chainSupplies });
    const text = renderGroupViewText(view);

    expect(text).toContain('ROSE — Consolidated Group View');
    expect(text).toContain('Source: ledger+chain');
    expect(text).toContain('VCC');
    expect(text).toContain('BACKING_FLOAT');
    expect(text).toContain('NOTE_LIABILITY');
    // Exact decimal in the human view (not the raw 150050).
    expect(text).toContain('1500.50 EUR');
    expect(text).not.toContain('150050');
    expect(text).toContain('NAV 0.00 EUR');
    expect(text).toContain('[balanced]');
    expect(text).toContain('EUR/USD');
    expect(text).toContain('V_A=500000');
    // No binary-float artifacts in the human view. Strip random UUIDs first — a generated
    // coupled-pair id can contain the hex substring "e-" (e.g. "436e-9a51"), which would otherwise
    // false-match the scientific-notation guard.
    const withoutUuids = text.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>',
    );
    expect(withoutUuids).not.toMatch(/NaN|e\+|e-/);
  });

  it('renders a DIVERGENCE result line when ledger and chain disagree', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0);
    const contra = await mkAccount('COIN_ISSUER', 'NOTE_LIABILITY', 'ROSE_L', 0);
    await recordJournalEntry(db, {
      description: 'mint ROSE_L',
      postings: [
        { accountId: holder, direction: 'DEBIT', amount: 1000n },
        { accountId: contra, direction: 'CREDIT', amount: 1000n },
      ],
    });
    const chainSupplies: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [{ asset: 'ROSE_L', scale: 0, totalSupply: 1200n }],
    };
    const view = await buildGroupView(db, { now: NOW, chainSupplies });
    const text = renderGroupViewText(view);
    expect(text).toContain('DIVERGENCE');
    expect(text).toContain('RESULT: divergence detected (reported only; correction is Story 5.6).');
  });

  it('notes ledger-only when no snapshot is supplied', async () => {
    const view = await buildGroupView(db, { now: NOW });
    const text = renderGroupViewText(view);
    expect(text).toContain('ledger-only — no on-chain supply snapshot supplied');
  });
});
