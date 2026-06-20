// Story 9.4 (FR-31) — the MOCK counterparty/inventory adapter + its faithful composition, proven
// END-TO-END against the LOCAL Postgres (NO Sepolia, NO network, NO key). Asserts:
//   • the adapter UNIT: a single-side close RE-ASSIGNS the closer's side to the house carrying the SAME
//     collateral (per-side claim CONSERVED), journals ONE balanced entry, and burns NOTHING;
//   • faithful composition: a D1 independent single-side close COMPLETES (re-assignment) — closer
//     CLOSED, opposite leg UNTOUCHED, package NOT burned, journaled, Story-8.5 solvency preserved;
//   • PAPER (no adapter): the SAME D1 close stays FAIL-CLOSED (`SolvencyGuardrailError`) — Story 8.6.
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import {
  createPosition,
  getPosition,
  reconcilePositionsToPairs,
  SolvencyGuardrailError,
} from '@rose/positions';
import { getAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeFaithfulConfirmationSettingsStore } from './confirmation-settings.js';
import { FaithfulConfirmationTransport, makeManualScheduler } from './confirmation-transport.js';
import { makeMockCounterpartyAdapter, MOCK_HOUSE_OWNER } from './counterparty-mock.js';
import { makeFaithfulPositionService } from './faithful-mode.js';
import { makeMockKycRegistry } from './kyc-registry.js';
import { makePaperPositionService } from '../paper-position-service.js';
import { seedPaperDemo } from '../seed-demo.js';

const ALICE = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BOB = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const AMOUNT = 25_000n;
const ANCHOR = '1.10000000';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let config: Awaited<ReturnType<typeof seedPaperDemo>>;

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  // Seed the demo accounts + topologies (the source of the EUR claim-transfer account pair).
  config = await seedPaperDemo(db);
});

afterAll(async () => {
  await pool.end();
});

/** A fresh ACTIVE, delta-neutral pair so each test's D1 topology is isolated. */
async function freshD1Pair(referenceAsset: string): Promise<string> {
  const pair = await createCoupledPair(db, {
    referenceAsset,
    anchorPrice: ANCHOR,
    leverage: '1',
    collateralPool: 1_000_000n,
    floor: '0.5',
    longLegValue: 500_000n,
    shortLegValue: 500_000n,
    state: 'ACTIVE',
  });
  return pair.id;
}

/** Seed an OPEN position directly (repo path) to construct a specific L/S topology. */
async function seedPosition(
  pairId: string,
  referenceAsset: string,
  owner: string,
  side: 'LONG' | 'SHORT',
): Promise<string> {
  const view = await createPosition(db, {
    coupledPairId: pairId,
    owner,
    referenceAsset,
    side,
    sizeUnits: AMOUNT,
    entryPrice: ANCHOR,
    collateral: AMOUNT,
    leverage: '1',
  });
  return view.id;
}

async function lifecycleOf(positionId: string): Promise<string> {
  const r = await pool.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM positions WHERE id = $1',
    [positionId],
  );
  return r.rows[0]!.lifecycle;
}

describe('mock counterparty adapter (unit) — re-assign conserves the per-side claim; never burns', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM positions WHERE owner = $1', [MOCK_HOUSE_OWNER]);
  });

  it('flips the closer CLOSED, the house takes over the same side+collateral, and journals it balanced', async () => {
    const ref = 'UNIT/EUR-USD';
    const pairId = await freshD1Pair(ref);
    const aliceLong = await seedPosition(pairId, ref, ALICE, 'LONG');
    const bobShort = await seedPosition(pairId, ref, BOB, 'SHORT');

    const adapter = makeMockCounterpartyAdapter({
      claimTransfer: {
        debitAccountId: config.redemptionTopology.noteLiabilityAccountId,
        creditAccountId: config.redemptionTopology.cashAccountId,
      },
    });

    const before = await reconcilePositionsToPairs(db);
    const longExposureBefore = before.sideBacking.find(
      (r) => r.coupledPairId === pairId && r.side === 'LONG',
    )?.exposure;

    // Load the closer's position view and re-assign it through the adapter (atomic).
    const position = await getPosition(db, aliceLong);
    const outcome = await db.transaction((tx) =>
      adapter.resolveSingleSideClose({
        executor: tx,
        position: position!,
        opposingHolder: { id: bobShort, owner: BOB },
      }),
    );

    expect(outcome.resolution).toBe('reassigned');
    expect(outcome.assignee).toBe(MOCK_HOUSE_OWNER);
    expect(outcome.journalEntryId).toBeTruthy();

    // Closer CLOSED; opposite leg UNTOUCHED.
    expect(await lifecycleOf(aliceLong)).toBe('CLOSED');
    expect(await lifecycleOf(bobShort)).toBe('OPEN');

    // The house OPEN position carries the SAME side + collateral (conserves per-side exposure).
    const house = await pool.query<{ side: string; collateral: string; lifecycle: string }>(
      'SELECT side, collateral, lifecycle FROM positions WHERE owner = $1 AND coupled_pair_id = $2',
      [MOCK_HOUSE_OWNER, pairId],
    );
    expect(house.rows).toHaveLength(1);
    expect(house.rows[0]!.side).toBe('LONG');
    expect(house.rows[0]!.lifecycle).toBe('OPEN');
    expect(house.rows[0]!.collateral).toBe(AMOUNT.toString());

    // Solvency preserved: no over-exposure and the LONG-side exposure is unchanged (Story 8.5).
    const after = await reconcilePositionsToPairs(db);
    expect(after.anyOverExposure).toBe(false);
    const longExposureAfter = after.sideBacking.find(
      (r) => r.coupledPairId === pairId && r.side === 'LONG',
    )?.exposure;
    expect(longExposureAfter).toBe(longExposureBefore);
  });
});

describe('faithful composition — D1 single-side close completes; paper stays fail-closed', () => {
  function transport(): FaithfulConfirmationTransport {
    return new FaithfulConfirmationTransport({
      db,
      scheduler: makeManualScheduler(),
      settings: makeFaithfulConfirmationSettingsStore(),
    });
  }

  it('faithful (adapter composed): the D1 close completes via re-assignment — no burn, journaled', async () => {
    const ref = 'FAITHFUL/EUR-USD';
    const pairId = await freshD1Pair(ref);
    const aliceLong = await seedPosition(pairId, ref, ALICE, 'LONG');
    const bobShort = await seedPosition(pairId, ref, BOB, 'SHORT');

    const service = makeFaithfulPositionService({
      db,
      paperConfig: config,
      transport: transport(),
      kycRegistry: makeMockKycRegistry(config.eligibleSubscribers),
    });

    const view = await service.closePosition({
      positionId: aliceLong,
      paymentAsset: config.paymentAsset,
      idempotencyKey: `close-faithful-d1-${pairId}`,
    });

    // Completed (not refused): confirmed, NO on-chain burn (null txHash), journaled, closer CLOSED.
    expect(view.status).toBe('confirmed');
    expect(view.txHash).toBeNull();
    expect(view.journalEntryId).not.toBeNull();
    expect(view.position?.lifecycle).toBe('CLOSED');
    expect(await lifecycleOf(aliceLong)).toBe('CLOSED');
    // The opposite holder's leg is UNTOUCHED.
    expect(await lifecycleOf(bobShort)).toBe('OPEN');
    // The house took over the LONG side on this pair.
    const house = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM positions WHERE owner = $1 AND coupled_pair_id = $2 AND side = 'LONG' AND lifecycle = 'OPEN'",
      [MOCK_HOUSE_OWNER, pairId],
    );
    expect(house.rows[0]!.n).toBe(1);
  });

  it('paper (no adapter): the SAME D1 close stays fail-closed under the §11.4 guardrail (Story 8.6)', async () => {
    const ref = 'PAPER/EUR-USD';
    const pairId = await freshD1Pair(ref);
    const aliceLong = await seedPosition(pairId, ref, ALICE, 'LONG');
    await seedPosition(pairId, ref, BOB, 'SHORT');

    const paper = makePaperPositionService({ db, paperConfig: config });
    await expect(
      paper.closePosition({
        positionId: aliceLong,
        paymentAsset: config.paymentAsset,
        idempotencyKey: `close-paper-d1-${pairId}`,
      }),
    ).rejects.toBeInstanceOf(SolvencyGuardrailError);
    // Nothing changed — the closer stays OPEN (fail-closed before any write).
    expect(await lifecycleOf(aliceLong)).toBe('OPEN');
  });
});
