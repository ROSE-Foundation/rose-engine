// Story 5.6 AC-4 — reconciliation finality & cadence pure helpers, proven LOCALLY (no chain, no DB).
// Also exercises the SIMULATED `getPastPairEvents`-style backfill → authoritative-quantity →
// reconcile path against the local Postgres (the reorg/backfill re-derivation the cadence drives).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  createPool,
  hardReset,
  migrateUp,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import {
  classifyChainEventFinality,
  InvalidConfirmationDepthError,
  isFinal,
  shouldReconcileOnEvent,
  type ChainEventFinalityInput,
} from './finality.js';
import { reconcileLedgerToChain } from './reconcile.js';
import type { ChainSupplySnapshot } from './chain-supply.js';

describe('isFinal — confirmation-depth threshold (AC-4)', () => {
  it('treats the mining block as the first confirmation (depth boundary)', () => {
    // head 100, depth 12 ⇒ a tx is final once mined at block <= 89 (100 - 89 + 1 = 12 confirmations).
    expect(isFinal(89n, 100n, 12n)).toBe(true); // exactly at depth
    expect(isFinal(90n, 100n, 12n)).toBe(false); // one short (11 confirmations)
    expect(isFinal(100n, 100n, 1n)).toBe(true); // depth 1 = just mined
  });

  it('rejects a non-positive confirmation depth', () => {
    expect(() => isFinal(1n, 10n, 0n)).toThrow(InvalidConfirmationDepthError);
    expect(() => isFinal(1n, 10n, -5n)).toThrow(InvalidConfirmationDepthError);
  });
});

describe('classifyChainEventFinality / shouldReconcileOnEvent (AC-4)', () => {
  const base = { headBlockNumber: 100n, confirmationDepth: 12n } as const;

  it('classifies a mined, deep-enough event as final (reconcile per-event)', () => {
    const e: ChainEventFinalityInput = { ...base, blockNumber: 80n };
    expect(classifyChainEventFinality(e)).toBe('final');
    expect(shouldReconcileOnEvent(e)).toBe(true);
  });

  it('classifies a mined-but-shallow event as pending ⇒ wait for finality (NOT reorg)', () => {
    const e: ChainEventFinalityInput = { ...base, blockNumber: 95n };
    expect(classifyChainEventFinality(e)).toBe('pending');
    expect(shouldReconcileOnEvent(e)).toBe(false);
  });

  it('classifies a removed log as a reorg ⇒ reconcile (re-derive from new chain state)', () => {
    const e: ChainEventFinalityInput = { ...base, blockNumber: 80n, removed: true };
    expect(classifyChainEventFinality(e)).toBe('reorg');
    expect(shouldReconcileOnEvent(e)).toBe(true);
  });

  it('classifies a not-yet-mined event as pending ⇒ wait', () => {
    const e: ChainEventFinalityInput = { ...base, blockNumber: null };
    expect(classifyChainEventFinality(e)).toBe('pending');
    expect(shouldReconcileOnEvent(e)).toBe(false);
  });
});

// ---- The simulated getPastPairEvents → authoritative snapshot → reconcile (re-derivation) path ----

// A plain envelope structurally compatible with @rose/chain's PairMinted/PairBurned events (no edge).
interface SimPairEvent {
  readonly eventName: 'PairMinted' | 'PairBurned';
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly removed?: boolean;
}

// Fold final (confirmed, deep-enough, non-removed) past events into the authoritative per-leg supply
// — the re-derivation a reorg triggers, mirroring how a real getPastPairEvents backfill would feed
// the snapshot. Mints add, burns subtract; pending/removed/shallow logs are excluded (cadence).
function deriveSupplyFromPastEvents(
  events: ReadonlyArray<SimPairEvent>,
  headBlockNumber: bigint,
  confirmationDepth: bigint,
): bigint {
  let supply = 0n;
  for (const e of events) {
    if (!shouldFold(e, headBlockNumber, confirmationDepth)) continue;
    supply += e.eventName === 'PairMinted' ? e.amount : -e.amount;
  }
  return supply;
}

function shouldFold(e: SimPairEvent, head: bigint, depth: bigint): boolean {
  const finality = classifyChainEventFinality({
    blockNumber: e.blockNumber,
    removed: e.removed,
    headBlockNumber: head,
    confirmationDepth: depth,
  });
  // A reorg-removed event must NOT count toward supply; only confirmed-final events do.
  return finality === 'final';
}

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
const NOW = new Date('2026-06-16T00:00:00.000Z');

async function entityId(code: string): Promise<string> {
  const r = await pool.query<{ id: string }>('SELECT id FROM entities WHERE code = $1', [code]);
  return r.rows[0]!.id;
}

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
    'TRUNCATE accounts, journal_entries, postings, coupled_pairs, rose_notes, outbox_events CASCADE',
  );
});

describe('backfill (simulated getPastPairEvents) → snapshot → reconcile (AC-4 re-derivation)', () => {
  it('re-derives the authoritative supply from past events and corrects the ledger toward it', async () => {
    const holder = await mkAccount('COIN_ISSUER', 'DEPLOYED_CAPITAL', 'ROSE_L', 0); // ASSET
    // The contra must be NON-ASSET; use a liability-classified account in the same denomination.
    const liabilityContra = await mkAccount('VCC', 'NOTE_LIABILITY', 'ROSE_L', 0); // LIABILITY

    // Ledger currently records 800 (a stale/partial state).
    await recordJournalEntry(db, {
      description: 'stale mint',
      postings: [
        { accountId: holder, direction: 'DEBIT', amount: 800n },
        { accountId: liabilityContra, direction: 'CREDIT', amount: 800n },
      ],
    });

    // Past on-chain events (one shallow/pending and one reorg-removed are EXCLUDED by the cadence):
    const events: SimPairEvent[] = [
      { eventName: 'PairMinted', amount: 1000n, blockNumber: 10n }, // final
      { eventName: 'PairBurned', amount: 200n, blockNumber: 20n }, // final → 800
      { eventName: 'PairMinted', amount: 500n, blockNumber: 95n }, // shallow ⇒ pending, excluded
      { eventName: 'PairMinted', amount: 300n, blockNumber: 30n, removed: true }, // removed, excluded
    ];
    const head = 100n;
    const depth = 12n;
    const authoritativeSupply = deriveSupplyFromPastEvents(events, head, depth);
    expect(authoritativeSupply).toBe(800n); // 1000 - 200 (the shallow + removed are not counted)

    const snapshot: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [{ asset: 'ROSE_L', scale: 0, totalSupply: authoritativeSupply }],
    };

    // Ledger already at 800, authoritative supply 800 ⇒ no correction (idempotent re-derivation).
    const report = await reconcileLedgerToChain(db, snapshot, {
      now: NOW,
      corrections: [
        { asset: 'ROSE_L', scale: 0, holderAccountId: holder, contraAccountId: liabilityContra },
      ],
    });
    expect(report.anyCorrected).toBe(false);
    expect(report.tokens[0]!.divergence.smallestUnits).toBe('0');

    // Now simulate a reorg that CONFIRMS the previously-shallow +500 mint (head advances):
    const headAfterReorg = 200n;
    const supplyAfterReorg = deriveSupplyFromPastEvents(
      events.filter((e) => !e.removed),
      headAfterReorg,
      depth,
    );
    expect(supplyAfterReorg).toBe(1300n); // 1000 - 200 + 500 (now deep enough)

    const report2 = await reconcileLedgerToChain(
      db,
      {
        source: 'ledger+chain',
        tokens: [{ asset: 'ROSE_L', scale: 0, totalSupply: supplyAfterReorg }],
      },
      {
        now: NOW,
        corrections: [
          { asset: 'ROSE_L', scale: 0, holderAccountId: holder, contraAccountId: liabilityContra },
        ],
      },
    );
    expect(report2.anyCorrected).toBe(true);
    expect(report2.tokens[0]!.divergence.smallestUnits).toBe('500');
    expect(report2.tokens[0]!.ledgerQuantityAfter.smallestUnits).toBe('1300');
  });
});
