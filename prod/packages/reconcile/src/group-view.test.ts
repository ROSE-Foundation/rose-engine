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

describe('buildGroupView — Treasury Dashboard enrichment', () => {
  const THRESHOLDS = {
    backingFloatFloor: '0.60',
    clientCollateralRatio: '1.00',
    deployCeiling: '0.35',
  };

  it('seeds the four entities with their static roles and a NOT_CHECKED status when ledger-only', async () => {
    const view = await buildGroupView(db, { now: NOW });
    const byCode = new Map(view.entities.map((e) => [e.entityCode, e]));
    expect(byCode.get('VCC')!.role).toBe('TREASURY_NOTE_ISSUER');
    expect(byCode.get('HOLDING')!.role).toBe('COORDINATION');
    expect(byCode.get('TRADING_CO')!.role).toBe('TRADING');
    expect(byCode.get('COIN_ISSUER')!.role).toBe('COIN_ISSUANCE');
    // No chain snapshot ⇒ reconciliation not checked.
    expect(view.entities.every((e) => e.reconciliationStatus === 'NOT_CHECKED')).toBe(true);
  });

  it('marks an entity DIVERGENT only when it holds an account in a diverged denomination', async () => {
    // VCC holds ROSE-L (ASSET 20000); HOLDING holds ROSE-S (ASSET 5000). Each balanced within its asset.
    const vccFloat = await mkAccount('VCC', 'BACKING_FLOAT', 'ROSE-L', 0);
    const vccLiab = await mkAccount('VCC', 'NOTE_LIABILITY', 'ROSE-L', 0);
    const holdFloat = await mkAccount('HOLDING', 'BACKING_FLOAT', 'ROSE-S', 0);
    const holdLiab = await mkAccount('HOLDING', 'NOTE_LIABILITY', 'ROSE-S', 0);
    await recordJournalEntry(db, {
      description: 'rose-l mint',
      postings: [
        { accountId: vccFloat, direction: 'DEBIT', amount: 20000n },
        { accountId: vccLiab, direction: 'CREDIT', amount: 20000n },
      ],
    });
    await recordJournalEntry(db, {
      description: 'rose-s mint',
      postings: [
        { accountId: holdFloat, direction: 'DEBIT', amount: 5000n },
        { accountId: holdLiab, direction: 'CREDIT', amount: 5000n },
      ],
    });
    // Chain: ROSE-L diverges (15000 ≠ ledger 20000); ROSE-S matches (5000).
    const view = await buildGroupView(db, {
      now: NOW,
      chainSupplies: {
        source: 'ledger+chain',
        tokens: [
          { asset: 'ROSE-L', scale: 0, totalSupply: 15000n },
          { asset: 'ROSE-S', scale: 0, totalSupply: 5000n },
        ],
      },
    });
    const byCode = new Map(view.entities.map((e) => [e.entityCode, e]));
    expect(byCode.get('VCC')!.reconciliationStatus).toBe('DIVERGENT');
    expect(byCode.get('HOLDING')!.reconciliationStatus).toBe('RECONCILED');
  });

  it('computes the covenant monitor against the dominant denomination (PASS/WATCH/BREACH)', async () => {
    const backing = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2); // ASSET
    const deployed = await mkAccount('VCC', 'DEPLOYED_CAPITAL', 'EUR', 2); // ASSET
    const client = await mkAccount('VCC', 'CLIENT_COLLATERAL', 'EUR', 2); // LIABILITY
    const fee = await mkAccount('VCC', 'FEE_INCOME', 'EUR', 2); // EQUITY
    // assets: backing 7000.00 + deployed 4000.00 = 11000.00; client liability 1000.00; NAV = 10000.00.
    await recordJournalEntry(db, {
      description: 'backing vs fee',
      postings: [
        { accountId: backing, direction: 'DEBIT', amount: 600000n },
        { accountId: fee, direction: 'CREDIT', amount: 600000n },
      ],
    });
    await recordJournalEntry(db, {
      description: 'deploy vs fee',
      postings: [
        { accountId: deployed, direction: 'DEBIT', amount: 400000n },
        { accountId: fee, direction: 'CREDIT', amount: 400000n },
      ],
    });
    await recordJournalEntry(db, {
      description: 'client collateral in',
      postings: [
        { accountId: backing, direction: 'DEBIT', amount: 100000n },
        { accountId: client, direction: 'CREDIT', amount: 100000n },
      ],
    });

    const view = await buildGroupView(db, { now: NOW, covenantThresholds: THRESHOLDS });
    const byKey = new Map(view.covenants.map((c) => [c.key, c]));

    // backing 700000 / NAV 1000000 = 70% ≥ 60% floor ⇒ PASS.
    expect(byKey.get('backing-float-floor')).toMatchObject({
      kind: 'floor',
      thresholdBps: 6000,
      currentBps: 7000,
      status: 'PASS',
    });
    // deployed 400000 / NAV 1000000 = 40% > 35% ceiling ⇒ BREACH.
    expect(byKey.get('deploy-ratio-ceiling')).toMatchObject({
      kind: 'ceiling',
      thresholdBps: 3500,
      currentBps: 4000,
      status: 'BREACH',
    });
    // assets 1100000 / client liability 100000 = 1100% ≥ 100% floor ⇒ PASS.
    expect(byKey.get('client-collateral-coverage')).toMatchObject({
      currentBps: 110000,
      status: 'PASS',
    });
  });

  it('returns NA covenants when NAV is zero (no divide-by-zero) and no covenants without thresholds', async () => {
    const backing = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2);
    const liab = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2);
    // assets 5000.00, liabilities 5000.00 ⇒ NAV = 0.
    await recordJournalEntry(db, {
      description: 'subscribe',
      postings: [
        { accountId: backing, direction: 'DEBIT', amount: 500000n },
        { accountId: liab, direction: 'CREDIT', amount: 500000n },
      ],
    });

    const withThresholds = await buildGroupView(db, { now: NOW, covenantThresholds: THRESHOLDS });
    const floor = withThresholds.covenants.find((c) => c.key === 'backing-float-floor')!;
    expect(floor.currentBps).toBeNull();
    expect(floor.status).toBe('NA');

    const withoutThresholds = await buildGroupView(db, { now: NOW });
    expect(withoutThresholds.covenants).toEqual([]);
  });

  it('flags a floor covenant BREACH (not NA) when NAV is negative (insolvent denominator)', async () => {
    const backing = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2);
    const fee = await mkAccount('VCC', 'FEE_INCOME', 'EUR', 2);
    const liab = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2);
    // assets 30.00 (backing), liabilities 50.00 (note); fee debited 20.00 to balance ⇒ NAV = -20.00 < 0.
    await recordJournalEntry(db, {
      description: 'insolvent',
      postings: [
        { accountId: backing, direction: 'DEBIT', amount: 3000n },
        { accountId: fee, direction: 'DEBIT', amount: 2000n },
        { accountId: liab, direction: 'CREDIT', amount: 5000n },
      ],
    });
    const view = await buildGroupView(db, { now: NOW, covenantThresholds: THRESHOLDS });
    const floor = view.covenants.find((c) => c.key === 'backing-float-floor')!;
    expect(floor.currentBps).toBeNull();
    expect(floor.status).toBe('BREACH');
  });

  it('aggregates net exposure and the coupled-coin book by market', async () => {
    await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.10000000',
      leverage: '2',
      collateralPool: 20_000n,
      floor: '0.5',
      longLegValue: 10_000n,
      shortLegValue: 10_000n,
      state: 'ACTIVE',
    });
    await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.20000000',
      leverage: '2',
      collateralPool: 6_000n,
      floor: '0.5',
      longLegValue: 4_000n,
      shortLegValue: 2_000n,
      state: 'ACTIVE',
    });
    await createCoupledPair(db, {
      referenceAsset: 'BTC/USD',
      anchorPrice: '60000.00000000',
      leverage: '3',
      collateralPool: 9_000n,
      floor: '0.6',
      longLegValue: 5_000n,
      shortLegValue: 4_000n,
      state: 'ACTIVE',
    });

    const view = await buildGroupView(db, { now: NOW });
    // Net exposure is PER market (never summed across unlike reference assets / units).
    const exposure = new Map(view.netExposure.map((m) => [m.referenceAsset, m]));
    expect(exposure.get('EUR/USD')).toEqual({
      referenceAsset: 'EUR/USD',
      pairCount: 2,
      longTotal: '14000',
      shortTotal: '12000',
      net: '2000',
    });
    expect(exposure.get('BTC/USD')).toEqual({
      referenceAsset: 'BTC/USD',
      pairCount: 1,
      longTotal: '5000',
      shortTotal: '4000',
      net: '1000',
    });
    // Book grouped by reference asset (sorted): BTC/USD then EUR/USD.
    const book = new Map(view.coupledCoinBook.map((m) => [m.referenceAsset, m]));
    expect(book.get('EUR/USD')).toEqual({
      referenceAsset: 'EUR/USD',
      pairs: 2,
      longNotional: '14000',
      shortNotional: '12000',
      collateral: '26000',
      net: '2000',
    });
    expect(book.get('BTC/USD')).toMatchObject({ pairs: 1, longNotional: '5000', net: '1000' });
    assertNoBigint(view);
  });
});
