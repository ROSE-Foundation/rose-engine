// Story 6.4 — the paper/testnet coupled-pair strategy execution loop proven END-TO-END against the
// LOCAL Postgres + a mock EIP-1193 transport + a SYNTHETIC confirmed `PairBurned` (NO Sepolia, NO
// network port, NO key, NO real price feed). The headline FR-20 proof:
//   AC-1: a floor breach drives a reset; ONE balanced journal entry tagged to TRADING_CO is posted
//         ONLY at the on-chain commit point; the realized P&L is reflected in the group view + NAV and
//         the ledger token quantity reconciles to the post-burn on-chain supply (NFR-9).
//   AC-3: threshold-only — a within-barrier tick (and repeated/"later" ticks) is a strict no-op.
//   AC-4: the parked floor m/g are refuse-if-absent via @rose/config (ConfigRefusalError).
//   AC-5: fail-closed authorization pre-write (pair left ACTIVE); idempotent (NFR-9); confirm never throws.
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
  getCoupledPair,
  hardReset,
  migrateUp,
  recordIntent,
  recordJournalEntry,
  type RoseDb,
} from '@rose/ledger';
import {
  BurnAuthorizationError,
  BurnPairDualWrite,
  OutboxSaga,
  createRoseChainClients,
  type BurnAuthorizationGate,
  type ChainConfig,
  type PairBurnedEvent,
} from '@rose/chain';
import { buildGroupView, type ChainSupplySnapshot } from '@rose/reconcile';
import { ConfigRefusalError, loadConfig } from '@rose/config';
import {
  InvalidStrategyResetError,
  makeStrategyExecutor,
  StrategyResetIdempotencyConflictError,
  type StrategyExecutor,
  type StrategyResetTopology,
} from './index.js';

const ALICE: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const PAIR_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
// A throwaway, NON-secret, well-known test key (Anvil account #0). NEVER used against a real network.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENT_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000fed';
const PAYMENT_ASSET = 'EUR';

// K = 20000 ⇒ K/2 = 10000; floor f = m·L·g = 0.5·3·0.4 = 0.6 ⇒ floorUnits = 6000.
const K = 20_000n;
const HALF_K = 10_000n;
const INITIAL = 20_000n; // pre-existing minted position per leg
const FLOOR = { modelFloorM: '0.5', modelFloorG: '0.4' };
const LEVERAGE = '3';
const FLOOR_UNITS = 6000n;
const RESET_PRICE = '1.25000000';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;
let topology: StrategyResetTopology;
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

function makeExecutor(over?: {
  authorize?: BurnAuthorizationGate;
  capture?: { broadcasts: number };
}): StrategyExecutor {
  const capture = over?.capture ?? { broadcasts: 0 };
  const saga = new OutboxSaga({ db });
  const clients = createRoseChainClients(chainConfig(), {
    transport: custom(mockWriteProvider(capture)),
  });
  const burn = new BurnPairDualWrite({ saga, clients, account: privateKeyToAccount(TEST_PK) });
  return makeStrategyExecutor({
    db,
    burn,
    pairAddress: PAIR_ADDRESS,
    authorize: over?.authorize ?? (() => ({ effect: 'ALLOW', reason: 'paper-allow' })),
    topology,
    paymentAsset: PAYMENT_ASSET,
    positionHolder: ALICE,
    floor: FLOOR,
  });
}

function burnedEvent(amount: bigint, txHash: Hex = SENT_HASH): PairBurnedEvent {
  return {
    eventName: 'PairBurned',
    args: { lFrom: ALICE, sFrom: ALICE, amount },
    address: PAIR_ADDRESS,
    blockNumber: 202n,
    transactionHash: txHash,
    logIndex: 0,
  };
}

const withinBarrier = (key: string) => ({
  pairId,
  price: '1.10000000',
  longLegMarkValue: 9_000n,
  shortLegMarkValue: 11_000n,
  paymentAsset: PAYMENT_ASSET,
  resetIdempotencyKey: key,
});

const breachTick = (key: string, longMark = 5_000n) => ({
  pairId,
  price: RESET_PRICE,
  longLegMarkValue: longMark,
  shortLegMarkValue: 15_000n,
  paymentAsset: PAYMENT_ASSET,
  resetIdempotencyKey: key,
});

async function count(table: 'journal_entries' | 'postings' | 'outbox_events'): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0]!.n;
}

async function balanceOf(accountId: string): Promise<bigint> {
  const r = await pool.query<{ bal: string }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS bal
       FROM postings WHERE account_id = $1`,
    [accountId],
  );
  return BigInt(r.rows[0]!.bal);
}

let tradingIncomeId: string;

/** Seed a pre-existing minted position (INITIAL) on both token legs — one balanced entry. */
async function seedMintedPosition(amount: bigint): Promise<void> {
  await recordJournalEntry(db, {
    description: 'seed — pre-existing minted position (test fixture)',
    coupledPairId: pairId,
    postings: [
      { accountId: topology.longLegHolderAccountId, direction: 'DEBIT', amount },
      { accountId: topology.longLegSupplyAccountId, direction: 'CREDIT', amount },
      { accountId: topology.shortLegHolderAccountId, direction: 'DEBIT', amount },
      { accountId: topology.shortLegSupplyAccountId, direction: 'CREDIT', amount },
    ],
  });
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);

  // Token legs: ASSET-classified holders (circulating) + NON-ASSET supply contras (mirror 5.4/6.3).
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
  // TRADING_CO P&L accounts (EUR): DEPLOYED_CAPITAL (ASSET) + FEE_INCOME (EQUITY) — the executing entity.
  const tcoDeployed = await createAccount(db, {
    entityCode: 'TRADING_CO',
    type: 'DEPLOYED_CAPITAL',
    asset: PAYMENT_ASSET,
    decimalScale: 2,
  });
  const tcoIncome = await createAccount(db, {
    entityCode: 'TRADING_CO',
    type: 'FEE_INCOME',
    asset: PAYMENT_ASSET,
    decimalScale: 2,
  });
  tradingIncomeId = tcoIncome.id;
  topology = {
    longLegHolderAccountId: lHolder.id,
    longLegSupplyAccountId: lSupply.id,
    shortLegHolderAccountId: sHolder.id,
    shortLegSupplyAccountId: sSupply.id,
    tradingPnlAssetAccountId: tcoDeployed.id,
    tradingPnlIncomeAccountId: tcoIncome.id,
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
    leverage: LEVERAGE,
    collateralPool: K,
    floor: '0.6',
    longLegValue: HALF_K,
    shortLegValue: HALF_K,
    state: 'ACTIVE',
  });
  pairId = pair.id;
  await createRoseNote(db, { coupledPairId: pairId });
  await seedMintedPosition(INITIAL);
});

describe('AC-4 — parked floor m/g are refuse-if-absent (@rose/config, NFR-4)', () => {
  it('loadConfig refuses when MODEL_FLOOR_M / MODEL_FLOOR_G are absent (never defaults)', () => {
    try {
      loadConfig({});
      throw new Error('expected ConfigRefusalError');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigRefusalError);
      expect((e as ConfigRefusalError).missingOrInvalid).toEqual(
        expect.arrayContaining(['MODEL_FLOOR_M', 'MODEL_FLOOR_G']),
      );
    }
  });
});

describe('AC-3 — threshold-only: a within-barrier tick is a strict no-op (never a clock)', () => {
  it('does nothing within the barrier — no transition, no outbox row, no journal entry', async () => {
    const executor = makeExecutor();
    const outcome = await executor.onTick(withinBarrier('noop-1'));
    expect(outcome.action).toBe('none');
    expect(outcome.reason).toBe('within-barrier');
    expect(outcome.losingLeg).toBeNull();
    expect(outcome.floorUnits).toBe(FLOOR_UNITS);
    expect(outcome.state).toBe('ACTIVE');
    expect(await count('outbox_events')).toBe(0);
    expect(await count('journal_entries')).toBe(1); // only the seed
  });

  it('repeated and "later" within-barrier ticks still do nothing (event-driven, not time-driven)', async () => {
    const executor = makeExecutor();
    await executor.onTick(withinBarrier('noop-a'));
    await executor.onTick(withinBarrier('noop-b'));
    await executor.onTick(withinBarrier('noop-c'));
    expect(await count('outbox_events')).toBe(0);
    expect((await getCoupledPair(db, pairId))!.state).toBe('ACTIVE');
  });
});

describe('AC-1/AC-5 — floor breach drives a reset; commit-point entry tagged to TRADING_CO', () => {
  it('a breach starts a reset: pair → REBALANCING, tx hash, NO journal entry yet (no optimistic success)', async () => {
    const executor = makeExecutor();
    const outcome = await executor.onTick(breachTick('reset-1'));
    expect(outcome.action).toBe('reset-started');
    expect(outcome.reason).toBe('floor-breach');
    expect(outcome.losingLeg).toBe('long');
    expect(outcome.state).toBe('REBALANCING');
    expect(outcome.txHash).toBe(SENT_HASH);
    expect(outcome.resetId).toBe('reset-1');
    expect((await getCoupledPair(db, pairId))!.state).toBe('REBALANCING');
    // No commit-point entry yet (only the seed); one outbox row (the PAIR_BURN intent).
    expect(await count('journal_entries')).toBe(1);
    expect(await count('outbox_events')).toBe(1);
    const burnEntries = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(burnEntries.rows[0]!.n).toBe(0);
  });

  it('confirmReset posts ONE balanced entry (P&L → TRADING_CO), re-bases the pair, returns to ACTIVE', async () => {
    const executor = makeExecutor();
    await executor.onTick(breachTick('reset-1')); // resetDelta = HALF_K - 5000 = 5000
    const resetDelta = HALF_K - 5_000n;

    const view = await executor.confirmReset(burnedEvent(resetDelta));
    expect(view).not.toBeNull();
    expect(view!.status).toBe('confirmed');
    expect(view!.journalEntryId).not.toBeNull();

    // Exactly ONE commit-point entry (tx-hash-stamped), linked to the pair (NFR-3).
    const je = await pool.query<{ id: string; coupled_pair_id: string }>(
      'SELECT id, coupled_pair_id FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(je.rows).toHaveLength(1);
    expect(je.rows[0]!.coupled_pair_id).toBe(pairId);
    // seed + reset entry = 2 entries, 4 (seed) + 6 (reset) = 10 postings.
    expect(await count('journal_entries')).toBe(2);
    expect(await count('postings')).toBe(10);

    // The token legs are RETIRED (holder CREDITED) and the realized P&L is tagged to TRADING_CO's
    // FEE_INCOME (a credit-normal EQUITY account ⇒ net = +resetDelta) — AC-1.
    expect(await balanceOf(topology.longLegHolderAccountId)).toBe(INITIAL - resetDelta);
    expect(await balanceOf(topology.shortLegHolderAccountId)).toBe(INITIAL - resetDelta);
    expect(await balanceOf(tradingIncomeId)).toBe(-resetDelta); // CREDIT balance (signed DEBIT−CREDIT)

    // The pair is re-based symmetrically (V_A = V_B = K/2) and re-anchored, back to ACTIVE.
    const pair = (await getCoupledPair(db, pairId))!;
    expect(pair.state).toBe('ACTIVE');
    expect(pair.anchorPrice).toBe(RESET_PRICE);
    expect(pair.longLegValue).toBe(HALF_K);
    expect(pair.shortLegValue).toBe(HALF_K);
    expect(pair.longLegValue + pair.shortLegValue).toBe(pair.collateralPool);
  });

  it('reflects the realized P&L in the group view + NAV; ledger reconciles to post-burn supply (NFR-9)', async () => {
    const executor = makeExecutor();
    await executor.onTick(breachTick('reset-1'));
    const resetDelta = HALF_K - 5_000n;
    await executor.confirmReset(burnedEvent(resetDelta));

    const remaining = INITIAL - resetDelta;
    const snapshot: ChainSupplySnapshot = {
      source: 'ledger+chain',
      tokens: [
        { asset: 'ROSE_L', scale: 0, totalSupply: remaining },
        { asset: 'ROSE_S', scale: 0, totalSupply: remaining },
      ],
    };
    const view = await buildGroupView(db, { chainSupplies: snapshot });

    // The realized P&L is attributed to the executing entity TRADING_CO (FEE_INCOME, EUR).
    const tco = view.entities.find((e) => e.entityCode === 'TRADING_CO')!;
    const fee = tco.accounts.find((a) => a.type === 'FEE_INCOME' && a.asset === PAYMENT_ASSET)!;
    expect(fee.net.smallestUnits).toBe(resetDelta.toString());

    // It accrues to the consolidated group NAV (EUR): assets (DEPLOYED_CAPITAL) − liabilities = P&L.
    const eur = view.consolidated.find((c) => c.asset === PAYMENT_ASSET && c.scale === 2)!;
    expect(eur.nav.smallestUnits).toBe(resetDelta.toString());

    // Token quantity reconciles to the post-burn on-chain supply (NFR-9 — no divergence).
    expect(view.chainComparison.anyDivergence).toBe(false);
  });
});

describe('AC-5 — fail-closed authorization (pre-write): DENY leaves the pair ACTIVE', () => {
  it('throws BurnAuthorizationError before any burn; nothing recorded; pair stays ACTIVE', async () => {
    const capture = { broadcasts: 0 };
    const executor = makeExecutor({
      capture,
      authorize: () => ({ effect: 'DENY', reason: 'not authorized' }),
    });
    await expect(executor.onTick(breachTick('reset-deny'))).rejects.toBeInstanceOf(
      BurnAuthorizationError,
    );
    expect(capture.broadcasts).toBe(0);
    expect(await count('outbox_events')).toBe(0);
    expect((await getCoupledPair(db, pairId))!.state).toBe('ACTIVE'); // no dangling REBALANCING
  });
});

describe('code-review hardening — invalid re-anchor price refused up-front (no stranded REBALANCING)', () => {
  it('rejects an over-precision price BEFORE any burn; pair stays ACTIVE, nothing written', async () => {
    const capture = { broadcasts: 0 };
    const executor = makeExecutor({ capture });
    // 9 fractional digits exceeds the anchor column's frozen scale (8) — must be caught at onTick,
    // never at confirmReset after the irreversible burn has already posted (the Blind/Edge High).
    await expect(
      executor.onTick({ ...breachTick('reset-badprice'), price: '1.123456789' }),
    ).rejects.toBeInstanceOf(InvalidStrategyResetError);
    expect(capture.broadcasts).toBe(0);
    expect(await count('outbox_events')).toBe(0);
    expect((await getCoupledPair(db, pairId))!.state).toBe('ACTIVE');
  });

  it('rejects a negative / zero price up-front too', async () => {
    const executor = makeExecutor();
    await expect(
      executor.onTick({ ...breachTick('reset-negprice'), price: '-1.5' }),
    ).rejects.toBeInstanceOf(InvalidStrategyResetError);
    await expect(
      executor.onTick({ ...breachTick('reset-zeroprice'), price: '0' }),
    ).rejects.toBeInstanceOf(InvalidStrategyResetError);
    expect((await getCoupledPair(db, pairId))!.state).toBe('ACTIVE');
  });
});

describe('NFR-9 — idempotency: a retried reset does not re-burn / re-transition', () => {
  it('returns the existing reset and broadcasts only once', async () => {
    const capture = { broadcasts: 0 };
    const executor = makeExecutor({ capture });
    const first = await executor.onTick(breachTick('reset-idem'));
    const second = await executor.onTick(breachTick('reset-idem'));
    expect(first.txHash).toBe(SENT_HASH);
    expect(second.action).toBe('reset-started');
    expect(second.reason).toBe('idempotent-replay');
    expect(second.txHash).toBe(SENT_HASH);
    expect(capture.broadcasts).toBe(1);
    expect(await count('outbox_events')).toBe(1);
  });

  it('rejects a reused reset key whose request differs (no silent stranger-reset, 409)', async () => {
    const executor = makeExecutor();
    await executor.onTick(breachTick('reset-conflict', 5_000n)); // resetDelta = 5000
    await expect(
      executor.onTick(breachTick('reset-conflict', 4_000n)), // resetDelta = 6000 (mismatch)
    ).rejects.toBeInstanceOf(StrategyResetIdempotencyConflictError);
  });
});

describe('getReset / confirm-never-throws / row-kind guard', () => {
  it('reads pending after onTick and confirmed after confirmReset', async () => {
    const executor = makeExecutor();
    await executor.onTick(breachTick('reset-read'));
    const pending = await executor.getReset('reset-read');
    expect(pending!.status).toBe('pending');
    expect(pending!.journalEntryId).toBeNull();

    await executor.confirmReset(burnedEvent(HALF_K - 5_000n));
    const confirmed = await executor.getReset('reset-read');
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.journalEntryId).not.toBeNull();
    expect(confirmed!.pairId).toBe(pairId);
  });

  it('confirmReset NEVER throws on a malformed event (non-positive amount) — returns null, posts nothing', async () => {
    const executor = makeExecutor();
    await executor.onTick(breachTick('reset-bad'));
    const outcome = await executor.confirmReset(burnedEvent(0n));
    expect(outcome).toBeNull();
    const burnEntries = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE tx_hash = $1',
      [SENT_HASH],
    );
    expect(burnEntries.rows[0]!.n).toBe(0);
    // The pair stays REBALANCING (left for reconcile 5.6 — nothing was committed).
    expect((await getCoupledPair(db, pairId))!.state).toBe('REBALANCING');
  });

  it('getReset returns null for a non-PAIR_BURN (PAIR_MINT) outbox row', async () => {
    await recordIntent(db, {
      idempotencyKey: 'mint-key',
      operationKind: 'PAIR_MINT',
      payload: { coupledPairId: pairId, lTo: ALICE, sTo: ALICE, amount: '500' },
    });
    const executor = makeExecutor();
    expect(await executor.getReset('mint-key')).toBeNull();
    expect(await executor.getReset('does-not-exist')).toBeNull();
  });
});
