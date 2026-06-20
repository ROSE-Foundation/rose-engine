// Paper LIVE replay oracle — proven against the LOCAL Postgres (a seeded pair supplies the anchor).
// Asserts: the price MOVES across the cycle (so directional P&L is live, not flat); every quote is a
// strictly-positive 8-dp decimal string (NFR-2); the observation is stamped fresh (asOf = the injected
// clock); an unknown asset is an explicit no-feed (null); and the resulting mark is a valid OK state
// (the movement stays inside the §15 trust band — never DIVERGENT/STALE).
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import { markToMarket, type MarkablePair } from '@rose/price-oracle';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePaperReplayOracle, PAPER_LIVE_REPLAY_SOURCE } from './paper-replay-oracle.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

const ASSET = 'DEMO/EUR-USD';
const ANCHOR = '1.10000000';

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
  await pool.query('TRUNCATE coupled_pairs CASCADE');
});

async function seedPair(): Promise<void> {
  await createCoupledPair(db, {
    referenceAsset: ASSET,
    anchorPrice: ANCHOR,
    leverage: '3',
    collateralPool: 1_000_000_000n,
    floor: '0.50',
    longLegValue: 500_000_000n,
    shortLegValue: 500_000_000n,
    state: 'ACTIVE',
  });
}

/** A fixed instant injected as the oracle clock (deterministic replay position). */
function at(ms: number): () => Date {
  return () => new Date(ms);
}

const POSITIVE_8DP = /^\d+\.\d{8}$/;

describe('paper live replay oracle', () => {
  it('returns null for an asset with no issued pair (honest no-feed, never fabricated)', async () => {
    const oracle = makePaperReplayOracle(db, { now: at(0) });
    expect(await oracle.getPrice('NOSUCH/ASSET')).toBeNull();
  });

  it('quotes a strictly-positive 8-dp decimal string stamped fresh at the injected clock', async () => {
    await seedPair();
    const nowMs = 1_000_000_000_000;
    const oracle = makePaperReplayOracle(db, { now: at(nowMs) });
    const q = await oracle.getPrice(ASSET);
    expect(q).not.toBeNull();
    expect(q!.referenceAsset).toBe(ASSET);
    expect(q!.source).toBe(PAPER_LIVE_REPLAY_SOURCE);
    expect(q!.price).toMatch(POSITIVE_8DP);
    expect(Number(q!.price)).toBeGreaterThan(0);
    expect(q!.asOf.getTime()).toBe(nowMs); // fresh: stamped with the wall clock, not back-dated
  });

  it('MOVES across the cycle — the price is not flat (so directional P&L is live)', async () => {
    await seedPair();
    // Sample several points across one 2-minute cycle; at least two must differ from the anchor and
    // from each other (a flat anchor-replay would return ANCHOR every time).
    const samples: string[] = [];
    for (let ms = 0; ms < 120_000; ms += 15_000) {
      const oracle = makePaperReplayOracle(db, { now: at(ms) });
      const q = await oracle.getPrice(ASSET);
      samples.push(q!.price);
    }
    const distinct = new Set(samples);
    expect(distinct.size).toBeGreaterThan(1); // it moves
    expect(samples.some((p) => p !== ANCHOR)).toBe(true); // and departs from the flat anchor
  });

  it('stays inside the §15 trust band — every sampled mark is a valid OK state', async () => {
    await seedPair();
    const markable: MarkablePair = {
      referenceAsset: ASSET,
      anchorPrice: ANCHOR,
      leverage: '3',
      collateralPool: 1_000_000_000n,
      floor: '0.50',
    };
    for (let ms = 0; ms < 120_000; ms += 10_000) {
      const oracle = makePaperReplayOracle(db, { now: at(ms) });
      const q = await oracle.getPrice(ASSET);
      const mark = markToMarket(markable, q, {
        freshnessBoundMs: 24 * 60 * 60 * 1000,
        maxRelativeDivergence: '0.5',
        now: new Date(ms),
      });
      expect(mark.status).toBe('OK');
    }
  });
});
