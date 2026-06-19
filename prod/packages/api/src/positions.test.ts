// Story 8.4 — the per-user position P&L endpoint (`GET /positions`) proven IN-PROCESS via Fastify
// `inject` against the LOCAL Postgres (NO Sepolia, NO network port, NO key). The `PriceOracle` is an
// INJECTED FAKE (deterministic quote, NO network). Asserts: the live mark states (OK / NO_FEED /
// STALE / DIVERGENT — never fabricated), the directional P&L sign, money as STRINGS (NFR-2), the
// fail-closed trust 503, the 400 on a missing owner, and that the OpenAPI document types money as strings.
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import { closePosition, createPosition } from '@rose/positions';
import type { PriceOracle, PriceQuote } from '@rose/price-oracle';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type ApiDeps, type MarkTrustInputs } from './app.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

const TRUST: MarkTrustInputs = { freshnessBoundMs: 600_000, maxRelativeDivergence: '0.5' };

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
    'TRUNCATE positions, rose_notes, coupled_pairs, postings, journal_entries CASCADE',
  );
});

/** A fixed-quote read-only oracle (the injected substitutable port — no network). */
function fixedOracle(quote: PriceQuote | null, source = 'test-replay'): PriceOracle {
  return {
    source,
    getPrice: () => Promise.resolve(quote),
  };
}

async function seedPair(opts?: {
  anchorPrice?: string;
  leverage?: string;
  collateralPool?: bigint;
}): Promise<string> {
  const collateralPool = opts?.collateralPool ?? 1_000_000_000n;
  const half = collateralPool / 2n;
  const pair = await createCoupledPair(db, {
    referenceAsset: 'EUR/USD',
    anchorPrice: opts?.anchorPrice ?? '1.10000000',
    leverage: opts?.leverage ?? '3',
    collateralPool,
    floor: '0.50',
    longLegValue: half,
    shortLegValue: half,
  });
  return pair.id;
}

async function seedPosition(
  pairId: string,
  side: 'LONG' | 'SHORT',
  owner = 'owner-1',
  sizeUnits = 1_000_000_000n,
): Promise<string> {
  const p = await createPosition(db, {
    coupledPairId: pairId,
    owner,
    referenceAsset: 'EUR/USD',
    side,
    sizeUnits,
    entryPrice: '1.10000000',
    collateral: sizeUnits,
    leverage: '1',
  });
  return p.id;
}

async function appWith(extra?: Partial<ApiDeps>): Promise<FastifyInstance> {
  return buildApp({ db, ...extra });
}

describe('GET /positions — money is strings, validated by Zod (AC #1)', () => {
  it('requires an owner query (400 on absent)', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/positions' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('returns the owner + an empty positions array when the owner holds nothing', async () => {
    const app = await appWith({ priceOracle: fixedOracle(null), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=nobody' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: 'nobody', positions: [] });
    await app.close();
  });

  it('isolates by owner — a listing never leaks another owner’s positions', async () => {
    const eur = await seedPair();
    await seedPosition(eur, 'LONG', 'owner-1');
    await seedPosition(eur, 'SHORT', 'owner-1');
    await seedPosition(eur, 'LONG', 'other-owner');
    const app = await appWith({ priceOracle: fixedOracle(null), markTrust: TRUST });
    const mine = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(mine.json().positions).toHaveLength(2);
    expect(mine.json().positions.every((p: { owner: string }) => p.owner === 'owner-1')).toBe(true);
    await app.close();
  });

  it('surfaces every monetary value as a STRING (no JS number / no bigint in the payload)', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const quote: PriceQuote = {
      referenceAsset: 'EUR/USD',
      price: '1.155',
      asOf: new Date(),
      source: 'test-replay',
    };
    const app = await appWith({ priceOracle: fixedOracle(quote), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.statusCode).toBe(200);
    const pos = res.json().positions[0];
    for (const field of ['sizeUnits', 'collateral', 'realizedPnl', 'entryPrice', 'leverage']) {
      expect(typeof pos[field]).toBe('string');
    }
    expect(typeof pos.mark.unrealizedPnl).toBe('string');
    expect(typeof pos.mark.markPrice).toBe('string');
    // No `bigint` literal artifact; the raw payload round-trips as plain JSON.
    expect(() => JSON.parse(res.payload)).not.toThrow();
    await app.close();
  });
});

describe('GET /positions — live mark states, never fabricated (AC #2)', () => {
  it('OK: a LONG gains and the SHORT mirror loses when the price rises (delta-neutral)', async () => {
    const pairId = await seedPair(); // anchor 1.10, L=3, K=1e9
    await seedPosition(pairId, 'LONG', 'owner-1');
    await seedPosition(pairId, 'SHORT', 'owner-1');
    const quote: PriceQuote = {
      referenceAsset: 'EUR/USD',
      price: '1.155', // +5% ⇒ L·r = 0.15 ⇒ legs 575M / 425M
      asOf: new Date(),
      source: 'test-replay',
    };
    const app = await appWith({ priceOracle: fixedOracle(quote), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.statusCode).toBe(200);
    const positions: Array<{
      side: string;
      mark: { status: string; unrealizedPnl: string | null; markPrice: string | null };
    }> = res.json().positions;
    const long = positions.find((p) => p.side === 'LONG')!;
    const short = positions.find((p) => p.side === 'SHORT')!;
    expect(long.mark.status).toBe('OK');
    expect(long.mark.markPrice).toBe('1.155');
    expect(long.mark.unrealizedPnl).toBe('75000000');
    expect(short.mark.unrealizedPnl).toBe('-75000000'); // the mirror leg's loss is negative (signed)
    // Delta-neutral: the two legs' P&L sum to 0.
    expect(BigInt(long.mark.unrealizedPnl!) + BigInt(short.mark.unrealizedPnl!)).toBe(0n);
    await app.close();
  });

  it('NO_FEED: with NO oracle composed, every mark is the explicit no-price-feed state', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const app = await appWith(); // no priceOracle
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.statusCode).toBe(200);
    const mark = res.json().positions[0].mark;
    expect(mark.status).toBe('NO_FEED');
    expect(mark.markPrice).toBeNull();
    expect(mark.unrealizedPnl).toBeNull(); // never a fabricated P&L
    expect(mark.freshnessBoundMs).toBeNull();
    await app.close();
  });

  it('NO_FEED: an oracle that has no quote for the asset yields no-price-feed (not fabricated)', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const app = await appWith({ priceOracle: fixedOracle(null), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.json().positions[0].mark.status).toBe('NO_FEED');
    await app.close();
  });

  it('STALE: an old quote surfaces the price but never a trusted P&L', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const quote: PriceQuote = {
      referenceAsset: 'EUR/USD',
      price: '1.155',
      asOf: new Date(Date.now() - 10_000),
      source: 'test-replay',
    };
    const app = await appWith({
      priceOracle: fixedOracle(quote),
      markTrust: { freshnessBoundMs: 1_000, maxRelativeDivergence: '0.5' },
    });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    const mark = res.json().positions[0].mark;
    expect(mark.status).toBe('STALE');
    expect(mark.markPrice).toBe('1.155'); // surfaced for transparency…
    expect(mark.unrealizedPnl).toBeNull(); // …but never trusted
    await app.close();
  });

  it('a contract-violating feed figure never crashes the response — markPrice is nulled, flagged', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const quote: PriceQuote = {
      referenceAsset: 'EUR/USD',
      price: 'not-a-number', // a non-decimal feed figure (INVALID_PRICE)
      asOf: new Date(),
      source: 'test-replay',
    };
    const app = await appWith({ priceOracle: fixedOracle(quote), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.statusCode).toBe(200); // NOT a 500 — the bad feed is handled, never crashes
    const mark = res.json().positions[0].mark;
    expect(mark.markPrice).toBeNull(); // the invalid figure is not surfaced as a price…
    expect(mark.unrealizedPnl).toBeNull(); // …and never a trusted P&L
    expect(mark.flags).toContain('INVALID_PRICE');
    await app.close();
  });

  it('DIVERGENT: an implausibly divergent figure is flagged, not trusted', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const quote: PriceQuote = {
      referenceAsset: 'EUR/USD',
      price: '2.20', // 2× anchor ⇒ |r| = 1.0 > 0.5
      asOf: new Date(),
      source: 'test-replay',
    };
    const app = await appWith({ priceOracle: fixedOracle(quote), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    const mark = res.json().positions[0].mark;
    expect(mark.status).toBe('DIVERGENT');
    expect(mark.unrealizedPnl).toBeNull();
    await app.close();
  });

  it('surfaces a CLOSED position (lifecycle CLOSED) with a mark', async () => {
    const pairId = await seedPair();
    const id = await seedPosition(pairId, 'LONG');
    await closePosition(db, id);
    const app = await appWith({ priceOracle: fixedOracle(null), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.json().positions[0].lifecycle).toBe('CLOSED');
    await app.close();
  });
});

describe('GET /positions — fail-closed trust + NFR-2 precision (AC #1)', () => {
  it('503 when an oracle is configured but the trust inputs are not (never silently default)', async () => {
    const pairId = await seedPair();
    await seedPosition(pairId, 'LONG');
    const app = await appWith({ priceOracle: fixedOracle(null) }); // no markTrust
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('POSITION_MARK_TRUST_UNAVAILABLE');
    await app.close();
  });

  it('preserves a > 2^53 P&L magnitude exactly as a string through the serialize path', async () => {
    // K = 2e16 ⇒ legs 1e16 each ⇒ +5% (L·r=0.15) ⇒ long leg 1.15e16 ⇒ P&L = 1.5e15 (> 2^53).
    const pairId = await seedPair({ collateralPool: 20_000_000_000_000_000n });
    await seedPosition(pairId, 'LONG', 'owner-1', 20_000_000_000_000_000n);
    const quote: PriceQuote = {
      referenceAsset: 'EUR/USD',
      price: '1.155',
      asOf: new Date(),
      source: 'test-replay',
    };
    const app = await appWith({ priceOracle: fixedOracle(quote), markTrust: TRUST });
    const res = await app.inject({ method: 'GET', url: '/positions?owner=owner-1' });
    // 1.5e15 exactly — a JS number would have lost precision past 2^53.
    expect(res.json().positions[0].mark.unrealizedPnl).toBe('1500000000000000');
    await app.close();
  });
});

describe('GET /positions — OpenAPI derivation (AC #1)', () => {
  it('lists the /positions path and types the money fields as string', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.paths['/positions']).toBeDefined();
    const schema = doc.paths['/positions'].get.responses['200'].content['application/json'].schema;
    // The positions array items carry string money fields (derived from the Zod schemas).
    const props = schema.properties.positions.items.properties;
    expect(props.sizeUnits.type).toBe('string');
    expect(props.realizedPnl.type).toBe('string');
    expect(props.entryPrice.type).toBe('string');
    // The mark sub-schema is derived too (the directional P&L is present, never a JS number).
    expect(props.mark.properties.unrealizedPnl).toBeDefined();
    await app.close();
  });
});
