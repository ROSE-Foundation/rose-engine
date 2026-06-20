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
import { DEFAULT_SIMULATION_SETTINGS, type SimulationFeedMode } from './simulation-settings.js';

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

/** Feed params for a given mode (version 1 so the oracle builds a fresh series). */
function feed(mode: SimulationFeedMode): () => {
  amplitude: number;
  periodSeconds: number;
  mode: SimulationFeedMode;
  dcThreshold: number;
  version: number;
} {
  return () => ({ ...DEFAULT_SIMULATION_SETTINGS, mode, version: 1 });
}

/** Sample the feed across one full cycle at fixed instants (deterministic replay positions). */
async function sampleCycle(mode: SimulationFeedMode, stepMs = 10_000): Promise<string[]> {
  const out: string[] = [];
  for (let ms = 0; ms < 120_000; ms += stepMs) {
    const oracle = makePaperReplayOracle(db, { now: at(ms), settings: feed(mode) });
    const q = await oracle.getPrice(ASSET);
    out.push(q!.price);
  }
  return out;
}

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

  describe('directional-change feed mode', () => {
    it('MOVES across the cycle and is NOT the pure sine path (intrinsic-time, not clock-based)', async () => {
      await seedPair();
      const dc = await sampleCycle('directional-change');
      const sine = await sampleCycle('sine');
      // It moves (more than one distinct value)…
      expect(new Set(dc).size).toBeGreaterThan(1);
      // …and the DC path differs from the sine path for the same amplitude/period (a different shape).
      expect(dc).not.toEqual(sine);
    });

    it('every DC-mode quote is a strictly-positive 8-dp string stamped fresh, unknown ⇒ null', async () => {
      await seedPair();
      const oracle = makePaperReplayOracle(db, {
        now: at(42_000),
        settings: feed('directional-change'),
      });
      const q = await oracle.getPrice(ASSET);
      expect(q!.price).toMatch(POSITIVE_8DP);
      expect(Number(q!.price)).toBeGreaterThan(0);
      expect(q!.asOf.getTime()).toBe(42_000);
      // Unknown asset is still an honest no-feed in DC mode.
      expect(await oracle.getPrice('NOSUCH/ASSET')).toBeNull();
    });

    it('stays inside the §15 trust band — every DC-mode mark is a valid OK state', async () => {
      await seedPair();
      const markable: MarkablePair = {
        referenceAsset: ASSET,
        anchorPrice: ANCHOR,
        leverage: '3',
        collateralPool: 1_000_000_000n,
        floor: '0.50',
      };
      for (let ms = 0; ms < 120_000; ms += 10_000) {
        const oracle = makePaperReplayOracle(db, {
          now: at(ms),
          settings: feed('directional-change'),
        });
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
});
