// Story 8.5 — position ↔ pair reconciliation (FR-27 / NFR-3 / NFR-9), proven against the LIVE
// Postgres with SYNTHETIC injected chain facts (NO Sepolia, NO RPC, NO key). Test-first on the
// invariants (NFR-6):
//   • AC-1: per-(pair, side) residual-backing — exposure measured PER pair AND PER side;
//   • AC-2: a deliberate over-exposure on one pair/side is REPORTED and NOT masked by headroom on
//           another pair or side (multi-pair, both-sides fixture);
//   • AC-3: a deliberate position↔pair mismatch (chain reports the pair closed/gone) is REPORTED and
//           CORRECTED toward the chain with a JOURNALED, surfaced, balanced void + OPEN→CLOSED flip —
//           never a silent liquidation; an uncorrectable mismatch is reported (strict ⇒ rollback);
//           the pass is idempotent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import { createPosition, getPosition } from './repositories/positions.js';
import {
  InvalidPositionCorrectionAccountsError,
  reconcilePositionsToPairs,
  serializePositionReconciliationReport,
  UnreconciledPositionMismatchError,
  type PositionClaimCorrectionAccounts,
  type SideBackingRow,
} from './reconcile.js';

let pool: pg.Pool;
let db: RoseDb;
const NOW = new Date('2026-06-19T00:00:00.000Z');

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
    'TRUNCATE positions, coupled_pairs, accounts, journal_entries, postings CASCADE',
  );
});

async function entityId(code: string): Promise<string> {
  const r = await pool.query<{ id: string }>('SELECT id FROM entities WHERE code = $1', [code]);
  return r.rows[0]!.id;
}

/** Inserts an account and returns its id (mirrors 5.6's `mkAccount`). */
async function mkAccount(type: string, asset: string, scale: number): Promise<string> {
  const eid = await entityId('COIN_ISSUER');
  const r = await pool.query<{ id: string }>(
    'INSERT INTO accounts (entity_id, type, asset, decimal_scale) VALUES ($1,$2,$3,$4) RETURNING id',
    [eid, type, asset, scale],
  );
  return r.rows[0]!.id;
}

/** Seeds an ACTIVE coupled pair with explicit per-side residual leg values. */
async function seedPair(opts: {
  referenceAsset?: string;
  longLeg: bigint;
  shortLeg: bigint;
}): Promise<string> {
  const ref = opts.referenceAsset ?? 'EUR/USD';
  const created = await createCoupledPair(db, {
    referenceAsset: ref,
    anchorPrice: '1.08500000',
    leverage: '1',
    collateralPool: opts.longLeg + opts.shortLeg,
    floor: '0.30',
    longLegValue: opts.longLeg,
    shortLegValue: opts.shortLeg,
    state: 'ACTIVE',
  });
  return created.id;
}

async function openPosition(
  pairId: string,
  side: 'LONG' | 'SHORT',
  collateral: bigint,
  owner = 'subscriber-1',
  referenceAsset = 'EUR/USD',
): Promise<string> {
  const p = await createPosition(db, {
    coupledPairId: pairId,
    owner,
    referenceAsset,
    side,
    sizeUnits: collateral,
    entryPrice: '1.08500000',
    collateral,
    leverage: '1',
  });
  return p.id;
}

async function countEntries(): Promise<number> {
  const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM journal_entries');
  return r.rows[0]!.n;
}

function rowFor(
  rows: ReadonlyArray<SideBackingRow>,
  pairId: string,
  side: 'LONG' | 'SHORT',
): SideBackingRow {
  const row = rows.find((r) => r.coupledPairId === pairId && r.side === side);
  if (!row) throw new Error(`no sideBacking row for ${pairId} ${side}`);
  return row;
}

describe('residual-backing invariant — per pair AND per side (AC-1)', () => {
  it('reports within-backing exposure with no over-exposure, per (pair, side)', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    await openPosition(pairId, 'LONG', 300_000n);
    await openPosition(pairId, 'LONG', 100_000n);
    await openPosition(pairId, 'SHORT', 450_000n);

    const report = await reconcilePositionsToPairs(db, { now: NOW });

    expect(report.anyOverExposure).toBe(false);
    expect(report.overExposedSides).toEqual([]);

    const long = rowFor(report.sideBacking, pairId, 'LONG');
    expect(long.backing).toBe('500000');
    expect(long.exposure).toBe('400000'); // 300k + 100k aggregated for THIS pair/side
    expect(long.headroom).toBe('100000');
    expect(long.overExposed).toBe(false);
    expect(long.openPositionCount).toBe(2);

    const short = rowFor(report.sideBacking, pairId, 'SHORT');
    expect(short.exposure).toBe('450000');
    expect(short.overExposed).toBe(false);
  });

  it('uses the RESIDUAL leg value (post-D1a-reset), not gross issued notional', async () => {
    // A pair whose winning leg has crystallised & withdrawn down to a 300k residual on the LONG side.
    const pairId = await seedPair({ longLeg: 300_000n, shortLeg: 700_000n });
    await openPosition(pairId, 'LONG', 600_000n); // fit the gross K/2=500k once, but NOT the residual

    const report = await reconcilePositionsToPairs(db, { now: NOW });
    const long = rowFor(report.sideBacking, pairId, 'LONG');
    expect(long.backing).toBe('300000'); // residual, not the 500k symmetric gross
    expect(long.exposure).toBe('600000');
    expect(long.overExposed).toBe(true);
    expect(long.overExposedBy).toBe('300000');
    expect(report.anyOverExposure).toBe(true);
  });
});

describe('over-exposure is reported and NOT masked by headroom elsewhere (AC-2)', () => {
  it('surfaces an over-exposed side despite ample headroom on another pair AND the other side', async () => {
    // Pair A: LONG over-exposed by 100k; SHORT has 400k headroom (same pair, other side).
    const pairA = await seedPair({
      referenceAsset: 'EUR/USD',
      longLeg: 500_000n,
      shortLeg: 500_000n,
    });
    await openPosition(pairA, 'LONG', 600_000n); // exposure 600k > backing 500k → OVER by 100k
    await openPosition(pairA, 'SHORT', 100_000n); // headroom 400k

    // Pair B: huge headroom on both sides (another pair entirely).
    const pairB = await seedPair({
      referenceAsset: 'BTC/USD',
      longLeg: 1_000_000n,
      shortLeg: 1_000_000n,
    });
    await openPosition(pairB, 'LONG', 10_000n, 'subscriber-2', 'BTC/USD');

    const report = await reconcilePositionsToPairs(db, { now: NOW });

    // Net across pairs/sides would be hugely positive — but the per-(pair, side) math never nets, so
    // the single over-exposed side is still surfaced.
    expect(report.anyOverExposure).toBe(true);
    expect(report.overExposedSides).toHaveLength(1);
    expect(report.overExposedSides[0]).toMatchObject({
      coupledPairId: pairA,
      side: 'LONG',
      overExposedBy: '100000',
    });

    // The other sides are individually within backing.
    expect(rowFor(report.sideBacking, pairA, 'SHORT').overExposed).toBe(false);
    expect(rowFor(report.sideBacking, pairB, 'LONG').overExposed).toBe(false);
  });

  it('surfaces a SHORT over-exposure independently of LONG headroom on the same pair (mirror)', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    await openPosition(pairId, 'LONG', 50_000n); // headroom 450k
    await openPosition(pairId, 'SHORT', 800_000n); // OVER by 300k

    const report = await reconcilePositionsToPairs(db, { now: NOW });
    expect(report.anyOverExposure).toBe(true);
    expect(report.overExposedSides).toHaveLength(1);
    expect(report.overExposedSides[0]).toMatchObject({
      coupledPairId: pairId,
      side: 'SHORT',
      overExposedBy: '300000',
    });
    expect(rowFor(report.sideBacking, pairId, 'LONG').overExposed).toBe(false);
  });

  it('over-exposure WITHOUT a chain-closed pair is REPORT-ONLY — no correction, no journal, position stays OPEN', async () => {
    // Scope boundary (Story 8.6 is out of scope): an over-exposed but chain-LIVE pair is reported,
    // NOT auto-liquidated. Correction is reserved for the position↔pair mismatch (AC-3) only.
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    const positionId = await openPosition(pairId, 'LONG', 900_000n); // OVER by 400k, pair still live

    const report = await reconcilePositionsToPairs(db, { now: NOW });
    expect(report.anyOverExposure).toBe(true);
    expect(report.anyMismatch).toBe(false); // not chain-closed ⇒ not a mismatch
    expect(report.corrections).toBe(0);
    expect(await countEntries()).toBe(0); // nothing journaled (no liquidation)
    expect((await getPosition(db, positionId))!.lifecycle).toBe('OPEN'); // never silently closed
  });
});

describe('position ↔ pair mismatch corrected toward the chain — journaled + surfaced (AC-3)', () => {
  it('CORRECTS a chain-closed-pair stale position with a balanced, named, journaled void + OPEN→CLOSED', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    const positionId = await openPosition(pairId, 'LONG', 250_000n);
    const claim = await mkAccount('NOTE_LIABILITY', 'EURC', 6);
    const contra = await mkAccount('FEE_INCOME', 'EURC', 6);
    const before = await countEntries();

    const corrections: PositionClaimCorrectionAccounts[] = [
      {
        coupledPairId: pairId,
        side: 'LONG',
        asset: 'EURC',
        scale: 6,
        claimAccountId: claim,
        contraAccountId: contra,
      },
    ];
    const report = await reconcilePositionsToPairs(db, {
      now: NOW,
      chainClosedPairs: [{ coupledPairId: pairId }],
      corrections,
    });

    // Reported AND corrected.
    expect(report.anyMismatch).toBe(true);
    expect(report.anyCorrected).toBe(true);
    expect(report.corrections).toBe(1);
    const m = report.mismatches[0]!;
    expect(m.positionId).toBe(positionId);
    expect(m.corrected).toBe(true);
    expect(m.correctable).toBe(true);
    expect(m.voidedCollateral).toBe('250000');
    expect(m.journalEntryId).not.toBeNull();

    // The position is CLOSED (corrected toward the chain) — not left alive.
    const closed = await getPosition(db, positionId);
    expect(closed!.lifecycle).toBe('CLOSED');

    // Exactly ONE journaled, balanced (DB-trigger backstop) correcting entry whose description names
    // the void (auditable, never silent).
    expect(await countEntries()).toBe(before + 1);
    const desc = await pool.query<{ description: string }>(
      'SELECT description FROM journal_entries WHERE id = $1',
      [m.journalEntryId],
    );
    expect(desc.rows[0]!.description.toLowerCase()).toContain('void');
    expect(desc.rows[0]!.description).toContain(positionId);

    // A chain-closed pair has 0 residual backing ⇒ the side is also flagged over-exposed.
    expect(rowFor(report.sideBacking, pairId, 'LONG').backing).toBe('0');
    expect(report.anyOverExposure).toBe(true);
  });

  it('REPORTS a mismatch with no correction mapping as uncorrectable — NEVER silently closed', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    const positionId = await openPosition(pairId, 'LONG', 250_000n);

    const report = await reconcilePositionsToPairs(db, {
      now: NOW,
      chainClosedPairs: [{ coupledPairId: pairId }],
      // no corrections mapping
    });

    expect(report.anyMismatch).toBe(true);
    expect(report.anyCorrected).toBe(false);
    expect(report.corrections).toBe(0);
    const m = report.mismatches[0]!;
    expect(m.correctable).toBe(false);
    expect(m.corrected).toBe(false);
    expect(m.reason).toContain('NOT silently closed');

    // The position is STILL OPEN (not silently liquidated) and NO entry was posted.
    const still = await getPosition(db, positionId);
    expect(still!.lifecycle).toBe('OPEN');
    expect(await countEntries()).toBe(0);
  });

  it('strict mode THROWS and ROLLS BACK the whole pass when a mismatch is uncorrectable', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    const correctable = await openPosition(pairId, 'LONG', 100_000n);
    const uncorrectable = await openPosition(pairId, 'SHORT', 100_000n); // no SHORT mapping
    const claim = await mkAccount('NOTE_LIABILITY', 'EURC', 6);
    const contra = await mkAccount('FEE_INCOME', 'EURC', 6);

    await expect(
      reconcilePositionsToPairs(db, {
        now: NOW,
        strict: true,
        chainClosedPairs: [{ coupledPairId: pairId }],
        corrections: [
          {
            coupledPairId: pairId,
            side: 'LONG',
            asset: 'EURC',
            scale: 6,
            claimAccountId: claim,
            contraAccountId: contra,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(UnreconciledPositionMismatchError);

    // Rolled back: BOTH positions still OPEN and NO correcting entry survived.
    expect((await getPosition(db, correctable))!.lifecycle).toBe('OPEN');
    expect((await getPosition(db, uncorrectable))!.lifecycle).toBe('OPEN');
    expect(await countEntries()).toBe(0);
  });

  it('is idempotent — a second pass after correction finds no mismatch and posts nothing', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    await openPosition(pairId, 'LONG', 250_000n);
    const claim = await mkAccount('NOTE_LIABILITY', 'EURC', 6);
    const contra = await mkAccount('FEE_INCOME', 'EURC', 6);
    const corrections: PositionClaimCorrectionAccounts[] = [
      {
        coupledPairId: pairId,
        side: 'LONG',
        asset: 'EURC',
        scale: 6,
        claimAccountId: claim,
        contraAccountId: contra,
      },
    ];

    const first = await reconcilePositionsToPairs(db, {
      now: NOW,
      chainClosedPairs: [{ coupledPairId: pairId }],
      corrections,
    });
    expect(first.corrections).toBe(1);
    const after = await countEntries();

    const second = await reconcilePositionsToPairs(db, {
      now: NOW,
      chainClosedPairs: [{ coupledPairId: pairId }],
      corrections,
    });
    expect(second.anyMismatch).toBe(false); // position is CLOSED now ⇒ no live exposure/mismatch
    expect(second.corrections).toBe(0);
    expect(await countEntries()).toBe(after); // no new entry
  });

  it('rejects structurally-invalid correction accounts (fail loud, mismatched denomination)', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    await openPosition(pairId, 'LONG', 250_000n);
    const claim = await mkAccount('NOTE_LIABILITY', 'EURC', 6);
    const contra = await mkAccount('FEE_INCOME', 'USDC', 6); // different asset ⇒ cannot balance

    await expect(
      reconcilePositionsToPairs(db, {
        now: NOW,
        chainClosedPairs: [{ coupledPairId: pairId }],
        corrections: [
          {
            coupledPairId: pairId,
            side: 'LONG',
            asset: 'EURC',
            scale: 6,
            claimAccountId: claim,
            contraAccountId: contra,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidPositionCorrectionAccountsError);
  });
});

describe('report shape', () => {
  it('serialises to JSON with no bigint and a stable source tag', async () => {
    const pairId = await seedPair({ longLeg: 500_000n, shortLeg: 500_000n });
    await openPosition(pairId, 'LONG', 100_000n);
    const report = await reconcilePositionsToPairs(db, { now: NOW });
    const json = serializePositionReconciliationReport(report);
    expect(json).toContain('"source": "positions+pairs+chain"');
    expect(JSON.parse(json).reconciledAt).toBe(NOW.toISOString());
  });
});
