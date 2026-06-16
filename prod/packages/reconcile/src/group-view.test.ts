// Story 5.5 — the consolidated group view proven against the LOCAL Postgres (NO Sepolia, NO
// network, NO key). Read-only: SELECTs entities/accounts/postings/coupled_pairs/rose_notes and
// asserts per-entity per-account-type balances, the consolidated group NAV (assets − liabilities),
// exact integer→decimal formatting (NFR-2), coupled-pair positions + note embedding, the empty
// ledger, and a JSON view that carries NO bigint and round-trips through JSON.stringify.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCoupledPair,
  createDb,
  createPool,
  createRoseNote,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import { buildGroupView, serializeGroupView } from './group-view.js';

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

// Asserts a value (deeply) contains NO bigint — bigints throw in JSON.stringify, so this is the
// NFR-2 boundary check for the JSON view.
function assertNoBigint(value: unknown, path = '$'): void {
  if (typeof value === 'bigint') throw new Error(`bigint found at ${path}`);
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error(`non-finite at ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
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

describe('buildGroupView — empty ledger', () => {
  it('renders the four fixed entities with no accounts and an empty consolidation', async () => {
    const view = await buildGroupView(db, { now: NOW });
    expect(view.generatedAt).toBe('2026-06-16T00:00:00.000Z');
    expect(view.source).toBe('ledger-only');
    expect(view.entities.map((e) => e.entityCode)).toEqual([
      'VCC',
      'HOLDING',
      'TRADING_CO',
      'COIN_ISSUER',
    ]);
    for (const e of view.entities) {
      expect(e.accounts).toEqual([]);
      expect(e.byAsset).toEqual([]);
    }
    expect(view.consolidated).toEqual([]);
    expect(view.coupledPairs).toEqual([]);
    expect(view.chainComparison).toEqual({
      source: 'ledger-only',
      divergences: [],
      anyDivergence: false,
    });
    // JSON view: no bigint, round-trips.
    assertNoBigint(view);
    expect(JSON.parse(serializeGroupView(view))).toEqual(JSON.parse(JSON.stringify(view)));
  });
});

describe('buildGroupView — per-entity / per-account-type balances + NAV (AC-1)', () => {
  it('computes normal-side net balances and group NAV = assets − liabilities, exact from integers', async () => {
    const float = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2); // ASSET, debit-normal
    const liab = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2); // LIABILITY, credit-normal
    const fee = await mkAccount('VCC', 'FEE_INCOME', 'EUR', 2); // EQUITY, credit-normal

    // 1500.50 backing float against a note liability (delta), then 1.00 fee income.
    await recordJournalEntry(db, {
      description: 'subscribe',
      postings: [
        { accountId: float, direction: 'DEBIT', amount: 150050n },
        { accountId: liab, direction: 'CREDIT', amount: 150050n },
      ],
    });
    await recordJournalEntry(db, {
      description: 'fee',
      postings: [
        { accountId: float, direction: 'DEBIT', amount: 100n },
        { accountId: fee, direction: 'CREDIT', amount: 100n },
      ],
    });

    const view = await buildGroupView(db, { now: NOW });
    const vcc = view.entities.find((e) => e.entityCode === 'VCC')!;
    const byId = new Map(vcc.accounts.map((a) => [a.accountId, a]));

    // Exact integer → decimal formatting (NFR-2).
    expect(byId.get(float)!.net.smallestUnits).toBe('150150');
    expect(byId.get(float)!.net.decimal).toBe('1501.50');
    expect(byId.get(float)!.navRole).toBe('ASSET');
    expect(byId.get(liab)!.net.decimal).toBe('1500.50'); // credit-normal positive
    expect(byId.get(liab)!.navRole).toBe('LIABILITY');
    expect(byId.get(fee)!.net.decimal).toBe('1.00');
    expect(byId.get(fee)!.navRole).toBe('EQUITY');

    // Per-entity per-asset subtotal.
    const eur = vcc.byAsset.find((s) => s.asset === 'EUR')!;
    expect(eur.assets.decimal).toBe('1501.50');
    expect(eur.liabilities.decimal).toBe('1500.50');
    expect(eur.equity.decimal).toBe('1.00');
    expect(eur.nav.decimal).toBe('1.00'); // assets − liabilities = equity

    // Consolidated group view.
    const cons = view.consolidated.find((c) => c.asset === 'EUR')!;
    expect(cons.assets.decimal).toBe('1501.50');
    expect(cons.liabilities.decimal).toBe('1500.50');
    expect(cons.nav.decimal).toBe('1.00');
    expect(cons.balanced).toBe(true);

    assertNoBigint(view);
  });

  it('keeps the same asset label at different scales as DISTINCT denominations (review patch)', async () => {
    // The ledger balances per (asset, decimal_scale); EUR@2 and EUR@4 are different denominations.
    const float2 = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2);
    const liab2 = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2);
    const float4 = await mkAccount('VCC', 'DEPLOYED_CAPITAL', 'EUR', 4);
    const liab4 = await mkAccount('VCC', 'CLIENT_COLLATERAL', 'EUR', 4);
    await recordJournalEntry(db, {
      description: 'eur@2',
      postings: [
        { accountId: float2, direction: 'DEBIT', amount: 100n },
        { accountId: liab2, direction: 'CREDIT', amount: 100n },
      ],
    });
    await recordJournalEntry(db, {
      description: 'eur@4',
      postings: [
        { accountId: float4, direction: 'DEBIT', amount: 5000n },
        { accountId: liab4, direction: 'CREDIT', amount: 5000n },
      ],
    });

    const view = await buildGroupView(db, { now: NOW });
    const eur = view.consolidated.filter((c) => c.asset === 'EUR');
    // Two distinct (EUR, scale) rows — NOT one mangled cross-scale sum.
    expect(eur.map((c) => c.scale)).toEqual([2, 4]);
    const eur2 = eur.find((c) => c.scale === 2)!;
    const eur4 = eur.find((c) => c.scale === 4)!;
    expect(eur2.assets.decimal).toBe('1.00'); // 100 @ scale 2
    expect(eur2.balanced).toBe(true);
    expect(eur4.assets.decimal).toBe('0.5000'); // 5000 @ scale 4
    expect(eur4.balanced).toBe(true);
  });

  it('aggregates the same asset across multiple entities into the consolidation', async () => {
    const vccFloat = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2);
    const tcDeployed = await mkAccount('TRADING_CO', 'DEPLOYED_CAPITAL', 'EUR', 2);
    const vccLiab = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2);
    // Move 200.00 from VCC float into TRADING_CO deployed capital, funded by a note liability.
    await recordJournalEntry(db, {
      description: 'deploy',
      postings: [
        { accountId: tcDeployed, direction: 'DEBIT', amount: 20000n },
        { accountId: vccLiab, direction: 'CREDIT', amount: 20000n },
      ],
    });
    void vccFloat;
    const view = await buildGroupView(db, { now: NOW });
    const cons = view.consolidated.find((c) => c.asset === 'EUR')!;
    // assets = deployed 200.00; liabilities = note 200.00; nav 0.00; balanced.
    expect(cons.assets.decimal).toBe('200.00');
    expect(cons.liabilities.decimal).toBe('200.00');
    expect(cons.nav.decimal).toBe('0.00');
    expect(cons.balanced).toBe(true);
  });
});

describe('buildGroupView — coupled-pair positions + note embedding (AC-1)', () => {
  it('surfaces V_A/V_B/K as integer strings and the embedding note id', async () => {
    const pair = await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.10500000',
      leverage: '2',
      collateralPool: 1_000_000n,
      floor: '0.5',
      longLegValue: 500_000n,
      shortLegValue: 500_000n,
      state: 'ACTIVE',
    });
    const note = await createRoseNote(db, { coupledPairId: pair.id });

    const view = await buildGroupView(db, { now: NOW });
    expect(view.coupledPairs).toHaveLength(1);
    const p = view.coupledPairs[0]!;
    expect(p.id).toBe(pair.id);
    expect(p.referenceAsset).toBe('EUR/USD');
    expect(p.state).toBe('ACTIVE');
    expect(p.longLegValue).toBe('500000');
    expect(p.shortLegValue).toBe('500000');
    expect(p.collateralPool).toBe('1000000');
    expect(p.anchorPrice).toBe('1.10500000');
    expect(p.leverage).toBe('2');
    expect(p.floor).toBe('0.5');
    expect(p.noteId).toBe(note.id);
  });
});
