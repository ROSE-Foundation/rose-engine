// Story 6.3 — the live redemption loop proven END-TO-END against the LOCAL Postgres + a mock EIP-1193
// transport + a SYNTHETIC confirmed `PairBurned` (NO Sepolia, NO network port, NO key). The INVERSE
// mirror of the 6.2 subscribe e2e:
//   AC-1: a holder redeems; ONE balanced journal entry (incl. NOTE_LIABILITY extinguishment) is posted
//         ONLY at the on-chain commit point; the position is reflected in the consolidated group view
//         and the ledger token quantity reconciles to the (post-burn) on-chain supply (supply ↔ ledger).
//   AC-2: pending until the on-chain commit point (no optimistic success); authorization is fail-closed
//         pre-submit; idempotent (NFR-9).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { custom, getAddress, type Address, type EIP1193RequestFn, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  createAccount,
  createCoupledPair,
  createDb,
  createPool,
  createRoseNote,
  hardReset,
  migrateUp,
  recordIntent,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import {
  BurnPairDualWrite,
  OutboxSaga,
  createRoseChainClients,
  BurnAuthorizationError,
  type BurnAuthorizationGate,
  type ChainConfig,
  type PairBurnedEvent,
} from '@rose/chain';
import { buildGroupView, type ChainSupplySnapshot } from '@rose/reconcile';
import {
  makeRedemptionService,
  RedemptionIdempotencyConflictError,
  RedemptionPairNotActiveError,
  RoseNoteNotFoundError,
  UnsupportedPaymentAssetError,
  type RedemptionAccountTopology,
  type RedemptionService,
} from './index.js';

const ALICE: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BOB: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const PAIR_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
// A throwaway, NON-secret, well-known test key (Anvil account #0). NEVER used against a real network.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENT_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000def';
const INITIAL = 20_000n; // the pre-existing minted position seeded for the redeemer
const AMOUNT = 10_000n; // the redeemed (burned) quantity
const PAYMENT_ASSET = 'EUR';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let topology: RedemptionAccountTopology;
let pairId: string;
let roseNoteId: string;

function chainConfig(): ChainConfig {
  return {
    sepoliaRpcUrl: 'http://127.0.0.1:8545',
    pairAddress: PAIR_ADDRESS,
    lTokenAddress: '0x2222222222222222222222222222222222222222',
    sTokenAddress: '0x3333333333333333333333333333333333333333',
    identityRegistryAddress: '0x4444444444444444444444444444444444444444',
  };
}

/** Mock EIP-1193 provider answering the JSON-RPC viem issues to broadcast a local-account write. */
function mockWriteProvider(capture: { broadcasts: number }): { request: EIP1193RequestFn } {
  const request = (async ({ method }) => {
    switch (method) {
      case 'eth_chainId':
        return `0x${sepolia.id.toString(16)}` as Hex;
      case 'eth_getTransactionCount':
        return '0x0' as Hex;
      case 'eth_estimateGas':
        return '0x5208' as Hex;
      case 'eth_gasPrice':
        return '0x3b9aca00' as Hex;
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00' as Hex;
      case 'eth_blockNumber':
        return '0x10' as Hex;
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          baseFeePerGas: '0x3b9aca00',
          gasLimit: '0x1c9c380',
          timestamp: '0x0',
        } as unknown as Hex;
      case 'eth_feeHistory':
        return {
          oldestBlock: '0x1',
          baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
          gasUsedRatio: [0.5],
          reward: [['0x3b9aca00']],
        } as unknown as Hex;
      case 'eth_sendRawTransaction':
        capture.broadcasts += 1;
        return SENT_HASH;
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
  }) as EIP1193RequestFn;
  return { request };
}

function makeService(over?: {
  authorize?: BurnAuthorizationGate;
  capture?: { broadcasts: number };
}): RedemptionService {
  const capture = over?.capture ?? { broadcasts: 0 };
  const saga = new OutboxSaga({ db });
  const clients = createRoseChainClients(chainConfig(), {
    transport: custom(mockWriteProvider(capture)),
  });
  const burn = new BurnPairDualWrite({ saga, clients, account: privateKeyToAccount(TEST_PK) });
  return makeRedemptionService({
    db,
    burn,
    pairAddress: PAIR_ADDRESS,
    authorize: over?.authorize ?? (() => ({ effect: 'ALLOW', reason: 'paper-allow' })),
    topology,
    paymentAsset: PAYMENT_ASSET,
  });
}

function burnedEvent(amount = AMOUNT, txHash: Hex = SENT_HASH): PairBurnedEvent {
  return {
    eventName: 'PairBurned',
    args: { lFrom: ALICE, sFrom: ALICE, amount },
    address: PAIR_ADDRESS,
    blockNumber: 101n,
    transactionHash: txHash,
    logIndex: 0,
  };
}

async function count(table: 'journal_entries' | 'postings' | 'outbox_events'): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0]!.n;
}

/** Signed balance (DEBIT − CREDIT) for an account across all postings. */
async function balanceOf(accountId: string): Promise<bigint> {
  const r = await pool.query<{ bal: string }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS bal
       FROM postings WHERE account_id = $1`,
    [accountId],
  );
  return BigInt(r.rows[0]!.bal);
}

/** Seed a pre-existing minted position (INITIAL) for the redeemer — one balanced mint entry. */
async function seedMintedPosition(amount: bigint): Promise<void> {
  await recordJournalEntry(db, {
    description: 'seed — pre-existing minted position (test fixture)',
    coupledPairId: pairId,
    postings: [
      { accountId: topology.longLegHolderAccountId, direction: 'DEBIT', amount },
      { accountId: topology.longLegSupplyAccountId, direction: 'CREDIT', amount },
      { accountId: topology.shortLegHolderAccountId, direction: 'DEBIT', amount },
      { accountId: topology.shortLegSupplyAccountId, direction: 'CREDIT', amount },
      { accountId: topology.cashAccountId, direction: 'DEBIT', amount },
      { accountId: topology.noteLiabilityAccountId, direction: 'CREDIT', amount },
    ],
  });
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);

  // The 5.4 burn topology: ASSET-classified token holders (circulating quantity) + NON-ASSET supply
  // contras + EUR value accounts (mirror the 6.2 subscription topology so a mint→burn round-trips).
  const lHolder = await createAccount(db, {
    entityCode: 'COIN_ISSUER',
    type: 'BACKING_FLOAT',
    asset: 'ROSE_L',
    decimalScale: 0,
  });
  const lSupply = await createAccount(db, {
    entityCode: 'VCC',
    type: 'NOTE_LIABILITY',
    asset: 'ROSE_L',
    decimalScale: 0,
  });
  const sHolder = await createAccount(db, {
    entityCode: 'COIN_ISSUER',
    type: 'BACKING_FLOAT',
    asset: 'ROSE_S',
    decimalScale: 0,
  });
  const sSupply = await createAccount(db, {
    entityCode: 'VCC',
    type: 'CLIENT_COLLATERAL',
    asset: 'ROSE_S',
    decimalScale: 0,
  });
  const cash = await createAccount(db, {
    entityCode: 'VCC',
    type: 'BACKING_FLOAT',
    asset: PAYMENT_ASSET,
    decimalScale: 2,
  });
  const noteLiab = await createAccount(db, {
    entityCode: 'VCC',
    type: 'NOTE_LIABILITY',
    asset: PAYMENT_ASSET,
    decimalScale: 2,
  });
  topology = {
    longLegHolderAccountId: lHolder.id,
    longLegSupplyAccountId: lSupply.id,
    shortLegHolderAccountId: sHolder.id,
    shortLegSupplyAccountId: sSupply.id,
    cashAccountId: cash.id,
    noteLiabilityAccountId: noteLiab.id,
  };
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE rose_notes, coupled_pairs, journal_entries, outbox_events CASCADE');
  const pair = await createCoupledPair(db, {
    referenceAsset: 'EUR/USD',
    anchorPrice: '1.10000000',
    leverage: '1',
    collateralPool: 1_000_000n,
    floor: '0.5',
    longLegValue: 500_000n,
    shortLegValue: 500_000n,
    state: 'ACTIVE',
  });
  pairId = pair.id;
  const note = await createRoseNote(db, { coupledPairId: pairId });
  roseNoteId = note.id;
  await seedMintedPosition(INITIAL);
});

describe('AC-1/AC-2 — redeem → pending → commit-point balanced burn entry (extinguishes NOTE_LIABILITY)', () => {
  it('redeem returns PENDING with a tx hash and posts NO new entry (no optimistic success)', async () => {
    const service = makeService();
    const view = await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-1',
    });
    expect(view.status).toBe('pending');
    expect(view.txHash).toBe(SENT_HASH);
    expect(view.journalEntryId).toBeNull();
    expect(view.roseNoteId).toBe(roseNoteId);
    expect(view.coupledPairId).toBe(pairId);
    expect(view.redeemer).toBe(ALICE);
    expect(view.amount).toBe(AMOUNT);
    // Commit-point ordering: NOTHING new recorded at submission — only the seeded mint entry exists.
    expect(await count('journal_entries')).toBe(1);
    expect(await count('outbox_events')).toBe(1);
    // No burn entry yet (the seed entry carries no tx hash).
    const burnEntries = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(burnEntries.rows[0]!.n).toBe(0);
  });

  it('confirm posts ONE balanced burn entry; holder CREDIT, supply DEBIT, NOTE_LIABILITY extinguished', async () => {
    const service = makeService();
    await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-1',
    });

    const confirmed = await service.confirm(burnedEvent());
    expect(confirmed).not.toBeNull();
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.journalEntryId).not.toBeNull();

    // Exactly ONE burn journal entry (tx-hash-stamped), linked to the pair (NFR-3). The seed entry has
    // no tx hash, so filtering by the burn tx hash isolates the redemption entry.
    const je = await pool.query<{ id: string; coupled_pair_id: string }>(
      'SELECT id, coupled_pair_id FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(je.rows).toHaveLength(1);
    expect(je.rows[0]!.coupled_pair_id).toBe(pairId);
    // 2 entries total now (seed mint + burn), 12 postings (6 + 6).
    expect(await count('journal_entries')).toBe(2);
    expect(await count('postings')).toBe(12);

    // A burn RETIRES supply: holder leg net = INITIAL − AMOUNT (CREDITed by the burn), supply contra
    // net = −(INITIAL − AMOUNT) (DEBITed by the burn). NOTE_LIABILITY (EUR) is EXTINGUISHED by AMOUNT
    // (DEBITed back toward zero) — its credit-normal balance moves from −INITIAL to −(INITIAL − AMOUNT).
    expect(await balanceOf(topology.longLegHolderAccountId)).toBe(INITIAL - AMOUNT);
    expect(await balanceOf(topology.longLegSupplyAccountId)).toBe(-(INITIAL - AMOUNT));
    expect(await balanceOf(topology.shortLegHolderAccountId)).toBe(INITIAL - AMOUNT);
    expect(await balanceOf(topology.shortLegSupplyAccountId)).toBe(-(INITIAL - AMOUNT));
    expect(await balanceOf(topology.noteLiabilityAccountId)).toBe(-(INITIAL - AMOUNT));
    // Cash paid out: the VCC cash account net moves from +INITIAL to +(INITIAL − AMOUNT).
    expect(await balanceOf(topology.cashAccountId)).toBe(INITIAL - AMOUNT);
  });

  it('reflects the redemption in the group view; ledger quantity reconciles to the post-burn supply (NFR-9)', async () => {
    const service = makeService();
    await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-1',
    });
    await service.confirm(burnedEvent());

    // The post-burn on-chain supply is INITIAL − AMOUNT (the burn retired AMOUNT on each leg).
    const remaining = INITIAL - AMOUNT;
    const snapshot: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [
        { asset: 'ROSE_L', scale: 0, totalSupply: remaining },
        { asset: 'ROSE_S', scale: 0, totalSupply: remaining },
      ],
    };
    const view = await buildGroupView(db, { chainSupplies: snapshot });
    expect(view.coupledPairs).toHaveLength(1);
    expect(view.coupledPairs[0]!.noteId).toBe(roseNoteId);
    // Ledger circulating quantity (ASSET-side, post-burn) equals the on-chain supply ⇒ no divergence.
    expect(view.chainComparison.anyDivergence).toBe(false);
    for (const d of view.chainComparison.divergences) {
      expect(d.divergence.smallestUnits).toBe('0');
    }
  });
});

describe('fail-closed authorization (pre-submit) — DENY vetoes the dual-write (NFR-4)', () => {
  it('throws BurnAuthorizationError before any burn; nothing recorded', async () => {
    const capture = { broadcasts: 0 };
    const service = makeService({
      capture,
      authorize: () => ({ effect: 'DENY', reason: 'not authorized' }),
    });
    await expect(
      service.redeem({
        roseNoteId,
        redeemer: ALICE,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'red-deny',
      }),
    ).rejects.toBeInstanceOf(BurnAuthorizationError);
    expect(capture.broadcasts).toBe(0);
    expect(await count('outbox_events')).toBe(0); // no intent persisted (fail-closed pre-submit)
  });
});

describe('idempotency (NFR-9) — a retried redeem does not re-burn', () => {
  it('returns the existing redemption and broadcasts only once', async () => {
    const capture = { broadcasts: 0 };
    const service = makeService({ capture });
    const first = await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-idem',
    });
    const second = await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-idem',
    });
    expect(first.txHash).toBe(SENT_HASH);
    expect(second.txHash).toBe(SENT_HASH);
    expect(capture.broadcasts).toBe(1); // only ONE on-chain burn
    expect(await count('outbox_events')).toBe(1);

    await service.confirm(burnedEvent());
    const read = await service.getRedemption('red-idem');
    expect(read!.status).toBe('confirmed');
  });

  it('rejects a reused idempotency key whose request differs (no silent stranger-position, 409)', async () => {
    const service = makeService();
    await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-conflict',
    });
    await expect(
      service.redeem({
        roseNoteId,
        redeemer: ALICE,
        amount: AMOUNT + 1n,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'red-conflict',
      }),
    ).rejects.toBeInstanceOf(RedemptionIdempotencyConflictError);
  });
});

describe('guards — missing note / non-active pair / unsupported asset', () => {
  it('throws RoseNoteNotFoundError for an absent note', async () => {
    const service = makeService();
    await expect(
      service.redeem({
        roseNoteId: '99999999-9999-4999-8999-999999999999',
        redeemer: ALICE,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'red-missing',
      }),
    ).rejects.toBeInstanceOf(RoseNoteNotFoundError);
  });

  it('throws RedemptionPairNotActiveError when the embedded pair is not ACTIVE', async () => {
    const pending = await createCoupledPair(db, {
      referenceAsset: 'EUR/USD',
      anchorPrice: '1.10000000',
      leverage: '1',
      collateralPool: 1_000_000n,
      floor: '0.5',
      longLegValue: 500_000n,
      shortLegValue: 500_000n,
      state: 'PENDING',
    });
    const note = await createRoseNote(db, { coupledPairId: pending.id });
    const service = makeService();
    await expect(
      service.redeem({
        roseNoteId: note.id,
        redeemer: ALICE,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'red-pending',
      }),
    ).rejects.toBeInstanceOf(RedemptionPairNotActiveError);
  });

  it('throws UnsupportedPaymentAssetError for an asset other than the configured one', async () => {
    const service = makeService();
    await expect(
      service.redeem({
        roseNoteId,
        redeemer: ALICE,
        amount: AMOUNT,
        paymentAsset: 'USD',
        idempotencyKey: 'red-asset',
      }),
    ).rejects.toBeInstanceOf(UnsupportedPaymentAssetError);
  });
});

describe('getRedemption — pending until commit, then confirmed; row-kind / commit-never-throws', () => {
  it('reads pending after redeem and confirmed after confirm', async () => {
    const service = makeService();
    await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-read',
    });
    const pending = await service.getRedemption('red-read');
    expect(pending!.status).toBe('pending');
    expect(pending!.journalEntryId).toBeNull();

    await service.confirm(burnedEvent());
    const confirmed = await service.getRedemption('red-read');
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.journalEntryId).not.toBeNull();
    expect(confirmed!.roseNoteId).toBe(roseNoteId);
  });

  it('returns null for an unknown redemption id', async () => {
    const service = makeService();
    expect(await service.getRedemption('does-not-exist')).toBeNull();
  });

  it('returns null for a non-PAIR_BURN (e.g. PAIR_MINT) outbox row (not a malformed view)', async () => {
    // A PAIR_MINT intent has lTo/sTo (no lFrom) — it must NOT be read as a redemption.
    await recordIntent(db, {
      idempotencyKey: 'mint-key',
      operationKind: 'PAIR_MINT',
      payload: { coupledPairId: pairId, lTo: ALICE, sTo: ALICE, amount: '500' },
    });
    const service = makeService();
    expect(await service.getRedemption('mint-key')).toBeNull();
  });

  it('confirm NEVER throws into the watcher on a malformed event (non-positive on-chain amount)', async () => {
    const service = makeService();
    await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-malformed',
    });
    const outcome = await service.confirm(burnedEvent(0n));
    expect(outcome).toBeNull();
    // No burn entry posted (the plan never reached the ledger effect) — only the seed entry remains.
    const burnEntries = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(burnEntries.rows[0]!.n).toBe(0);
  });

  it('a divergent confirm (on-chain amount != intent) posts NOTHING and stays pending (NFR-9, reconcile 5.6)', async () => {
    const service = makeService();
    await service.redeem({
      roseNoteId,
      redeemer: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-diverge',
    });
    // A confirmed amount that differs from the recorded intent is a divergence — the 5.4 effect throws
    // it (caught internally as an anomaly), the row stays SUBMITTED, nothing is posted. The service
    // surfaces a still-PENDING view (never confirmed), and no burn entry exists.
    const view = await service.confirm(burnedEvent(AMOUNT + 1n));
    expect(view).not.toBeNull();
    expect(view!.status).toBe('pending');
    expect(view!.journalEntryId).toBeNull();
    const burnEntries = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(burnEntries.rows[0]!.n).toBe(0);
  });

  it('a non-eligible-looking address still redeems — redemption does not consult FR-19 eligibility', async () => {
    // BOB is not on any allowlist; redemption RETIRES tokens (no recipient gate), so it proceeds. The
    // capital-flow authorization gate is the sole gate, and it ALLOWs here.
    const service = makeService();
    const view = await service.redeem({
      roseNoteId,
      redeemer: BOB,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'red-bob',
    });
    expect(view.status).toBe('pending');
    expect(view.redeemer).toBe(BOB);
  });
});
