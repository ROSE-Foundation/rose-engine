// Story 8.3 — open & close a directional position over the REAL atomic subscribe/mint + redeem/burn
// flow, proven END-TO-END against the LOCAL Postgres + a mock EIP-1193 transport + SYNTHETIC confirmed
// PairMinted/PairBurned events (NO Sepolia, NO network, NO key). Test-first on the invariants:
//   AC-1: open drives a PAIRED mint (lTo == sTo == owner, both legs) → at the on-chain commit point
//         ONE balanced entry (incl. NOTE_LIABILITY) is posted AND the position is created OPEN;
//         no position / no entry at submit (no optimistic success).
//   AC-2: close drives a PAIRED burn → at the commit point ONE balanced entry retires both legs AND
//         the position flips OPEN → CLOSED; the position stays OPEN until the commit point.
//   Commit-point: idempotent re-confirm (no duplicate entry/position/close); a vetoed authorization
//         or eligibility refusal opens/closes nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { custom, getAddress, type Address, type EIP1193RequestFn, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  createAccount,
  createCoupledPair,
  createDb,
  createPool,
  hardReset,
  migrateUp,
  type RoseDb,
} from '@rose/ledger';
import {
  MintPairDualWrite,
  BurnPairDualWrite,
  OutboxSaga,
  createRoseChainClients,
  type ChainConfig,
  type MintAuthorizationGate,
  type PairBurnedEvent,
  type PairMintedEvent,
} from '@rose/chain';
import {
  makeAllowlistEligibilityProvider,
  IneligibleSubscriberError,
  type RedemptionAccountTopology,
  type SubscriptionAccountTopology,
} from '@rose/rose-note';
import {
  createPosition,
  closePosition as closePositionRow,
  makePositionService,
  PositionIdempotencyConflictError,
  PositionLifecycleError,
  SolvencyGuardrailError,
  type PositionService,
} from './index.js';

const ALICE: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BOB: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const PAIR_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
// A throwaway, NON-secret, well-known test key (Anvil account #0). NEVER used against a real network.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const MINT_HASH: Hex = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface0';
const BURN_HASH: Hex = '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef0';
const AMOUNT = 10_000n;
const ANCHOR = '1.10000000';
const PAYMENT_ASSET = 'EUR';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let openTopology: SubscriptionAccountTopology;
let closeTopology: RedemptionAccountTopology;
let pairId: string;

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
function mockWriteProvider(
  hash: Hex,
  capture: { broadcasts: number },
): { request: EIP1193RequestFn } {
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
        return hash;
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
  }) as EIP1193RequestFn;
  return { request };
}

function makeService(over?: {
  authorize?: MintAuthorizationGate;
  allowlist?: readonly Address[];
  mintCapture?: { broadcasts: number };
  burnCapture?: { broadcasts: number };
}): PositionService {
  const saga = new OutboxSaga({ db });
  const mintClients = createRoseChainClients(chainConfig(), {
    transport: custom(mockWriteProvider(MINT_HASH, over?.mintCapture ?? { broadcasts: 0 })),
  });
  const burnClients = createRoseChainClients(chainConfig(), {
    transport: custom(mockWriteProvider(BURN_HASH, over?.burnCapture ?? { broadcasts: 0 })),
  });
  const mint = new MintPairDualWrite({
    saga,
    clients: mintClients,
    account: privateKeyToAccount(TEST_PK),
  });
  const burn = new BurnPairDualWrite({
    saga,
    clients: burnClients,
    account: privateKeyToAccount(TEST_PK),
  });
  return makePositionService({
    db,
    saga,
    mint,
    burn,
    pairAddress: PAIR_ADDRESS,
    eligibility: makeAllowlistEligibilityProvider(over?.allowlist ?? [ALICE]),
    authorize: over?.authorize ?? (() => ({ effect: 'ALLOW', reason: 'paper-allow' })),
    openTopology,
    closeTopology,
    paymentAsset: PAYMENT_ASSET,
  });
}

function mintedEvent(amount = AMOUNT, txHash: Hex = MINT_HASH): PairMintedEvent {
  return {
    eventName: 'PairMinted',
    args: { lTo: ALICE, sTo: ALICE, amount },
    address: PAIR_ADDRESS,
    blockNumber: 101n,
    transactionHash: txHash,
    logIndex: 0,
  };
}

function burnedEvent(amount = AMOUNT, txHash: Hex = BURN_HASH): PairBurnedEvent {
  return {
    eventName: 'PairBurned',
    args: { lFrom: ALICE, sFrom: ALICE, amount },
    address: PAIR_ADDRESS,
    blockNumber: 202n,
    transactionHash: txHash,
    logIndex: 0,
  };
}

async function count(
  table: 'journal_entries' | 'postings' | 'outbox_events' | 'positions',
): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0]!.n;
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);

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
  openTopology = {
    longLegHolderAccountId: lHolder.id,
    longLegSupplyAccountId: lSupply.id,
    shortLegHolderAccountId: sHolder.id,
    shortLegSupplyAccountId: sSupply.id,
    cashAccountId: cash.id,
    noteLiabilityAccountId: noteLiab.id,
  };
  closeTopology = {
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
  await pool.query('TRUNCATE positions, coupled_pairs, journal_entries, outbox_events CASCADE');
  const pair = await createCoupledPair(db, {
    referenceAsset: 'EUR/USD',
    anchorPrice: ANCHOR,
    leverage: '1',
    collateralPool: 1_000_000n,
    floor: '0.5',
    longLegValue: 500_000n,
    shortLegValue: 500_000n,
    state: 'ACTIVE',
  });
  pairId = pair.id;
});

const openInput = (over?: Partial<Parameters<PositionService['openPosition']>[0]>) => ({
  coupledPairId: pairId,
  owner: ALICE,
  side: 'LONG' as const,
  amount: AMOUNT,
  paymentAsset: PAYMENT_ASSET,
  idempotencyKey: 'open-1',
  ...over,
});

describe('AC-1 — open: pending → commit-point balanced entry + position OPEN (no optimistic success)', () => {
  it('openPosition returns PENDING with a tx hash and writes NOTHING (no entry, no position)', async () => {
    const service = makeService();
    const view = await service.openPosition(openInput());
    expect(view.status).toBe('pending');
    expect(view.txHash).toBe(MINT_HASH);
    expect(view.journalEntryId).toBeNull();
    expect(view.position).toBeNull();
    expect(view.coupledPairId).toBe(pairId);
    expect(view.amount).toBe(AMOUNT);
    expect(view.side).toBe('LONG');
    // Commit-point ordering: NOTHING recorded at submission.
    expect(await count('journal_entries')).toBe(0);
    expect(await count('positions')).toBe(0);
    expect(await count('outbox_events')).toBe(1);
  });

  it('the open intent is a PAIRED mint — lTo == sTo == owner (single-leg impossible)', async () => {
    const service = makeService();
    await service.openPosition(openInput());
    const row = await pool.query<{
      payload: { lTo: string; sTo: string; amount: string };
      operation_kind: string;
    }>('SELECT payload, operation_kind FROM outbox_events');
    expect(row.rows[0]!.operation_kind).toBe('PAIR_MINT');
    expect(getAddress(row.rows[0]!.payload.lTo)).toBe(ALICE);
    expect(getAddress(row.rows[0]!.payload.sTo)).toBe(ALICE);
    expect(row.rows[0]!.payload.amount).toBe(AMOUNT.toString());
  });

  it('confirmOpen posts ONE balanced entry (both legs + NOTE_LIABILITY) and creates the position OPEN', async () => {
    const service = makeService();
    await service.openPosition(openInput());

    const confirmed = await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    expect(confirmed).not.toBeNull();
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.journalEntryId).not.toBeNull();
    expect(confirmed!.position).not.toBeNull();

    // The position is recorded with entry = anchor P₀, the requested side, leverage 1, size = amount.
    expect(confirmed!.position!.lifecycle).toBe('OPEN');
    expect(confirmed!.position!.side).toBe('LONG');
    expect(confirmed!.position!.entryPrice).toBe(ANCHOR);
    expect(confirmed!.position!.leverage).toBe('1');
    expect(confirmed!.position!.sizeUnits).toBe(AMOUNT);
    expect(confirmed!.position!.collateral).toBe(AMOUNT);

    // Exactly ONE journal entry, linked to the pair, with the on-chain tx stamped (NFR-3).
    expect(await count('journal_entries')).toBe(1);
    expect(await count('positions')).toBe(1);
    const je = await pool.query<{ coupled_pair_id: string; tx_hash: string }>(
      'SELECT coupled_pair_id, tx_hash FROM journal_entries',
    );
    expect(je.rows[0]!.coupled_pair_id).toBe(pairId);
    expect(je.rows[0]!.tx_hash).toBe(MINT_HASH);
    // 4 quantity postings (BOTH legs) + 2 value postings (cash DEBIT + NOTE_LIABILITY CREDIT).
    expect(await count('postings')).toBe(6);
    const noteLiab = await pool.query<{ bal: string }>(
      `SELECT sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text AS bal
         FROM postings WHERE account_id = $1`,
      [openTopology.noteLiabilityAccountId],
    );
    expect(BigInt(noteLiab.rows[0]!.bal)).toBe(-AMOUNT); // credit-normal ⇒ negative signed sum
  });

  it('records the requested SHORT side faithfully', async () => {
    const service = makeService();
    await service.openPosition(openInput({ side: 'SHORT', idempotencyKey: 'open-short' }));
    const confirmed = await service.confirmOpen(mintedEvent(), { side: 'SHORT' });
    expect(confirmed!.position!.side).toBe('SHORT');
  });
});

describe('AC-1 — open: fail-closed (eligibility / authorization) opens nothing', () => {
  it('an ineligible owner is rejected (FR-19) and nothing is written', async () => {
    const service = makeService({ allowlist: [BOB] }); // ALICE not eligible
    await expect(service.openPosition(openInput())).rejects.toBeInstanceOf(
      IneligibleSubscriberError,
    );
    expect(await count('outbox_events')).toBe(0);
    expect(await count('positions')).toBe(0);
  });

  it('a vetoed authorization (DENY) submits no mint and creates no position', async () => {
    const service = makeService({ authorize: () => ({ effect: 'DENY', reason: 'paper-deny' }) });
    await expect(service.openPosition(openInput())).rejects.toMatchObject({
      name: 'MintAuthorizationError',
    });
    // Intent recorded (PENDING) but no on-chain submit, no entry, no position.
    expect(await count('journal_entries')).toBe(0);
    expect(await count('positions')).toBe(0);
  });
});

describe('AC-1 — open: idempotent commit point (no duplicate entry/position)', () => {
  it('re-confirming the same PairMinted is a no-op (one entry, one position)', async () => {
    const service = makeService();
    await service.openPosition(openInput());
    await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    const again = await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    expect(again!.status).toBe('confirmed');
    expect(await count('journal_entries')).toBe(1);
    expect(await count('positions')).toBe(1);
    expect(await count('postings')).toBe(6);
  });

  it('reusing the idempotency key for a DIFFERENT request fails closed', async () => {
    const service = makeService({ allowlist: [ALICE, BOB] });
    await service.openPosition(openInput());
    await expect(
      service.openPosition(openInput({ owner: BOB })), // same key, different owner
    ).rejects.toBeInstanceOf(PositionIdempotencyConflictError);
  });
});

describe('AC-2 — close: pending → commit-point balanced burn + position CLOSED', () => {
  async function openAndConfirm(service: PositionService): Promise<string> {
    await service.openPosition(openInput());
    const confirmed = await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    return confirmed!.position!.id;
  }

  it('closePosition returns PENDING; the position stays OPEN until the commit point (no optimistic success)', async () => {
    const service = makeService();
    const positionId = await openAndConfirm(service);

    const view = await service.closePosition({
      positionId,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-1',
    });
    expect(view.status).toBe('pending');
    expect(view.txHash).toBe(BURN_HASH);
    expect(view.position!.lifecycle).toBe('OPEN'); // still OPEN — no optimistic close
    // Still exactly ONE (mint) journal entry; no burn entry yet.
    expect(await count('journal_entries')).toBe(1);
    // The burn intent is a PAIRED burn (lFrom == sFrom == owner).
    const burnRow = await pool.query<{
      payload: { lFrom: string; sFrom: string };
      operation_kind: string;
    }>("SELECT payload, operation_kind FROM outbox_events WHERE operation_kind = 'PAIR_BURN'");
    expect(getAddress(burnRow.rows[0]!.payload.lFrom)).toBe(ALICE);
    expect(getAddress(burnRow.rows[0]!.payload.sFrom)).toBe(ALICE);
  });

  it('confirmClose posts ONE balanced burn entry (both legs retired) and flips the position CLOSED', async () => {
    const service = makeService();
    const positionId = await openAndConfirm(service);
    await service.closePosition({
      positionId,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-1',
    });

    const closed = await service.confirmClose(burnedEvent());
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('confirmed');
    expect(closed!.journalEntryId).not.toBeNull();
    expect(closed!.position!.lifecycle).toBe('CLOSED');

    // TWO journal entries now (the mint + the burn), both linked to the pair.
    expect(await count('journal_entries')).toBe(2);
    // The burn entry retires BOTH legs (4 quantity postings) + 2 value postings.
    const burnJe = await pool.query<{ tx_hash: string }>(
      'SELECT tx_hash FROM journal_entries WHERE tx_hash = $1',
      [BURN_HASH],
    );
    expect(burnJe.rows).toHaveLength(1);
    // NOTE_LIABILITY net is zero after open(+AMOUNT credit) then close(-AMOUNT debit).
    const noteLiab = await pool.query<{ bal: string }>(
      `SELECT sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text AS bal
         FROM postings WHERE account_id = $1`,
      [closeTopology.noteLiabilityAccountId],
    );
    expect(BigInt(noteLiab.rows[0]!.bal)).toBe(0n);
  });

  it('re-confirming the same PairBurned is a no-op (position closed once, no duplicate entry)', async () => {
    const service = makeService();
    const positionId = await openAndConfirm(service);
    await service.closePosition({
      positionId,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-1',
    });
    await service.confirmClose(burnedEvent());
    const again = await service.confirmClose(burnedEvent());
    expect(again!.position!.lifecycle).toBe('CLOSED');
    expect(await count('journal_entries')).toBe(2); // not 3
  });

  it('closing a non-existent / already-CLOSED position is rejected before any write', async () => {
    const service = makeService();
    const positionId = await openAndConfirm(service);
    await service.closePosition({
      positionId,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-1',
    });
    await service.confirmClose(burnedEvent());
    // Second close of the now-CLOSED position fails closed (lifecycle guard), nothing submitted.
    await expect(
      service.closePosition({ positionId, paymentAsset: PAYMENT_ASSET, idempotencyKey: 'close-2' }),
    ).rejects.toBeInstanceOf(PositionLifecycleError);
  });
});

describe('Review regressions — commit-point safety / crash-resume / fail-closed', () => {
  async function openAndConfirm(service: PositionService): Promise<string> {
    await service.openPosition(openInput());
    const confirmed = await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    return confirmed!.position!.id;
  }

  it('crash between submit and commit: a SUBMITTED outbox row remains, NO half-open position', async () => {
    const service = makeService();
    await service.openPosition(openInput()); // submit only, NO confirm (simulate crash before commit)
    // The outbox row is SUBMITTED (re-drivable by the 5.6 resume seam); no position row exists.
    const row = await pool.query<{ status: string }>('SELECT status FROM outbox_events');
    expect(row.rows[0]!.status).toBe('SUBMITTED');
    expect(await count('positions')).toBe(0);
    expect(await count('journal_entries')).toBe(0);
    // A later confirm (the resume) still commits exactly once.
    await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    expect(await count('positions')).toBe(1);
    expect(await count('journal_entries')).toBe(1);
  });

  it('a vetoed authorization (DENY) on close submits no burn and leaves the position OPEN', async () => {
    const service = makeService();
    const positionId = await openAndConfirm(service);
    const denying = makeService({ authorize: () => ({ effect: 'DENY', reason: 'paper-deny' }) });
    await expect(
      denying.closePosition({
        positionId,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'close-deny',
      }),
    ).rejects.toMatchObject({ name: 'BurnAuthorizationError' });
    // No burn entry; the position is untouched (still OPEN, 1 mint entry only).
    expect(await count('journal_entries')).toBe(1);
    const pos = await pool.query<{ lifecycle: string }>(
      'SELECT lifecycle FROM positions WHERE id = $1',
      [positionId],
    );
    expect(pos.rows[0]!.lifecycle).toBe('OPEN');
  });

  it('a divergent confirm (on-chain amount != recorded intent) commits NOTHING — atomic rollback', async () => {
    const service = makeService();
    await service.openPosition(openInput()); // intent amount = AMOUNT
    // The confirmed event reports a DIFFERENT amount than the recorded intent — the 5.3 effect throws
    // the divergence; the whole confirm transaction rolls back: no entry, no position.
    const outcome = await service.confirmOpen(mintedEvent(AMOUNT + 1n), { side: 'LONG' });
    expect(outcome).toBeNull();
    expect(await count('journal_entries')).toBe(0);
    expect(await count('positions')).toBe(0);
    // The outbox row stays SUBMITTED (a reconcile-5.6 anomaly), never CONFIRMED.
    const row = await pool.query<{ status: string }>('SELECT status FROM outbox_events');
    expect(row.rows[0]!.status).toBe('SUBMITTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.6 — §11.4 solvency guardrail for the INDEPENDENT single-side close (D1
// topology: the opposite leg held by ANOTHER user). The guardrail fail-closes the
// close-submission seam BEFORE any burn is submitted, so the on-chain package is
// never burned for a single-side release (it burns only when BOTH sides release),
// and the other holder's leg is never force-burned. UX-DR5: a typed, rule-named refusal.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed an OPEN position directly (repo path) to construct a specific L/S topology. */
async function seedPosition(owner: Address, side: 'LONG' | 'SHORT'): Promise<string> {
  const view = await createPosition(db, {
    coupledPairId: pairId,
    owner,
    referenceAsset: 'EUR/USD',
    side,
    sizeUnits: AMOUNT,
    entryPrice: ANCHOR,
    collateral: AMOUNT,
    leverage: '1',
  });
  return view.id;
}

describe('AC-1 — D1 independent single-side close is FAIL-CLOSED under the §11.4 solvency guardrail', () => {
  it('refuses (typed, rule-named) when another user holds the opposite leg — submits NO burn, burns no leg', async () => {
    const burnCapture = { broadcasts: 0 };
    const service = makeService({ allowlist: [ALICE, BOB], burnCapture });
    // D1 topology: Alice LONG, Bob SHORT on the SAME pair (opposite leg held by another user).
    const aliceLong = await seedPosition(ALICE, 'LONG');
    const bobShort = await seedPosition(BOB, 'SHORT');

    let thrown: unknown;
    try {
      await service.closePosition({
        positionId: aliceLong,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'close-d1',
      });
    } catch (e) {
      thrown = e;
    }
    // Typed, rule-named refusal (UX-DR5).
    expect(thrown).toBeInstanceOf(SolvencyGuardrailError);
    const err = thrown as SolvencyGuardrailError;
    expect(err.name).toBe('SolvencyGuardrailError');
    expect(err.rule).toBe('§11.4-solvency-guardrail-independent-single-side-close');
    expect(err.counterpartyOwner).toBe(BOB);
    expect(err.counterpartyPositionId).toBe(bobShort);
    expect(err.message).toMatch(/§11\.4/);
    expect(err.message).toMatch(/both/i);

    // NO burn was ever submitted — the on-chain package is not burned, the other holder's leg is intact.
    expect(burnCapture.broadcasts).toBe(0);
    expect(await count('outbox_events')).toBe(0);
    expect(await count('journal_entries')).toBe(0);
    // Both positions remain OPEN — no whole-package burn, no single-leg burn of Bob's leg.
    const rows = await pool.query<{ id: string; lifecycle: string }>(
      'SELECT id, lifecycle FROM positions ORDER BY side',
    );
    expect(rows.rows.every((r) => r.lifecycle === 'OPEN')).toBe(true);
  });

  it('the same refusal holds when the closer holds SHORT and another user holds LONG (symmetry)', async () => {
    const burnCapture = { broadcasts: 0 };
    const service = makeService({ allowlist: [ALICE, BOB], burnCapture });
    await seedPosition(ALICE, 'LONG');
    const bobShort = await seedPosition(BOB, 'SHORT');

    await expect(
      service.closePosition({
        positionId: bobShort,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey: 'close-d1-sym',
      }),
    ).rejects.toBeInstanceOf(SolvencyGuardrailError);
    expect(burnCapture.broadcasts).toBe(0);
  });
});

describe('AC-2 — the guardrail does NOT block the whole-package / same-user close (Story 8.3 still works)', () => {
  async function openAndConfirm(service: PositionService): Promise<string> {
    await service.openPosition(openInput());
    const confirmed = await service.confirmOpen(mintedEvent(), { side: 'LONG' });
    return confirmed!.position!.id;
  }

  it('a whole-package position with NO opposite holder closes normally (paired burn submitted)', async () => {
    const burnCapture = { broadcasts: 0 };
    const service = makeService({ burnCapture });
    const positionId = await openAndConfirm(service);

    const view = await service.closePosition({
      positionId,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-ok',
    });
    // NOT blocked: the burn IS submitted (pending until commit) and the position confirms CLOSED.
    expect(view.status).toBe('pending');
    expect(view.txHash).toBe(BURN_HASH);
    expect(burnCapture.broadcasts).toBe(1);
    const closed = await service.confirmClose(burnedEvent());
    expect(closed!.position!.lifecycle).toBe('CLOSED');
  });

  it('the closer holding BOTH sides (same owner) does NOT trip the guardrail', async () => {
    const burnCapture = { broadcasts: 0 };
    const service = makeService({ burnCapture });
    // Same owner holds both an OPEN LONG and an OPEN SHORT — NOT the D1 topology (no other user).
    const aliceLong = await seedPosition(ALICE, 'LONG');
    await seedPosition(ALICE, 'SHORT');

    const view = await service.closePosition({
      positionId: aliceLong,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-same-owner',
    });
    expect(view.status).toBe('pending');
    expect(burnCapture.broadcasts).toBe(1);
  });

  it('a CLOSED opposite leg (no LIVE counterparty leg) does NOT trip the guardrail', async () => {
    const burnCapture = { broadcasts: 0 };
    const service = makeService({ allowlist: [ALICE, BOB], burnCapture });
    const aliceLong = await seedPosition(ALICE, 'LONG');
    const bobShort = await seedPosition(BOB, 'SHORT');
    // Bob's opposite leg is CLOSED (lifecycle transition only) — it is no longer a live counterparty.
    await closePositionRow(db, bobShort);

    const view = await service.closePosition({
      positionId: aliceLong,
      paymentAsset: PAYMENT_ASSET,
      idempotencyKey: 'close-closed-opp',
    });
    expect(view.status).toBe('pending');
    expect(burnCapture.broadcasts).toBe(1);
  });
});
