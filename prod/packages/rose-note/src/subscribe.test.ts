// Story 6.2 — the live subscription loop proven END-TO-END against the LOCAL Postgres + a mock
// EIP-1193 transport + a SYNTHETIC confirmed `PairMinted` (NO Sepolia, NO network port, NO key).
// This is the SM-1 small-scale proof of FR-11:
//   AC-1: an eligible Subscriber drives the paired mint; ONE balanced journal entry (incl.
//         NOTE_LIABILITY) is posted ONLY at the on-chain commit point; the position is reflected in
//         the consolidated group view and the ledger token quantity reconciles to the on-chain supply.
//   AC-2: a non-eligible subscriber is rejected (FR-19) and nothing is written; the full
//         subscribe → mint → ledger loop runs locally at small scale.
//   AC-3: pending until the on-chain commit point (no optimistic success); idempotent (NFR-9).
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
  type RoseDb,
} from '@rose/ledger';
import {
  MintPairDualWrite,
  OutboxSaga,
  createRoseChainClients,
  type ChainConfig,
  type MintAuthorizationGate,
  type PairMintedEvent,
} from '@rose/chain';
import { MintAuthorizationError } from '@rose/chain';
import { buildGroupView, type ChainSupplySnapshot } from '@rose/reconcile';
import { makeAllowlistEligibilityProvider, IneligibleSubscriberError } from './eligibility.js';
import {
  makeSubscriptionService,
  RoseNoteNotFoundError,
  SubscriptionIdempotencyConflictError,
  SubscriptionPairNotActiveError,
  type SubscriptionAccountTopology,
  type SubscriptionService,
} from './index.js';

const ALICE: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BOB: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const PAIR_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
// A throwaway, NON-secret, well-known test key (Anvil account #0). NEVER used against a real network.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENT_HASH: Hex = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface0';
const AMOUNT = 10_000n;
const PAYMENT_ASSET = 'EUR';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let topology: SubscriptionAccountTopology;
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
  authorize?: MintAuthorizationGate;
  allowlist?: readonly Address[];
  capture?: { broadcasts: number };
}): SubscriptionService {
  const capture = over?.capture ?? { broadcasts: 0 };
  const saga = new OutboxSaga({ db });
  const clients = createRoseChainClients(chainConfig(), {
    transport: custom(mockWriteProvider(capture)),
  });
  const mint = new MintPairDualWrite({ saga, clients, account: privateKeyToAccount(TEST_PK) });
  return makeSubscriptionService({
    db,
    mint,
    pairAddress: PAIR_ADDRESS,
    eligibility: makeAllowlistEligibilityProvider(over?.allowlist ?? [ALICE]),
    authorize: over?.authorize ?? (() => ({ effect: 'ALLOW', reason: 'paper-allow' })),
    topology,
    paymentAsset: PAYMENT_ASSET,
  });
}

function mintedEvent(amount = AMOUNT, txHash: Hex = SENT_HASH): PairMintedEvent {
  return {
    eventName: 'PairMinted',
    args: { lTo: ALICE, sTo: ALICE, amount },
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

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);

  // ASSET-classified token holders (circulating quantity) + NON-ASSET supply contras + EUR value
  // accounts. All routing-rule valid (createAccount enforces ENTITY_ALLOWED_ACCOUNT_TYPES).
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
});

describe('AC-1/AC-3 — eligible subscribe → pending → commit-point balanced entry (incl. NOTE_LIABILITY)', () => {
  it('subscribe returns PENDING with a tx hash and posts NOTHING (no optimistic success)', async () => {
    const service = makeService();
    const view = await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-1',
    });
    expect(view.status).toBe('pending');
    expect(view.txHash).toBe(SENT_HASH);
    expect(view.journalEntryId).toBeNull();
    expect(view.roseNoteId).toBe(roseNoteId);
    expect(view.coupledPairId).toBe(pairId);
    expect(view.amount).toBe(AMOUNT);
    // Commit-point ordering: NOTHING recorded at submission.
    expect(await count('journal_entries')).toBe(0);
    expect(await count('outbox_events')).toBe(1);
  });

  it('confirm posts ONE balanced entry touching NOTE_LIABILITY, then status is confirmed', async () => {
    const service = makeService();
    await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-1',
    });

    const confirmed = await service.confirm(mintedEvent());
    expect(confirmed).not.toBeNull();
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.journalEntryId).not.toBeNull();

    // Exactly ONE journal entry, linked to the pair, with the on-chain tx stamped (NFR-3).
    expect(await count('journal_entries')).toBe(1);
    const je = await pool.query<{ id: string; coupled_pair_id: string; tx_hash: string }>(
      'SELECT id, coupled_pair_id, tx_hash FROM journal_entries',
    );
    expect(je.rows[0]!.coupled_pair_id).toBe(pairId);
    expect(je.rows[0]!.tx_hash).toBe(SENT_HASH);
    // 4 quantity postings + 2 value postings (cash DEBIT + NOTE_LIABILITY CREDIT).
    expect(await count('postings')).toBe(6);

    // The NOTE_LIABILITY (EUR) account is CREDITed the subscription amount (the issued-note obligation).
    const noteLiab = await pool.query<{ bal: string }>(
      `SELECT sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text AS bal
         FROM postings WHERE account_id = $1`,
      [topology.noteLiabilityAccountId],
    );
    expect(BigInt(noteLiab.rows[0]!.bal)).toBe(-AMOUNT); // credit-normal ⇒ negative signed sum
  });

  it('reflects the position in the group view; ledger token quantity reconciles to on-chain supply (NFR-9)', async () => {
    const service = makeService();
    await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-1',
    });
    await service.confirm(mintedEvent());

    const snapshot: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [
        { asset: 'ROSE_L', scale: 0, totalSupply: AMOUNT },
        { asset: 'ROSE_S', scale: 0, totalSupply: AMOUNT },
      ],
    };
    const view = await buildGroupView(db, { chainSupplies: snapshot });
    // The coupled pair / note is present in the consolidated view.
    expect(view.coupledPairs).toHaveLength(1);
    expect(view.coupledPairs[0]!.noteId).toBe(roseNoteId);
    // Ledger circulating quantity (ASSET-side) equals the on-chain supply ⇒ no divergence (NFR-9).
    expect(view.chainComparison.anyDivergence).toBe(false);
    for (const d of view.chainComparison.divergences) {
      expect(d.divergence.smallestUnits).toBe('0');
    }
  });
});

describe('AC-2 — a non-eligible subscriber is rejected (FR-19), nothing written', () => {
  it('throws IneligibleSubscriberError and records no outbox row / no mint', async () => {
    const capture = { broadcasts: 0 };
    const service = makeService({ capture });
    await expect(
      service.subscribe({
        roseNoteId,
        subscriber: BOB,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'sub-bad',
      }),
    ).rejects.toBeInstanceOf(IneligibleSubscriberError);
    expect(capture.broadcasts).toBe(0);
    expect(await count('outbox_events')).toBe(0);
    expect(await count('journal_entries')).toBe(0);
  });
});

describe('fail-closed authorization (pre-submit) — DENY vetoes the dual-write', () => {
  it('throws MintAuthorizationError before any mint; nothing recorded (NFR-4)', async () => {
    const capture = { broadcasts: 0 };
    const service = makeService({
      capture,
      authorize: () => ({ effect: 'DENY', reason: 'not authorized' }),
    });
    await expect(
      service.subscribe({
        roseNoteId,
        subscriber: ALICE,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'sub-deny',
      }),
    ).rejects.toBeInstanceOf(MintAuthorizationError);
    expect(capture.broadcasts).toBe(0);
    expect(await count('outbox_events')).toBe(0);
    expect(await count('journal_entries')).toBe(0);
  });
});

describe('idempotency (NFR-9) — a retried subscribe does not re-mint', () => {
  it('returns the existing subscription and broadcasts only once', async () => {
    const capture = { broadcasts: 0 };
    const service = makeService({ capture });
    const first = await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-idem',
    });
    const second = await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-idem',
    });
    expect(first.txHash).toBe(SENT_HASH);
    expect(second.txHash).toBe(SENT_HASH);
    expect(capture.broadcasts).toBe(1); // only ONE on-chain mint
    expect(await count('outbox_events')).toBe(1);

    // Confirm once → exactly one entry; getSubscription reflects confirmed.
    await service.confirm(mintedEvent());
    const read = await service.getSubscription('sub-idem');
    expect(read!.status).toBe('confirmed');
    expect(await count('journal_entries')).toBe(1);
  });
});

describe('guards — missing note / non-active pair', () => {
  it('throws RoseNoteNotFoundError for an absent note', async () => {
    const service = makeService();
    await expect(
      service.subscribe({
        roseNoteId: '99999999-9999-4999-8999-999999999999',
        subscriber: ALICE,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'sub-missing',
      }),
    ).rejects.toBeInstanceOf(RoseNoteNotFoundError);
  });

  it('throws SubscriptionPairNotActiveError when the embedded pair is not ACTIVE', async () => {
    // A fresh delta-neutral pair left PENDING, embedded in a note.
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
      service.subscribe({
        roseNoteId: note.id,
        subscriber: ALICE,
        amount: AMOUNT,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'sub-pending',
      }),
    ).rejects.toBeInstanceOf(SubscriptionPairNotActiveError);
  });
});

describe('getSubscription — pending until commit, then confirmed', () => {
  it('reads pending after subscribe and confirmed after confirm', async () => {
    const service = makeService();
    await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-read',
    });
    const pending = await service.getSubscription('sub-read');
    expect(pending!.status).toBe('pending');
    expect(pending!.journalEntryId).toBeNull();

    await service.confirm(mintedEvent());
    const confirmed = await service.getSubscription('sub-read');
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.journalEntryId).not.toBeNull();
    expect(confirmed!.roseNoteId).toBe(roseNoteId);
  });

  it('returns null for an unknown subscription id', async () => {
    const service = makeService();
    expect(await service.getSubscription('does-not-exist')).toBeNull();
  });
});

describe('review hardening — idempotency conflict / row-kind guard / commit never throws', () => {
  it('rejects a reused idempotency key whose request differs (no silent stranger-position, 409)', async () => {
    const service = makeService();
    await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-conflict',
    });
    // Same key, DIFFERENT amount ⇒ conflict (the original intent must NOT be returned as success).
    await expect(
      service.subscribe({
        roseNoteId,
        subscriber: ALICE,
        amount: AMOUNT + 1n,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'sub-conflict',
      }),
    ).rejects.toBeInstanceOf(SubscriptionIdempotencyConflictError);
  });

  it('getSubscription returns null for a non-PAIR_MINT (e.g. PAIR_BURN) outbox row (not a malformed view)', async () => {
    // A PAIR_BURN intent has lFrom/sFrom (no lTo) — it must NOT be read as a subscription.
    await recordIntent(db, {
      idempotencyKey: 'burn-key',
      operationKind: 'PAIR_BURN',
      payload: { coupledPairId: pairId, lFrom: ALICE, sFrom: ALICE, amount: '500' },
    });
    const service = makeService();
    expect(await service.getSubscription('burn-key')).toBeNull();
  });

  it('confirm NEVER throws into the watcher on a malformed event (non-positive on-chain amount)', async () => {
    const service = makeService();
    await service.subscribe({
      roseNoteId,
      subscriber: ALICE,
      amount: AMOUNT,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'sub-malformed',
    });
    // A synthetic PairMinted with a zero amount makes the plan build throw — confirm must swallow it.
    const outcome = await service.confirm(mintedEvent(0n));
    expect(outcome).toBeNull();
    // Nothing posted (the plan never reached the ledger effect).
    expect(await count('journal_entries')).toBe(0);
  });
});
