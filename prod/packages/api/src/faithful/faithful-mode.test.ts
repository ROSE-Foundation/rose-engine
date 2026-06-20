// Story 9.1 (AC1, AC2) — the FAITHFUL async-confirmation transport + composition proven END-TO-END
// against the LOCAL Postgres (NO Sepolia, NO network port, NO key), with the scheduler driven
// DETERMINISTICALLY by a manual scheduler (no real waiting). Asserts:
//   • a submitted flow reads `pending` BEFORE the scheduled delay and `confirmed` AFTER — the same
//     saga commit point as Epic 5/paper, only time-shifted (no optimistic success);
//   • a failure-injected flow COMPENSATES: the flow ends `failed`, the outbox row is COMPENSATED, and
//     there is NO half-applied state — no orphaned position, no journal entry posted (whole-or-nothing);
//   • `ENGINE_MODE=paper` is UNCHANGED — the paper services still confirm INSTANTLY (no scheduler).
import {
  createCoupledPair,
  createDb,
  createPool,
  findByIdempotencyKey,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import { listPositionsByOwner } from '@rose/positions';
import { makePaperModeServices } from '@rose/rose-note';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFaithfulConfirmationSettingsStore } from './confirmation-settings.js';
import {
  FaithfulConfirmationTransport,
  makeManualScheduler,
  type ManualScheduler,
} from './confirmation-transport.js';
import { makeFaithfulModeServices, makeFaithfulPositionService } from './faithful-mode.js';
import { seedPaperDemo } from '../seed-demo.js';

const ALICE = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CAROL = getAddress('0xcccccccccccccccccccccccccccccccccccccccc');

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let config: Awaited<ReturnType<typeof seedPaperDemo>>;
let scheduler: ManualScheduler;
let settings: ReturnType<typeof makeFaithfulConfirmationSettingsStore>;
let transport: FaithfulConfirmationTransport;
let services: ReturnType<typeof makeFaithfulModeServices>;
let positions: ReturnType<typeof makeFaithfulPositionService>;
let demoNoteId: string;
// Fresh ACTIVE pairs (no opposing holder) for the position flows — isolated from the seeded D1 topology.
let openPairId: string;
let failPairId: string;
let closeFailPairId: string;

/** Count journal entries linked to a coupled pair (the "no half-applied state" backstop). */
async function entryCount(pairId: string): Promise<number> {
  const rows = await db.query.journalEntries.findMany({
    where: (je, { eq }) => eq(je.coupledPairId, pairId),
  });
  return rows.length;
}

async function freshActivePair(referenceAsset: string): Promise<string> {
  const pair = await createCoupledPair(db, {
    referenceAsset,
    anchorPrice: '1.10000000',
    leverage: '3',
    collateralPool: 1_000_000_000n,
    floor: '0.50',
    longLegValue: 500_000_000n,
    shortLegValue: 500_000_000n,
    state: 'ACTIVE',
  });
  return pair.id;
}

beforeAll(async () => {
  pool = createPool();
  await hardReset(pool);
  await migrateUp(pool);
  db = createDb(pool);

  config = await seedPaperDemo(db);
  const demoPair = await db.query.coupledPairs.findFirst({
    where: (p, { eq }) => eq(p.referenceAsset, 'DEMO/EUR-USD'),
  });
  const note = await db.query.roseNotes.findFirst({
    where: (n, { eq }) => eq(n.coupledPairId, demoPair!.id),
  });
  demoNoteId = note!.id;

  openPairId = await freshActivePair('FAITHFUL/OPEN-CLOSE');
  failPairId = await freshActivePair('FAITHFUL/FAIL');
  closeFailPairId = await freshActivePair('FAITHFUL/CLOSE-FAIL');

  scheduler = makeManualScheduler();
  settings = makeFaithfulConfirmationSettingsStore();
  transport = new FaithfulConfirmationTransport({ db, scheduler, settings });
  services = makeFaithfulModeServices({ db, ...config }, transport);
  positions = makeFaithfulPositionService({ db, paperConfig: config, transport });
});

afterAll(async () => {
  await pool?.end();
});

describe('faithful subscribe — delayed commit point (AC1)', () => {
  it('stays PENDING until the scheduled delay, then flips CONFIRMED (no optimistic success)', async () => {
    const key = 'faithful-sub-confirm';
    const view = await services.subscriptions.subscribe({
      roseNoteId: demoNoteId,
      subscriber: ALICE,
      amount: 1_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: key,
    });
    expect(view.status).toBe('pending');
    expect(view.txHash).not.toBeNull();
    // The commit point is DEFERRED — a task is queued, not run; a GET reads `pending` during the window.
    expect(scheduler.pending).toBe(1);
    const during = await services.subscriptions.getSubscription(key);
    expect(during!.status).toBe('pending');
    expect(during!.journalEntryId).toBeNull();

    // Drive the scheduler — the delayed commit point fires (the SAME confirm path Epic 5 proves).
    await scheduler.runAll();
    const after = await services.subscriptions.getSubscription(key);
    expect(after!.status).toBe('confirmed');
    expect(after!.journalEntryId).not.toBeNull();
  });
});

describe('faithful subscribe — injected failure compensates (AC2)', () => {
  it('ends FAILED with the outbox COMPENSATED and NO journal entry posted (whole-or-nothing)', async () => {
    settings.set({ failNext: true });
    const key = 'faithful-sub-fail';
    const view = await services.subscriptions.subscribe({
      roseNoteId: demoNoteId,
      subscriber: ALICE,
      amount: 1_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: key,
    });
    expect(view.status).toBe('pending');

    await scheduler.runAll();

    // The flow ends FAILED, observably.
    const after = await services.subscriptions.getSubscription(key);
    expect(after!.status).toBe('failed');
    expect(after!.journalEntryId).toBeNull();

    // The saga compensated: SUBMITTED → FAILED → COMPENSATED, with no ledger effect ever applied.
    const row = await findByIdempotencyKey(db, key);
    expect(row!.status).toBe('COMPENSATED');
    expect(row!.journalEntryId).toBeNull();
  });
});

describe('faithful position open/close — delayed commit point (AC1)', () => {
  const openKey = 'faithful-open-confirm';
  const closeKey = 'faithful-close-confirm';
  let positionId: string;

  it('open stays PENDING then flips CONFIRMED with a real OPEN position row', async () => {
    const view = await positions.openPosition({
      coupledPairId: openPairId,
      owner: ALICE,
      side: 'LONG',
      amount: 100_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: openKey,
    });
    expect(view.status).toBe('pending');
    expect(view.position).toBeNull(); // no optimistic position before the commit point

    const during = await positions.getOpenPosition(openKey);
    expect(during!.status).toBe('pending');

    await scheduler.runAll();
    const after = await positions.getOpenPosition(openKey);
    expect(after!.status).toBe('confirmed');
    expect(after!.position).not.toBeNull();
    expect(after!.position!.lifecycle).toBe('OPEN');
    positionId = after!.position!.id;
  });

  it('close (whole-package) stays PENDING then flips CONFIRMED with the position CLOSED', async () => {
    const view = await positions.closePosition({
      positionId,
      paymentAsset: config.paymentAsset,
      idempotencyKey: closeKey,
    });
    expect(view.status).toBe('pending');

    const during = await positions.getClosePosition(closeKey);
    expect(during!.status).toBe('pending');
    expect(during!.position!.lifecycle).toBe('OPEN'); // still OPEN during the window

    await scheduler.runAll();
    const after = await positions.getClosePosition(closeKey);
    expect(after!.status).toBe('confirmed');
    expect(after!.position!.lifecycle).toBe('CLOSED');
  });
});

describe('faithful position open — injected failure compensates, NO orphaned position (AC2)', () => {
  it('ends FAILED, the outbox is COMPENSATED, and NO position / NO journal entry is created', async () => {
    const before = await entryCount(failPairId);
    expect(before).toBe(0); // a fresh pair has no entries

    settings.set({ failNext: true });
    const key = 'faithful-open-fail';
    const view = await positions.openPosition({
      coupledPairId: failPairId,
      owner: CAROL,
      side: 'LONG',
      amount: 100_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: key,
    });
    expect(view.status).toBe('pending');

    await scheduler.runAll();

    const after = await positions.getOpenPosition(key);
    expect(after!.status).toBe('failed');
    expect(after!.position).toBeNull();

    const row = await findByIdempotencyKey(db, key);
    expect(row!.status).toBe('COMPENSATED');

    // No half-applied state: no OPEN position for the owner on the pair, no journal entry posted.
    const open = (await listPositionsByOwner(db, { owner: CAROL })).filter(
      (p) => p.coupledPairId === failPairId,
    );
    expect(open).toHaveLength(0);
    expect(await entryCount(failPairId)).toBe(0);
  });
});

describe('faithful position close — injected failure compensates, position stays OPEN (AC2, burn path)', () => {
  it('a confirmed OPEN then a failure-injected close ends FAILED with the position STILL OPEN', async () => {
    // 1. Open + confirm a clean position on an isolated pair (no opposing holder).
    const openKey = 'faithful-closefail-open';
    await positions.openPosition({
      coupledPairId: closeFailPairId,
      owner: ALICE,
      side: 'LONG',
      amount: 100_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: openKey,
    });
    await scheduler.runAll();
    const opened = await positions.getOpenPosition(openKey);
    expect(opened!.status).toBe('confirmed');
    const positionId = opened!.position!.id;
    const entriesAfterOpen = await entryCount(closeFailPairId);

    // 2. Inject a failure on the close: the burn outbox compensates, the position is NOT flipped.
    settings.set({ failNext: true });
    const closeKey = 'faithful-closefail-close';
    const view = await positions.closePosition({
      positionId,
      paymentAsset: config.paymentAsset,
      idempotencyKey: closeKey,
    });
    expect(view.status).toBe('pending');

    await scheduler.runAll();

    const after = await positions.getClosePosition(closeKey);
    expect(after!.status).toBe('failed');
    expect(after!.position!.lifecycle).toBe('OPEN'); // whole-or-nothing: never flipped to CLOSED

    const row = await findByIdempotencyKey(db, closeKey);
    expect(row!.status).toBe('COMPENSATED');
    // No burn entry posted: the commit point never ran (entry count unchanged since the open).
    expect(await entryCount(closeFailPairId)).toBe(entriesAfterOpen);
  });
});

describe('failureRate — a 100% rate fails every flow (AC2)', () => {
  it('compensates when failureRate is 1 (no failNext needed)', async () => {
    settings.reset();
    settings.set({ failureRate: 1 });
    const key = 'faithful-sub-rate-fail';
    await services.subscriptions.subscribe({
      roseNoteId: demoNoteId,
      subscriber: ALICE,
      amount: 1_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: key,
    });
    await scheduler.runAll();
    const row = await findByIdempotencyKey(db, key);
    expect(row!.status).toBe('COMPENSATED');
    settings.reset();
  });
});

describe('ENGINE_MODE=paper is UNCHANGED — instant in-process auto-confirm (regression)', () => {
  it('paper subscribe confirms INSTANTLY without any scheduler (no delayed commit point)', async () => {
    const paper = makePaperModeServices({ db, ...config });
    const key = 'paper-regression-sub';
    const view = await paper.subscriptions.subscribe({
      roseNoteId: demoNoteId,
      subscriber: ALICE,
      amount: 1_000_000n,
      paymentAsset: config.paymentAsset,
      idempotencyKey: key,
    });
    // The POST itself reads pending (lifecycle stays observable), but the commit point ALREADY fired
    // in-process — a follow-up GET is CONFIRMED with NO scheduler involved (paper is unchanged).
    expect(view.status).toBe('pending');
    const after = await paper.subscriptions.getSubscription(key);
    expect(after!.status).toBe('confirmed');
    expect(after!.journalEntryId).not.toBeNull();
  });
});
