// Story 6.4 — the additive `applyCoupledPairReset` primitive (the strategy executor's persisted
// re-anchor / symmetric re-base). Test-first on its guards: it only runs in the reset window
// (REBALANCING/PARTIAL), it conserves K (V_A + V_B = K), it validates frozen field types, and it
// refuses an absent pair. ADDITIVE — it changes no existing coupled-pair behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type RoseDb } from './db.js';
import { hardReset, migrateUp } from './migrate.js';
import type { CoupledPairState } from './schema/index.js';
import {
  applyCoupledPairReset,
  CoupledPairNotFoundError,
  CoupledPairResetStateError,
  InvalidCoupledPairError,
  createCoupledPair,
  getCoupledPair,
} from './repositories/coupled-pairs.js';

let pool: pg.Pool;
let db: RoseDb;

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
  await pool.query('TRUNCATE coupled_pairs CASCADE');
});

const baseInput = {
  referenceAsset: 'EUR/USD',
  anchorPrice: '1.10000000',
  leverage: '3',
  collateralPool: 1_000_000n,
  floor: '0.5',
  longLegValue: 300_000n,
  shortLegValue: 700_000n,
} as const;

async function seedPairAt(state: CoupledPairState): Promise<string> {
  const created = await createCoupledPair(db, { ...baseInput, state });
  return created.id;
}

describe('applyCoupledPairReset — re-anchor + symmetric re-base (Story 6.4)', () => {
  it('re-anchors P₀ and re-bases the legs to K/2 each from REBALANCING (K conserved, updated_at advanced)', async () => {
    const id = await seedPairAt('REBALANCING');
    const before = (await getCoupledPair(db, id))!;

    const updated = await applyCoupledPairReset(db, {
      pairId: id,
      newAnchorPrice: '1.25000000',
      newLongLegValue: 500_000n,
      newShortLegValue: 500_000n,
    });

    expect(updated.anchorPrice).toBe('1.25000000');
    expect(updated.longLegValue).toBe(500_000n);
    expect(updated.shortLegValue).toBe(500_000n);
    // K (collateral pool) is unchanged; the re-base conserves it.
    expect(updated.longLegValue + updated.shortLegValue).toBe(updated.collateralPool);
    expect(updated.collateralPool).toBe(1_000_000n);
    // State is NOT changed by the reset (the executor drives REBALANCING → ACTIVE separately).
    expect(updated.state).toBe('REBALANCING');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it('also runs from PARTIAL (the mid-rebalance transient)', async () => {
    const id = await seedPairAt('PARTIAL');
    const updated = await applyCoupledPairReset(db, {
      pairId: id,
      newAnchorPrice: '0.90000000',
      newLongLegValue: 400_000n,
      newShortLegValue: 600_000n,
    });
    expect(updated.state).toBe('PARTIAL');
    expect(updated.anchorPrice).toBe('0.90000000');
  });

  it.each(['PENDING', 'ACTIVE', 'SETTLING', 'CLOSED'] as const)(
    'refuses to reset outside the window (state %s ⇒ CoupledPairResetStateError, nothing written)',
    async (state) => {
      const id = await seedPairAt(state);
      await expect(
        applyCoupledPairReset(db, {
          pairId: id,
          newAnchorPrice: '1.20000000',
          newLongLegValue: 500_000n,
          newShortLegValue: 500_000n,
        }),
      ).rejects.toBeInstanceOf(CoupledPairResetStateError);
      // Unchanged.
      const after = (await getCoupledPair(db, id))!;
      expect(after.anchorPrice).toBe('1.10000000');
      expect(after.longLegValue).toBe(300_000n);
    },
  );

  it('rejects a re-base that does not conserve K (V_A + V_B != K ⇒ InvalidCoupledPairError)', async () => {
    const id = await seedPairAt('REBALANCING');
    await expect(
      applyCoupledPairReset(db, {
        pairId: id,
        newAnchorPrice: '1.20000000',
        newLongLegValue: 500_000n,
        newShortLegValue: 499_999n, // sums to 999_999 != K (1_000_000)
      }),
    ).rejects.toBeInstanceOf(InvalidCoupledPairError);
  });

  it('rejects a negative leg value (NFR-2) and an absent pair', async () => {
    const id = await seedPairAt('REBALANCING');
    await expect(
      applyCoupledPairReset(db, {
        pairId: id,
        newAnchorPrice: '1.20000000',
        newLongLegValue: -1n,
        newShortLegValue: 1_000_001n,
      }),
    ).rejects.toBeInstanceOf(InvalidCoupledPairError);

    await expect(
      applyCoupledPairReset(db, {
        pairId: '99999999-9999-4999-8999-999999999999',
        newAnchorPrice: '1.20000000',
        newLongLegValue: 500_000n,
        newShortLegValue: 500_000n,
      }),
    ).rejects.toBeInstanceOf(CoupledPairNotFoundError);
  });
});
