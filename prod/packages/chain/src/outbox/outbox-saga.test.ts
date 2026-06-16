// Story 5.2 — the outbox/saga orchestration invariants, proven LOCALLY with in-memory fakes and
// synthetic Story 5.1 `ChainEvent`s (NO Postgres, NO network, NO wallet key). Proves the three
// consistency invariants (NFR-9 / NFR-3): (1) commit-point ordering — the LedgerEffect is NEVER
// invoked before `confirm` and IS invoked exactly once on confirm; (2) idempotent replay — the same
// confirmed tx hash applies the effect once (reorg / watcher re-delivery safe); (3) compensation —
// a FAILED row never triggers a LedgerEffect; plus the resume seam for 5.6.
import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventRow, RoseDb, RoseExecutor } from '@rose/ledger';
import { OutboxSaga, type LedgerEffect, type OutboxStore } from './outbox-saga.js';
import type { PairMintedEvent } from '../watchers.js';

// ---- In-memory fakes -------------------------------------------------------------------------

function makeRow(over: Partial<OutboxEventRow>): OutboxEventRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    idempotencyKey: over.idempotencyKey ?? 'op',
    operationKind: over.operationKind ?? 'PAIR_MINT',
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

/** An in-memory OutboxStore that mirrors the repository's idempotency + transition rules. */
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
    for (const r of this.rows.values()) {
      if (r.idempotencyKey === input.idempotencyKey) return r; // idempotent
    }
    const row = makeRow({ ...input, status: 'PENDING' });
    this.rows.set(row.id, row);
    return row;
  }

  async recordSubmission(
    _db: RoseExecutor,
    input: { id: string; txHash: string },
  ): Promise<OutboxEventRow> {
    const row = this.rows.get(input.id)!;
    for (const r of this.rows.values()) {
      if (r.id !== row.id && r.txHash === input.txHash) {
        throw new Error('duplicate tx hash');
      }
    }
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

  // In-memory fake is single-threaded; the FOR UPDATE lock is a no-op here (concurrency is proven
  // by the DB-level constraints/locks in the ledger repo, not in these orchestration unit tests).
  async findByTxHashForUpdate(_db: RoseExecutor, txHash: string): Promise<OutboxEventRow | null> {
    return this.findByTxHash(_db, txHash);
  }

  async listByStatus(
    _db: RoseExecutor,
    status: OutboxEventRow['status'],
  ): Promise<OutboxEventRow[]> {
    return [...this.rows.values()].filter((r) => r.status === status);
  }

  // Declared param-less so unused-args lint is satisfied; vi.fn still records the call arguments.
  readonly stampJournalEntryTxHash = vi.fn(async () => {});
}

/** A fake RoseDb whose `transaction(fn)` runs `fn` with a sentinel executor (no real DB). */
function makeFakeDb(): RoseDb {
  const tx = {} as RoseExecutor;
  return {
    transaction: async <T>(fn: (tx: RoseExecutor) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as RoseDb;
}

function makeSaga(store: FakeStore): OutboxSaga {
  return new OutboxSaga({ db: makeFakeDb(), store });
}

// ---- Tests -----------------------------------------------------------------------------------

describe('AC-1 — the on-chain tx is the commit point (ordering)', () => {
  it('never posts the ledger effect before confirmation, and posts it exactly once on confirm', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);
    const effect: LedgerEffect = vi.fn(async () => ({ journalEntryId: 'je-1' }));

    const intent = await saga.recordIntent({
      idempotencyKey: 'mint-1',
      operationKind: 'PAIR_MINT',
      payload: { amount: '1000' },
    });
    // After intent: no effect, no tx, no journal entry.
    expect(effect).not.toHaveBeenCalled();
    expect(store.rows.get(intent.id)!.status).toBe('PENDING');

    await saga.submit(intent.id, async () => ({ txHash: '0xmint1' }));
    // After submit: still no ledger effect (submission is NOT the commit point).
    expect(effect).not.toHaveBeenCalled();
    expect(store.rows.get(intent.id)!.status).toBe('SUBMITTED');

    const result = await saga.confirm('0xmint1', effect);
    // Confirm is the commit point: the effect ran exactly once and the row is CONFIRMED.
    expect(effect).toHaveBeenCalledTimes(1);
    expect(result?.applied).toBe(true);
    expect(result?.row.status).toBe('CONFIRMED');
    expect(result?.row.journalEntryId).toBe('je-1');
    expect(store.stampJournalEntryTxHash).toHaveBeenCalledWith(expect.anything(), {
      journalEntryId: 'je-1',
      txHash: '0xmint1',
    });
  });

  it('confirm returns null when no outbox row matches the tx hash', async () => {
    const saga = makeSaga(new FakeStore());
    const effect: LedgerEffect = vi.fn(async () => ({ journalEntryId: 'je' }));
    expect(await saga.confirm('0xunknown', effect)).toBeNull();
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('AC-2 — idempotent replay (reorg / watcher re-delivery safe)', () => {
  it('applies the ledger effect once even if the same confirmed tx is delivered twice', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);
    const effect: LedgerEffect = vi.fn(async () => ({ journalEntryId: 'je-replay' }));

    const intent = await saga.recordIntent({
      idempotencyKey: 'mint-replay',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await saga.submit(intent.id, async () => ({ txHash: '0xreplay' }));

    const first = await saga.confirm('0xreplay', effect);
    const second = await saga.confirm('0xreplay', effect); // replay

    expect(effect).toHaveBeenCalledTimes(1);
    expect(first?.applied).toBe(true);
    expect(second?.applied).toBe(false);
    expect(second?.row.status).toBe('CONFIRMED');
  });

  it('confirmFromEvent drives confirm off a Story 5.1 ChainEvent transactionHash', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);
    const effect: LedgerEffect = vi.fn(async () => ({ journalEntryId: 'je-evt' }));

    const intent = await saga.recordIntent({
      idempotencyKey: 'mint-evt',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await saga.submit(intent.id, async () => ({ txHash: '0xevent' }));

    const event: PairMintedEvent = {
      eventName: 'PairMinted',
      args: {
        lTo: '0x0000000000000000000000000000000000000001',
        sTo: '0x0000000000000000000000000000000000000002',
        amount: 1000n,
      },
      address: '0x0000000000000000000000000000000000000003',
      blockNumber: 10n,
      transactionHash: '0xevent',
      logIndex: 0,
    };
    const result = await saga.confirmFromEvent(event, effect);
    expect(result?.applied).toBe(true);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('confirmFromEvent skips an event without a tx hash', async () => {
    const saga = makeSaga(new FakeStore());
    const effect: LedgerEffect = vi.fn(async () => ({ journalEntryId: 'je' }));
    const event = {
      eventName: 'PairMinted',
      args: {},
      address: '0x0000000000000000000000000000000000000003',
      blockNumber: null,
      transactionHash: null,
      logIndex: null,
    } as unknown as PairMintedEvent;
    expect(await saga.confirmFromEvent(event, effect)).toBeNull();
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('AC-2/AC-3 — failure, compensation, and recovery', () => {
  it('a failed submit marks the row FAILED and never posts a ledger effect', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);

    const intent = await saga.recordIntent({
      idempotencyKey: 'mint-fail',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await expect(
      saga.submit(intent.id, async () => {
        throw new Error('broadcast rejected');
      }),
    ).rejects.toThrow('broadcast rejected');

    expect(store.rows.get(intent.id)!.status).toBe('FAILED');
    expect(store.stampJournalEntryTxHash).not.toHaveBeenCalled();
  });

  it('compensate moves FAILED -> COMPENSATED without any ledger effect', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);
    const intent = await saga.recordIntent({
      idempotencyKey: 'burn-comp',
      operationKind: 'PAIR_BURN',
      payload: {},
    });
    await saga.fail(intent.id, 'tx reverted');
    const comp = await saga.compensate(intent.id);
    expect(comp.status).toBe('COMPENSATED');
    expect(store.stampJournalEntryTxHash).not.toHaveBeenCalled();
  });

  it('confirm on a FAILED row whose tx later matches is a no-op (no effect, no throw)', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);
    const effect: LedgerEffect = vi.fn(async () => ({ journalEntryId: 'je-anomaly' }));

    const intent = await saga.recordIntent({
      idempotencyKey: 'mint-anom',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await saga.submit(intent.id, async () => ({ txHash: '0xanom' }));
    // The tx is timed-out/failed while SUBMITTED (hash retained), then actually confirms on-chain.
    await store.markFailed({} as RoseExecutor, { id: intent.id, error: 'timed out' });

    const result = await saga.confirm('0xanom', effect);
    expect(result?.applied).toBe(false);
    expect(result?.row.status).toBe('FAILED');
    expect(effect).not.toHaveBeenCalled();
    expect(store.stampJournalEntryTxHash).not.toHaveBeenCalled();
  });

  it('resumePending surfaces non-terminal rows for the reconcile story (5.6)', async () => {
    const store = new FakeStore();
    const saga = makeSaga(store);

    const a = await saga.recordIntent({
      idempotencyKey: 'r-a',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    const b = await saga.recordIntent({
      idempotencyKey: 'r-b',
      operationKind: 'PAIR_MINT',
      payload: {},
    });
    await saga.submit(b.id, async () => ({ txHash: '0xrb' }));

    const { pending, submitted } = await saga.resumePending();
    expect(pending.map((r) => r.id)).toEqual([a.id]);
    expect(submitted.map((r) => r.id)).toEqual([b.id]);
  });
});
