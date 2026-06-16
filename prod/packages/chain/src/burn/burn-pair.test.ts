// Story 5.4 — paired-burn orchestration + on-chain write, proven LOCALLY (NO Postgres, NO network).
// The on-chain write is exercised against a mock EIP-1193 transport (real viem signing/encoding, no
// Sepolia); the orchestration ordering uses an in-memory `OutboxStore` fake + a synthetic Story-5.1
// `PairBurnedEvent`. The success/quantity/balance assertions that need the DB live in
// `burn-pair-ledger.test.ts` (real local Postgres).
import { describe, expect, it, vi } from 'vitest';
import {
  custom,
  decodeFunctionData,
  getAddress,
  parseTransaction,
  type Address,
  type EIP1193RequestFn,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { OutboxEventRow, RoseDb, RoseExecutor } from '@rose/ledger';
import { coupledPairAbi } from '../abis/coupled-pair-abi.js';
import type { ChainConfig } from '../chain-config.js';
import { createRoseChainClients } from '../viem-clients.js';
import { OutboxSaga, type OutboxStore } from '../outbox/outbox-saga.js';
import type { PairBurnedArgs, PairBurnedEvent } from '../watchers.js';
import {
  BurnAuthorizationError,
  BurnPairDualWrite,
  BurnQuantityDivergenceError,
  InvalidPairAmountError,
  PairPlanError,
  encodeBurnPairCall,
  makeBurnPairLedgerEffect,
  submitBurnPair,
  type BurnLedgerPlan,
} from './burn-pair.js';

const PAIR: Address = '0x1111111111111111111111111111111111111111';
const L_FROM: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const S_FROM: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const OTHER: Address = getAddress('0xcccccccccccccccccccccccccccccccccccccccc');
// A throwaway, NON-secret, well-known test private key (Anvil/Hardhat account #0). NOT a real key,
// never used against a real network — only to sign a tx the mock transport echoes back locally.
const TEST_PK: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SENT_HASH: Hex = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface0';

function chainConfig(): ChainConfig {
  return {
    sepoliaRpcUrl: 'http://127.0.0.1:8545',
    pairAddress: PAIR,
    lTokenAddress: '0x2222222222222222222222222222222222222222',
    sTokenAddress: '0x3333333333333333333333333333333333333333',
    identityRegistryAddress: '0x4444444444444444444444444444444444444444',
  };
}

/**
 * A fake EIP-1193 provider answering the JSON-RPC methods viem issues to broadcast an EIP-1559
 * `writeContract` from a LOCAL account; `eth_sendRawTransaction` captures the signed raw tx, counts
 * broadcasts, and returns a deterministic hash. NO network, NO Sepolia.
 */
function mockWriteProvider(capture: { raw?: Hex; broadcasts: number }): {
  request: EIP1193RequestFn;
} {
  const request = (async ({ method, params }) => {
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
      case 'eth_sendRawTransaction': {
        capture.raw = (params as [Hex])[0];
        capture.broadcasts += 1;
        return SENT_HASH;
      }
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
  }) as EIP1193RequestFn;
  return { request };
}

function writeClients(capture: { raw?: Hex; broadcasts: number }) {
  return createRoseChainClients(chainConfig(), { transport: custom(mockWriteProvider(capture)) });
}

// ---- In-memory OutboxStore fake (mirrors the repository's idempotency + transition rules) ------

function makeRow(over: Partial<OutboxEventRow>): OutboxEventRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    idempotencyKey: over.idempotencyKey ?? 'op',
    operationKind: over.operationKind ?? 'PAIR_BURN',
    status: over.status ?? 'PENDING',
    payload: over.payload ?? {},
    txHash: over.txHash ?? null,
    journalEntryId: over.journalEntryId ?? null,
    lastError: over.lastError ?? null,
    attempts: over.attempts ?? 0,
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
  };
}

class FakeStore implements OutboxStore {
  readonly rows = new Map<string, OutboxEventRow>();
  async recordIntent(
    _db: RoseExecutor,
    input: {
      idempotencyKey: string;
      operationKind: 'PAIR_MINT' | 'PAIR_BURN';
      payload: Record<string, unknown>;
    },
  ): Promise<OutboxEventRow> {
    for (const r of this.rows.values()) if (r.idempotencyKey === input.idempotencyKey) return r;
    const row = makeRow({ ...input, status: 'PENDING' });
    this.rows.set(row.id, row);
    return row;
  }
  async recordSubmission(
    _db: RoseExecutor,
    input: { id: string; txHash: string },
  ): Promise<OutboxEventRow> {
    const row = this.rows.get(input.id)!;
    const next = { ...row, status: 'SUBMITTED' as const, txHash: input.txHash };
    this.rows.set(row.id, next);
    return next;
  }
  async markConfirmed(
    _db: RoseExecutor,
    input: { id: string; journalEntryId: string },
  ): Promise<OutboxEventRow> {
    const row = this.rows.get(input.id)!;
    const next = { ...row, status: 'CONFIRMED' as const, journalEntryId: input.journalEntryId };
    this.rows.set(row.id, next);
    return next;
  }
  async markFailed(
    _db: RoseExecutor,
    input: { id: string; error: string },
  ): Promise<OutboxEventRow> {
    const row = this.rows.get(input.id)!;
    const next = {
      ...row,
      status: 'FAILED' as const,
      lastError: input.error,
      attempts: row.attempts + 1,
    };
    this.rows.set(row.id, next);
    return next;
  }
  async markCompensated(_db: RoseExecutor, id: string): Promise<OutboxEventRow> {
    const row = this.rows.get(id)!;
    const next = { ...row, status: 'COMPENSATED' as const };
    this.rows.set(id, next);
    return next;
  }
  async findByTxHash(_db: RoseExecutor, txHash: string): Promise<OutboxEventRow | null> {
    for (const r of this.rows.values()) if (r.txHash === txHash) return r;
    return null;
  }
  async findByTxHashForUpdate(db: RoseExecutor, txHash: string): Promise<OutboxEventRow | null> {
    return this.findByTxHash(db, txHash);
  }
  async listByStatus(
    _db: RoseExecutor,
    status: OutboxEventRow['status'],
  ): Promise<OutboxEventRow[]> {
    return [...this.rows.values()].filter((r) => r.status === status);
  }
  readonly stampJournalEntryTxHash = vi.fn(async () => {});
}

function makeFakeDb(): RoseDb {
  return {
    transaction: async <T>(fn: (tx: RoseExecutor) => Promise<T>): Promise<T> =>
      fn({} as RoseExecutor),
  } as unknown as RoseDb;
}

const PAIR_ID = '11111111-1111-1111-1111-111111111111';
const VALID_PAYLOAD = { coupledPairId: PAIR_ID, lFrom: L_FROM, sFrom: S_FROM, amount: '1000' };

function plan(): BurnLedgerPlan {
  return {
    description: 'burn pair',
    longLeg: { holderAccountId: 'lh', supplyAccountId: 'ls' },
    shortLeg: { holderAccountId: 'sh', supplyAccountId: 'ss' },
  };
}

function onChain(over: Partial<PairBurnedArgs> = {}): PairBurnedArgs {
  return { lFrom: L_FROM, sFrom: S_FROM, amount: 1000n, ...over };
}

// ---- Tests -----------------------------------------------------------------------------------

describe('encodeBurnPairCall (AC-1, the on-chain call shape)', () => {
  it('encodes burnPair(lFrom, sFrom, amount) for the pair address', () => {
    const { address, data } = encodeBurnPairCall({
      pairAddress: PAIR,
      lFrom: L_FROM,
      sFrom: S_FROM,
      amount: 1000n,
    });
    expect(address).toBe(PAIR);
    const decoded = decodeFunctionData({ abi: coupledPairAbi, data });
    expect(decoded.functionName).toBe('burnPair');
    expect(decoded.args[0]).toBe(L_FROM);
    expect(decoded.args[1]).toBe(S_FROM);
    expect(decoded.args[2]).toBe(1000n);
    expect(typeof decoded.args[2]).toBe('bigint');
  });

  it('rejects a non-positive amount (NFR-2)', () => {
    expect(() =>
      encodeBurnPairCall({ pairAddress: PAIR, lFrom: L_FROM, sFrom: S_FROM, amount: 0n }),
    ).toThrow(InvalidPairAmountError);
  });

  it('rejects an amount above uint256 max (NFR-2)', () => {
    expect(() =>
      encodeBurnPairCall({ pairAddress: PAIR, lFrom: L_FROM, sFrom: S_FROM, amount: 2n ** 256n }),
    ).toThrow(InvalidPairAmountError);
  });
});

describe('submitBurnPair (AC-1, the saga submit port — mock transport, no network)', () => {
  it('signs+broadcasts a burnPair tx to the pair and returns its hash', async () => {
    const capture: { raw?: Hex; broadcasts: number } = { broadcasts: 0 };
    const clients = writeClients(capture);
    const account = privateKeyToAccount(TEST_PK);

    const { txHash } = await submitBurnPair(clients, account, {
      pairAddress: PAIR,
      lFrom: L_FROM,
      sFrom: S_FROM,
      amount: 1000n,
    });
    expect(txHash).toBe(SENT_HASH);

    const tx = parseTransaction(capture.raw!);
    expect(tx.to?.toLowerCase()).toBe(PAIR.toLowerCase());
    const decoded = decodeFunctionData({ abi: coupledPairAbi, data: tx.data! });
    expect(decoded.functionName).toBe('burnPair');
    expect(decoded.args[2]).toBe(1000n);
  });

  it('rejects a non-positive amount before any write (NFR-2)', async () => {
    const clients = writeClients({ broadcasts: 0 });
    const account = privateKeyToAccount(TEST_PK);
    await expect(
      submitBurnPair(clients, account, {
        pairAddress: PAIR,
        lFrom: L_FROM,
        sFrom: S_FROM,
        amount: -1n,
      }),
    ).rejects.toBeInstanceOf(InvalidPairAmountError);
  });
});

describe('BurnPairDualWrite.start (AC-1 + auth pre-submit, idempotent, no double-broadcast)', () => {
  function mkBurn(capture: { raw?: Hex; broadcasts: number }) {
    const store = new FakeStore();
    const saga = new OutboxSaga({ db: makeFakeDb(), store });
    const burn = new BurnPairDualWrite({
      saga,
      clients: writeClients(capture),
      account: privateKeyToAccount(TEST_PK),
    });
    return { store, burn };
  }
  const baseRequest = {
    idempotencyKey: 'burn-1',
    coupledPairId: PAIR_ID,
    pairAddress: PAIR,
    lFrom: L_FROM,
    sFrom: S_FROM,
    amount: 1000n,
  };

  it('records a PAIR_BURN intent (PENDING) then submits on-chain (SUBMITTED, tx hash recorded)', async () => {
    const capture = { broadcasts: 0 };
    const { store, burn } = mkBurn(capture);

    const { outbox, txHash, alreadyStarted } = await burn.start(baseRequest);

    expect(txHash).toBe(SENT_HASH);
    expect(alreadyStarted).toBe(false);
    expect(outbox.status).toBe('SUBMITTED');
    expect(outbox.operationKind).toBe('PAIR_BURN');
    expect(outbox.journalEntryId).toBeNull(); // no ledger effect at submission
    expect(store.stampJournalEntryTxHash).not.toHaveBeenCalled();
    expect(capture.broadcasts).toBe(1);
  });

  it('does NOT re-broadcast a duplicate burn when start is retried with the same key (idempotent)', async () => {
    const capture = { broadcasts: 0 };
    const { burn } = mkBurn(capture);

    const first = await burn.start(baseRequest);
    const second = await burn.start(baseRequest); // retry / key reuse

    expect(first.alreadyStarted).toBe(false);
    expect(second.alreadyStarted).toBe(true);
    expect(second.txHash).toBe(SENT_HASH);
    expect(capture.broadcasts).toBe(1); // critical: only ONE on-chain burn
  });

  it('vetoes the dual-write BEFORE any on-chain burn when authorization denies (fail-closed)', async () => {
    const capture = { broadcasts: 0 };
    const { store, burn } = mkBurn(capture);
    await expect(
      burn.start({ ...baseRequest, authorize: () => ({ effect: 'DENY', reason: 'no' }) }),
    ).rejects.toBeInstanceOf(BurnAuthorizationError);
    expect(capture.broadcasts).toBe(0); // no burn
    expect([...store.rows.values()]).toHaveLength(0); // no intent recorded
  });

  it('rejects a non-positive amount before recording any intent', async () => {
    const capture = { broadcasts: 0 };
    const { store, burn } = mkBurn(capture);
    await expect(burn.start({ ...baseRequest, amount: 0n })).rejects.toBeInstanceOf(
      InvalidPairAmountError,
    );
    expect([...store.rows.values()]).toHaveLength(0);
    expect(capture.broadcasts).toBe(0);
  });
});

describe('makeBurnPairLedgerEffect guards (AC-2, throws before any write)', () => {
  // These guards throw BEFORE `recordJournalEntry`, so a never-touched executor proves nothing posts.
  const neverExecutor = {} as RoseExecutor;
  const ctx = (payload: unknown) => ({
    outboxId: 'o',
    operationKind: 'PAIR_BURN' as const,
    payload,
    txHash: '0xabc',
  });

  it('throws on an amount divergence between intent and the on-chain event (NFR-9)', async () => {
    const effect = makeBurnPairLedgerEffect(onChain({ amount: 1000n }), plan());
    await expect(
      effect(neverExecutor, ctx({ ...VALID_PAYLOAD, amount: '999' })),
    ).rejects.toBeInstanceOf(BurnQuantityDivergenceError);
  });

  it('throws on a sender divergence (intent lFrom != on-chain lFrom) (NFR-9)', async () => {
    const effect = makeBurnPairLedgerEffect(onChain({ lFrom: OTHER }), plan());
    await expect(effect(neverExecutor, ctx(VALID_PAYLOAD))).rejects.toBeInstanceOf(
      BurnQuantityDivergenceError,
    );
  });

  it('throws on a sender divergence (intent sFrom != on-chain sFrom), flagging the sFrom field (NFR-9)', async () => {
    const effect = makeBurnPairLedgerEffect(onChain({ sFrom: OTHER }), plan());
    await expect(effect(neverExecutor, ctx(VALID_PAYLOAD))).rejects.toMatchObject({
      name: 'BurnQuantityDivergenceError',
      field: 'sFrom',
    });
  });

  it('throws a PairPlanError when a value posting collides with a quantity-leg account', async () => {
    const effect = makeBurnPairLedgerEffect(onChain(), {
      ...plan(),
      value: { postings: [{ accountId: 'lh', direction: 'DEBIT', amount: 5n }] },
    });
    await expect(effect(neverExecutor, ctx(VALID_PAYLOAD))).rejects.toBeInstanceOf(PairPlanError);
  });

  it('throws a PairPlanError when two quantity legs share an account', async () => {
    const effect = makeBurnPairLedgerEffect(onChain(), {
      description: 'dup',
      longLeg: { holderAccountId: 'lh', supplyAccountId: 'ls' },
      shortLeg: { holderAccountId: 'lh', supplyAccountId: 'ss' }, // 'lh' reused
    });
    await expect(effect(neverExecutor, ctx(VALID_PAYLOAD))).rejects.toBeInstanceOf(PairPlanError);
  });

  it('throws on a non-positive on-chain amount', async () => {
    const effect = makeBurnPairLedgerEffect(onChain({ amount: 0n }), plan());
    await expect(effect(neverExecutor, ctx(VALID_PAYLOAD))).rejects.toBeInstanceOf(
      InvalidPairAmountError,
    );
  });

  it('rejects a malformed intent payload (zod)', async () => {
    const effect = makeBurnPairLedgerEffect(onChain(), plan());
    await expect(effect(neverExecutor, ctx({ amount: '1000' }))).rejects.toBeTruthy();
  });
});

describe('confirm ordering with a synthetic event (AC-1)', () => {
  it('keys the confirm off the PairBurned tx hash + on-chain amount', async () => {
    const store = new FakeStore();
    const saga = new OutboxSaga({ db: makeFakeDb(), store });
    const intent = await saga.recordIntent({
      idempotencyKey: 'burn-evt',
      operationKind: 'PAIR_BURN',
      payload: VALID_PAYLOAD,
    });
    await saga.submit(intent.id, async () => ({ txHash: '0xevent' }));

    const effect = vi.fn(async () => ({ journalEntryId: 'je-evt' }));
    const event: PairBurnedEvent = {
      eventName: 'PairBurned',
      args: { lFrom: L_FROM, sFrom: S_FROM, amount: 1000n },
      address: PAIR,
      blockNumber: 10n,
      transactionHash: '0xevent',
      logIndex: 0,
    };
    const result = await saga.confirmFromEvent(event, effect);
    expect(result?.applied).toBe(true);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
