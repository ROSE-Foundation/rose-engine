// PAPER-MODE end-to-end (infrastructure, NOT a BMAD story). Proves the shared live environment's
// write flows run FULLY in-process — subscribe / redeem / strategy reset move `pending → confirmed`
// with a balanced ledger entry — via Fastify `inject` over the SAME composition `serve.ts` wires when
// `ENGINE_MODE=paper`: `seedPaperDemo` + `makePaperModeServices` (the `@rose/rose-note` paper layer on
// the `@rose/chain` paper transport), against the LOCAL Postgres. NO Sepolia, NO RPC, NO secret.
//
// Also proves the security boundary: WITHOUT paper mode (no write services composed, no chain config)
// the write routes still return the typed 503 — paper mode is never silent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, createPool, hardReset, migrateUp, type RoseDb } from '@rose/ledger';
import { makePaperModeServices, type PaperModeConfig } from '@rose/rose-note';
import { buildApp } from './app.js';
import { seedPaperDemo } from './seed-demo.js';

const ELIGIBLE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // PAPER_ELIGIBLE_SUBSCRIBER
const INELIGIBLE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let app: FastifyInstance;
let noteId: string;
let pairId: string;
let paperConfig: Omit<PaperModeConfig, 'db'>;

/** Signed balance (DEBIT − CREDIT) for an account across all postings. */
async function balanceOf(accountId: string): Promise<bigint> {
  const r = await pool.query<{ bal: string }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS bal
       FROM postings WHERE account_id = $1`,
    [accountId],
  );
  return BigInt(r.rows[0]!.bal);
}

/** Count journal entries stamped with a given tx hash (each commit point stamps exactly one). */
async function entriesForTx(txHash: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM journal_entries WHERE tx_hash = $1',
    [txHash],
  );
  return r.rows[0]!.n;
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);

  paperConfig = await seedPaperDemo(db);
  const paper = makePaperModeServices({ db, ...paperConfig });
  app = await buildApp({
    db,
    subscriptions: paper.subscriptions,
    redemptions: paper.redemptions,
    strategy: paper.strategy,
  });

  const note = await db.query.roseNotes.findFirst();
  noteId = note!.id;
  pairId = note!.coupledPairId;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('subscription — POST pending → auto-confirm → GET confirmed with a balanced entry (NFR-9)', () => {
  it('POST returns 201 pending (no optimistic success); GET reads confirmed with a journal entry', async () => {
    const noteLiabBefore = await balanceOf(paperConfig.subscriptionTopology.noteLiabilityAccountId);

    const post = await app.inject({
      method: 'POST',
      url: `/rose-notes/${noteId}/subscriptions`,
      payload: {
        subscriber: ELIGIBLE,
        amount: '10000',
        paymentAsset: 'EUR',
        idempotencyKey: 'e2e-sub-1',
      },
    });
    expect(post.statusCode).toBe(201);
    const posted = post.json();
    expect(posted.status).toBe('pending'); // lifecycle stays observable (auto-confirm runs in-process)
    expect(posted.journalEntryId).toBeNull();
    expect(typeof posted.txHash).toBe('string');

    const get = await app.inject({ method: 'GET', url: '/subscriptions/e2e-sub-1' });
    expect(get.statusCode).toBe(200);
    const confirmed = get.json();
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.journalEntryId).not.toBeNull();

    // A single balanced commit-point entry exists, stamped with the subscription's tx hash (NFR-9/3).
    expect(await entriesForTx(posted.txHash)).toBe(1);
    // The EUR NOTE_LIABILITY was CREDITed the subscription amount (the issued-note obligation).
    const noteLiabAfter = await balanceOf(paperConfig.subscriptionTopology.noteLiabilityAccountId);
    expect(noteLiabAfter - noteLiabBefore).toBe(-10_000n); // credit-normal ⇒ moves negative
  });

  it('an ineligible subscriber is refused 403 (FR-19) and nothing is written', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/rose-notes/${noteId}/subscriptions`,
      payload: {
        subscriber: INELIGIBLE,
        amount: '10000',
        paymentAsset: 'EUR',
        idempotencyKey: 'e2e-sub-bad',
      },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe('SUBSCRIBER_NOT_ELIGIBLE');
    const get = await app.inject({ method: 'GET', url: '/subscriptions/e2e-sub-bad' });
    expect(get.statusCode).toBe(404); // no row recorded
  });
});

describe('redemption — POST pending → auto-confirm → GET confirmed; NOTE_LIABILITY extinguished', () => {
  it('redeems and extinguishes the issued-note obligation by the redeemed amount', async () => {
    const noteLiabBefore = await balanceOf(paperConfig.redemptionTopology.noteLiabilityAccountId);

    const post = await app.inject({
      method: 'POST',
      url: `/rose-notes/${noteId}/redemptions`,
      payload: {
        redeemer: ELIGIBLE,
        amount: '4000',
        paymentAsset: 'EUR',
        idempotencyKey: 'e2e-red-1',
      },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().status).toBe('pending');

    const get = await app.inject({ method: 'GET', url: '/redemptions/e2e-red-1' });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe('confirmed');
    expect(get.json().journalEntryId).not.toBeNull();

    expect(await entriesForTx(post.json().txHash)).toBe(1);
    // NOTE_LIABILITY is DEBITed back toward zero by the redeemed amount (the inverse of a subscription).
    const noteLiabAfter = await balanceOf(paperConfig.redemptionTopology.noteLiabilityAccountId);
    expect(noteLiabAfter - noteLiabBefore).toBe(4_000n);
  });
});

describe('strategy — POST breach tick starts a reset → auto-confirm → GET confirmed (P&L → TRADING_CO)', () => {
  it('a floor breach drives a reset that confirms in-process and crystallizes P&L', async () => {
    const incomeBefore = await balanceOf(paperConfig.strategyTopology.tradingPnlIncomeAccountId);

    // Demo pair: K=1e9, K/2=5e8, leverage 3, m·L·g = 0.5·3·0.4 = 0.6 ⇒ floorUnits = 3e8.
    // longLegMarkValue 1e8 is ≤ 3e8 and < 5e8 ⇒ a long-leg breach; resetDelta = 5e8 − 1e8 = 4e8.
    const post = await app.inject({
      method: 'POST',
      url: `/coupled-pairs/${pairId}/strategy/ticks`,
      payload: {
        price: '1.20000000',
        longLegMarkValue: '100000000',
        shortLegMarkValue: '600000000',
        paymentAsset: 'EUR',
        resetIdempotencyKey: 'e2e-reset-1',
      },
    });
    expect(post.statusCode).toBe(200);
    const outcome = post.json();
    expect(outcome.action).toBe('reset-started');
    expect(outcome.losingLeg).toBe('long');

    const get = await app.inject({ method: 'GET', url: '/strategy/resets/e2e-reset-1' });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe('confirmed');
    expect(get.json().journalEntryId).not.toBeNull();

    expect(await entriesForTx(outcome.txHash)).toBe(1);
    // The realized P&L (resetDelta = 4e8) accrues to TRADING_CO FEE_INCOME (credit-normal EQUITY).
    const incomeAfter = await balanceOf(paperConfig.strategyTopology.tradingPnlIncomeAccountId);
    expect(incomeAfter - incomeBefore).toBe(-400_000_000n);
  });
});

describe('security — WITHOUT paper mode (no write services composed) the write routes are 503', () => {
  it('subscribe / redeem / tick all refuse with the typed 503 (no silent paper)', async () => {
    const readOnly = await buildApp({ db });
    try {
      const sub = await readOnly.inject({
        method: 'POST',
        url: `/rose-notes/${noteId}/subscriptions`,
        payload: {
          subscriber: ELIGIBLE,
          amount: '10000',
          paymentAsset: 'EUR',
          idempotencyKey: 'x',
        },
      });
      expect(sub.statusCode).toBe(503);
      expect(sub.json().error.code).toBe('SUBSCRIPTION_SERVICE_UNAVAILABLE');

      const red = await readOnly.inject({
        method: 'POST',
        url: `/rose-notes/${noteId}/redemptions`,
        payload: { redeemer: ELIGIBLE, amount: '1000', paymentAsset: 'EUR', idempotencyKey: 'y' },
      });
      expect(red.statusCode).toBe(503);

      const tick = await readOnly.inject({
        method: 'POST',
        url: `/coupled-pairs/${pairId}/strategy/ticks`,
        payload: {
          price: '1.20000000',
          longLegMarkValue: '1',
          shortLegMarkValue: '1',
          paymentAsset: 'EUR',
          resetIdempotencyKey: 'z',
        },
      });
      expect(tick.statusCode).toBe(503);
    } finally {
      await readOnly.close();
    }
  });
});
