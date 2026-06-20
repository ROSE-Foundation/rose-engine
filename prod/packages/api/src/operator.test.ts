// Story 9.5 — the operator control-panel routes proven IN-PROCESS via Fastify `inject` against the
// LOCAL Postgres (NO Sepolia, NO network port, NO key). Asserts the three faithful-gated injection
// controls round-trip (GET + PUT each), out-of-range confirmation patches fail-closed (400), the
// covenant-breach toggle drives `GET /group-view` to a GENUINE BREACH (and clears), the
// reconcile-divergence toggle drives `POST /positions/reconcile` to report-and-correct a real
// divergence through the Story-8.5 path (and clears), and EVERY operator endpoint is a typed 503 when
// its store is not composed (read-only / non-faithful deployment) — mirroring `simulation.test.ts`.
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import { createPosition, getPosition, type PositionService } from '@rose/positions';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { makeFaithfulConfirmationSettingsStore } from './faithful/confirmation-settings.js';
import { makeFaithfulCovenantOverrideStore } from './faithful/covenant-override.js';
import { makeFaithfulReconcileInjectionStore } from './faithful/reconcile-injection.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

beforeAll(async () => {
  pool = createPool();
  await hardReset(pool);
  await migrateUp(pool);
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE positions, rose_notes, coupled_pairs, accounts, postings, journal_entries CASCADE',
  );
});

async function entityId(code: string): Promise<string> {
  const r = await pool.query<{ id: string }>('SELECT id FROM entities WHERE code = $1', [code]);
  return r.rows[0]!.id;
}

/** Inserts an account on the given entity and returns its id (raw insert, mirroring the reconcile tests). */
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

/**
 * A minimal `PositionService` stub: the `POST /positions/reconcile` route only consults it as the
 * paper/faithful composition GATE (`requirePositionService`) — it never invokes a method on this path —
 * so the unused methods throw and the nullable readers return null.
 */
function stubPositionService(): PositionService {
  const unused = async (): Promise<never> => {
    throw new Error('position service method not exercised by the reconcile route');
  };
  return {
    openPosition: unused,
    confirmOpen: unused,
    getOpenPosition: async () => null,
    closePosition: unused,
    confirmClose: async () => null,
    getClosePosition: async () => null,
  };
}

// ─── 1. Confirmation latency / failure injection (wired to Story 9.1) ─────────────────────────────
describe('GET/PUT /operator/confirmation', () => {
  function appWith(): Promise<FastifyInstance> {
    return buildApp({ db, confirmationSettings: makeFaithfulConfirmationSettingsStore() });
  }

  it('GET returns the current confirmation settings, version and bounds', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/operator/confirmation' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ latencyMs: 2000, failureRate: 0, failNext: false, version: 0 });
    expect(body.bounds).toMatchObject({ latencyMsMax: expect.any(Number) });
    await app.close();
  });

  it('PUT applies a valid patch (latency + fail-next) and bumps the version', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'PUT',
      url: '/operator/confirmation',
      payload: { latencyMs: 5000, failNext: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ latencyMs: 5000, failNext: true, version: 1 });
    await app.close();
  });

  it('PUT rejects an out-of-range failureRate with a typed 400 (fail-closed, never clamped)', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'PUT',
      url: '/operator/confirmation',
      payload: { failureRate: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('FaithfulConfirmationSettingsError');
    await app.close();
  });
});

// ─── 2. Covenant-breach injection (real group-view covenant computation) ──────────────────────────
describe('GET/PUT /operator/covenant-breach', () => {
  /** Seed a NAV ≈ 0 ledger (assets = liabilities) — the seeded faithful demo shape the fix targets. */
  async function seedNavZeroLedger(): Promise<void> {
    const backing = await mkAccount('VCC', 'BACKING_FLOAT', 'EUR', 2); // ASSET
    const liab = await mkAccount('VCC', 'NOTE_LIABILITY', 'EUR', 2); // LIABILITY
    await recordJournalEntry(db, {
      description: 'subscribe (assets = liabilities ⇒ NAV ≈ 0)',
      postings: [
        { accountId: backing, direction: 'DEBIT', amount: 500000n },
        { accountId: liab, direction: 'CREDIT', amount: 500000n },
      ],
    });
  }

  it('GET returns the inactive default toggle state', async () => {
    const app = await buildApp({ db, covenantOverride: makeFaithfulCovenantOverrideStore() });
    const res = await app.inject({ method: 'GET', url: '/operator/covenant-breach' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false, version: 0 });
    await app.close();
  });

  it('PUT {active:true} drives GET /group-view to a genuine BREACH at NAV ≈ 0, and clearing returns to no BREACH', async () => {
    await seedNavZeroLedger();
    const covenantOverride = makeFaithfulCovenantOverrideStore();
    const app = await buildApp({ db, covenantOverride });

    // Cleared (default): the backing-float floor is NA at NAV ≈ 0 — no BREACH row.
    const before = await app.inject({ method: 'GET', url: '/group-view' });
    expect(before.json().covenants.some((c: { status: string }) => c.status === 'BREACH')).toBe(
      false,
    );

    // Arm the injection.
    const put = await app.inject({
      method: 'PUT',
      url: '/operator/covenant-breach',
      payload: { active: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ active: true, version: 1 });

    // Now the REAL covenant monitor reports a genuine BREACH row (not a cosmetic flag).
    const breached = await app.inject({ method: 'GET', url: '/group-view' });
    const floor = breached
      .json()
      .covenants.find((c: { key: string }) => c.key === 'backing-float-floor');
    expect(floor).toBeDefined();
    expect(floor.status).toBe('BREACH');

    // Clear it — back to the normal computed status (no BREACH).
    const clear = await app.inject({
      method: 'PUT',
      url: '/operator/covenant-breach',
      payload: { active: false },
    });
    expect(clear.json()).toEqual({ active: false, version: 2 });
    const after = await app.inject({ method: 'GET', url: '/group-view' });
    expect(after.json().covenants.some((c: { status: string }) => c.status === 'BREACH')).toBe(
      false,
    );
    await app.close();
  });
});

// ─── 3. Reconcile-divergence injection (real Story-8.5 reconcile-and-correct) ─────────────────────
describe('GET/PUT /operator/reconcile-divergence', () => {
  /** Seed an OPEN position + a balanced claim/contra correction-account pair the injection can use. */
  async function seedOpenPositionAndAccounts(): Promise<string> {
    await mkAccount('COIN_ISSUER', 'CLIENT_COLLATERAL', 'EUR', 2);
    await mkAccount('COIN_ISSUER', 'BACKING_FLOAT', 'EUR', 2);
    const pair = await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.08500000',
      leverage: '1',
      collateralPool: 1_000_000n,
      floor: '0.30',
      longLegValue: 500_000n,
      shortLegValue: 500_000n,
      state: 'ACTIVE',
    });
    const position = await createPosition(db, {
      coupledPairId: pair.id,
      owner: 'subscriber-1',
      referenceAsset: 'EUR/USD',
      side: 'LONG',
      sizeUnits: 100_000n,
      entryPrice: '1.08500000',
      collateral: 100_000n,
      leverage: '1',
    });
    return position.id;
  }

  it('GET returns the inactive default toggle state', async () => {
    const app = await buildApp({ db, reconcileInjection: makeFaithfulReconcileInjectionStore() });
    const res = await app.inject({ method: 'GET', url: '/operator/reconcile-divergence' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false, version: 0 });
    await app.close();
  });

  it('cleared (default) ⇒ POST /positions/reconcile reports NO divergence (position stays OPEN)', async () => {
    const positionId = await seedOpenPositionAndAccounts();
    const reconcileInjection = makeFaithfulReconcileInjectionStore();
    const app = await buildApp({ db, positionService: stubPositionService(), reconcileInjection });

    const res = await app.inject({ method: 'POST', url: '/positions/reconcile' });
    expect(res.statusCode).toBe(200);
    expect(res.json().anyMismatch).toBe(false);
    expect((await getPosition(db, positionId))!.lifecycle).toBe('OPEN');
    await app.close();
  });

  it('armed ⇒ POST /positions/reconcile reports-and-corrects a real divergence (journaled, OPEN→CLOSED); then clears', async () => {
    const positionId = await seedOpenPositionAndAccounts();
    const reconcileInjection = makeFaithfulReconcileInjectionStore();
    const app = await buildApp({ db, positionService: stubPositionService(), reconcileInjection });

    // Arm the injection.
    const put = await app.inject({
      method: 'PUT',
      url: '/operator/reconcile-divergence',
      payload: { active: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ active: true, version: 1 });

    // The NEXT reconcile reports the mismatch AND corrects it toward the chain (the real 8.5 path).
    const res = await app.inject({ method: 'POST', url: '/positions/reconcile' });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.anyMismatch).toBe(true);
    expect(report.anyCorrected).toBe(true);
    const mismatch = report.mismatches.find(
      (m: { positionId: string }) => m.positionId === positionId,
    );
    expect(mismatch.corrected).toBe(true);
    expect(mismatch.journalEntryId).not.toBeNull();
    // The position was flipped OPEN→CLOSED by the journaled correction (never a silent change, NFR-3).
    expect((await getPosition(db, positionId))!.lifecycle).toBe('CLOSED');

    // Clear it — a subsequent reconcile injects nothing (and the corrected position is already CLOSED).
    const clear = await app.inject({
      method: 'PUT',
      url: '/operator/reconcile-divergence',
      payload: { active: false },
    });
    expect(clear.json()).toEqual({ active: false, version: 2 });
    const again = await app.inject({ method: 'POST', url: '/positions/reconcile' });
    expect(again.json().anyMismatch).toBe(false);
    await app.close();
  });
});

// ─── Fail-closed: every operator endpoint is a typed 503 when its store is not composed ────────────
describe('operator endpoints are a typed 503 on a non-faithful / read-only deployment', () => {
  it('refuses each endpoint with its specific code when the faithful stores are absent', async () => {
    // Built WITHOUT confirmationSettings / covenantOverride / reconcileInjection (mirrors read-only).
    const app = await buildApp({ db });

    const cases: ReadonlyArray<{
      method: 'GET' | 'PUT';
      url: string;
      code: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'GET', url: '/operator/confirmation', code: 'OPERATOR_CONFIRMATION_UNAVAILABLE' },
      {
        method: 'PUT',
        url: '/operator/confirmation',
        code: 'OPERATOR_CONFIRMATION_UNAVAILABLE',
        payload: { latencyMs: 1000 },
      },
      { method: 'GET', url: '/operator/covenant-breach', code: 'OPERATOR_COVENANT_UNAVAILABLE' },
      {
        method: 'PUT',
        url: '/operator/covenant-breach',
        code: 'OPERATOR_COVENANT_UNAVAILABLE',
        payload: { active: true },
      },
      {
        method: 'GET',
        url: '/operator/reconcile-divergence',
        code: 'OPERATOR_RECONCILE_UNAVAILABLE',
      },
      {
        method: 'PUT',
        url: '/operator/reconcile-divergence',
        code: 'OPERATOR_RECONCILE_UNAVAILABLE',
        payload: { active: true },
      },
    ];

    for (const c of cases) {
      const res =
        c.method === 'GET'
          ? await app.inject({ method: 'GET', url: c.url })
          : await app.inject({ method: 'PUT', url: c.url, payload: c.payload });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(503);
      expect(res.json().error.code, `${c.method} ${c.url}`).toBe(c.code);
    }
    await app.close();
  });
});
