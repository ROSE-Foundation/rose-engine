// Stories 8.3/8.5/8.6 — the PAPER position-service auto-confirm wiring + the seeded §11.4 D1 topology
// proven END-TO-END against the LOCAL Postgres (NO Sepolia, NO network port, NO key). Asserts:
//   • open → the in-process synthetic PairMinted drives the commit point: a GET reads `confirmed` with
//     a real position row OPEN (the POST itself reads `pending` — no optimistic success);
//   • close (whole-package / same owner, no opposing leg) → `confirmed` + the position flips CLOSED;
//   • `seedPaperDemo` leaves the D1 topology in place (owner-A LONG + owner-B SHORT on the same pair),
//     and a single-side close of the LONG is REFUSED LIVE → 409 SOLVENCY_GUARDRAIL_… over HTTP;
//   • `POST /positions/reconcile` returns a per-(pair, side) residual-backing report.
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import { listPositionsByOwner } from '@rose/positions';
import { getAddress } from 'viem';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { makePaperPositionService } from './paper-position-service.js';
import { seedPaperDemo } from './seed-demo.js';

const ALICE = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
// The SHORT counterparty (the seed's second eligible owner — `PAPER_ELIGIBLE_SUBSCRIBER_2`).
const CAROL = getAddress('0xcccccccccccccccccccccccccccccccccccccccc');

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let config: Awaited<ReturnType<typeof seedPaperDemo>>;
let service: ReturnType<typeof makePaperPositionService>;
let app: FastifyInstance;
let demoPairId: string;
let pair2Id: string;

beforeAll(async () => {
  pool = createPool();
  await hardReset(pool);
  await migrateUp(pool);
  db = createDb(pool);

  // The seed wires the accounts/topologies, the demo pair, the initial supply, AND the D1 demo
  // positions (owner-A LONG + owner-B SHORT) — the headline §11.4 topology.
  config = await seedPaperDemo(db);
  const demoPair = await db.query.coupledPairs.findFirst({
    where: (p, { eq }) => eq(p.referenceAsset, 'DEMO/EUR-USD'),
  });
  demoPairId = demoPair!.id;

  // A SECOND ACTIVE pair with NO opposing holder — for the clean (no-guardrail) open/close flow.
  const pair2 = await createCoupledPair(db, {
    referenceAsset: 'DEMO/EUR-USD-2',
    anchorPrice: '1.10000000',
    leverage: '3',
    collateralPool: 1_000_000_000n,
    floor: '0.50',
    longLegValue: 500_000_000n,
    shortLegValue: 500_000_000n,
    state: 'ACTIVE',
  });
  pair2Id = pair2.id;

  service = makePaperPositionService({ db, paperConfig: config });
  app = await buildApp({ db, positionService: service });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('seedPaperDemo — the §11.4 D1 topology is in place', () => {
  it('seeds owner-A LONG + owner-B SHORT on the SAME demo pair (idempotent on re-run)', async () => {
    const aLong = (await listPositionsByOwner(db, { owner: ALICE })).find(
      (p) => p.coupledPairId === demoPairId && p.lifecycle === 'OPEN' && p.side === 'LONG',
    );
    const bShort = (await listPositionsByOwner(db, { owner: CAROL })).find(
      (p) => p.coupledPairId === demoPairId && p.lifecycle === 'OPEN' && p.side === 'SHORT',
    );
    expect(aLong).toBeDefined();
    expect(bShort).toBeDefined();

    // Idempotent: a second seed run opens nothing new (same two OPEN positions remain).
    await seedPaperDemo(db);
    const aLongs = (await listPositionsByOwner(db, { owner: ALICE })).filter(
      (p) => p.coupledPairId === demoPairId && p.lifecycle === 'OPEN' && p.side === 'LONG',
    );
    expect(aLongs).toHaveLength(1);
  });
});

describe('paper position-service — in-process auto-confirm (open → close), no opposing leg', () => {
  const openKey = 'test-open-pair2';
  const closeKey = 'test-close-pair2';
  let positionId: string;

  it('open returns PENDING at the POST, then a GET reads CONFIRMED with a real OPEN position row', async () => {
    const pending = await service.openPosition({
      coupledPairId: pair2Id,
      owner: ALICE,
      side: 'LONG',
      amount: 100_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: openKey,
    });
    expect(pending.status).toBe('pending'); // no optimistic success — the POST reads pending
    expect(pending.txHash).not.toBeNull();

    // The in-process synthetic PairMinted already drove the commit point: a follow-up GET is confirmed.
    const confirmed = await service.getOpenPosition(openKey);
    expect(confirmed).not.toBeNull();
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.position).not.toBeNull();
    expect(confirmed!.position!.lifecycle).toBe('OPEN');
    expect(confirmed!.position!.side).toBe('LONG');
    positionId = confirmed!.position!.id;
  });

  it('close (whole-package, same owner) → CONFIRMED + the position flips CLOSED', async () => {
    const pending = await service.closePosition({
      positionId,
      paymentAsset: config.paymentAsset,
      idempotencyKey: closeKey,
    });
    expect(pending.status).toBe('pending');
    expect(pending.txHash).not.toBeNull();

    const confirmed = await service.getClosePosition(closeKey);
    expect(confirmed).not.toBeNull();
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.position).not.toBeNull();
    expect(confirmed!.position!.lifecycle).toBe('CLOSED');
  });
});

describe('POST /positions/close — the §11.4 single-side guardrail refuses LIVE (Story 8.6 headline)', () => {
  it('refusing the LONG close (opposite SHORT held by owner-B) → 409 SOLVENCY_GUARDRAIL_…, named rule', async () => {
    const aLong = (await listPositionsByOwner(db, { owner: ALICE })).find(
      (p) => p.coupledPairId === demoPairId && p.lifecycle === 'OPEN' && p.side === 'LONG',
    );
    expect(aLong).toBeDefined();
    const res = await app.inject({
      method: 'POST',
      url: '/positions/close',
      payload: {
        positionId: aLong!.id,
        paymentAsset: config.paymentAsset,
        idempotencyKey: 'test-close-d1',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED');
    expect(res.json().error.message).toContain('§11.4 solvency guardrail');

    // Fail-closed BEFORE any burn: the LONG position is still OPEN (no whole-package burn of B's leg).
    const stillOpen = (await listPositionsByOwner(db, { owner: ALICE })).find(
      (p) => p.id === aLong!.id,
    );
    expect(stillOpen!.lifecycle).toBe('OPEN');
  });
});

describe('POST /positions/reconcile — per-(pair, side) residual-backing report (Story 8.5)', () => {
  it('returns a JSON report with a side-backing row per OPEN (pair, side)', async () => {
    const res = await app.inject({ method: 'POST', url: '/positions/reconcile' });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.source).toBe('positions+pairs+chain');
    expect(Array.isArray(report.sideBacking)).toBe(true);
    // The demo pair carries both an OPEN LONG (owner-A) and an OPEN SHORT (owner-B).
    const demoRows = report.sideBacking.filter(
      (r: { coupledPairId: string }) => r.coupledPairId === demoPairId,
    );
    const sides = demoRows.map((r: { side: string }) => r.side).sort();
    expect(sides).toEqual(['LONG', 'SHORT']);
    // Amounts cross as integer strings (NFR-2); 100M exposure < 500M backing ⇒ not over-exposed.
    for (const r of demoRows) {
      expect(typeof r.backing).toBe('string');
      expect(typeof r.exposure).toBe('string');
      expect(r.overExposed).toBe(false);
    }
    expect(report.anyOverExposure).toBe(false);
  });
});
