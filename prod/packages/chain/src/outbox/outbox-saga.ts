// Outbox/saga orchestrator (NFR-9 / NFR-3, Story 5.2). Sequences the dual-write so the on-chain
// transaction is the COMMIT POINT: intent (PENDING) -> submit (SUBMITTED, tx hash recorded) ->
// confirm (CONFIRMED, the matching balanced journal entry posted here, ONCE). Failures compensate
// (FAILED -> COMPENSATED, never posting a ledger effect) or are left for reconciliation (5.6).
//
// This module is GENERIC and port-driven so it is unit-testable with in-memory fakes and so the
// concrete operations land in later stories WITHOUT changing the orchestration:
//   - `submit` (the on-chain write) is supplied by 5.3/5.4 via the chain wallet client +
//     `mintPair`/`burnPair`; the saga only records the resulting tx hash.
//   - `LedgerEffect` (posting the balanced journal entry, governed by `postTransfer`) is supplied by
//     5.3/5.4; the saga invokes it ONLY at confirmation, inside one DB transaction with the status
//     flip + tx-hash stamping.
//   - The confirmation signal is the Story 5.1 `ChainEvent` (its `transactionHash`) delivered by
//     `watchPairEvents`; `confirm` keys on that hash and is idempotent under re-delivery / reorg.
import type { RoseDb, RoseExecutor, OutboxEventRow, OutboxOperationKind } from '@rose/ledger';
import {
  recordIntent,
  recordSubmission,
  markConfirmed,
  markFailed,
  markCompensated,
  findByTxHash,
  findByTxHashForUpdate,
  listByStatus,
  stampJournalEntryTxHash,
} from '@rose/ledger';
import type { ChainEvent } from '../watchers.js';

/**
 * The subset of outbox persistence the saga needs. The production binding is the `@rose/ledger`
 * repository; tests inject an in-memory fake so the orchestration invariants are proven without a DB.
 */
export interface OutboxStore {
  recordIntent(
    db: RoseExecutor,
    input: {
      idempotencyKey: string;
      operationKind: OutboxOperationKind;
      payload: Record<string, unknown>;
    },
  ): Promise<OutboxEventRow>;
  recordSubmission(
    db: RoseExecutor,
    input: { id: string; txHash: string },
  ): Promise<OutboxEventRow>;
  markConfirmed(
    db: RoseExecutor,
    input: { id: string; journalEntryId: string },
  ): Promise<OutboxEventRow>;
  markFailed(db: RoseExecutor, input: { id: string; error: string }): Promise<OutboxEventRow>;
  markCompensated(db: RoseExecutor, id: string): Promise<OutboxEventRow>;
  findByTxHash(db: RoseExecutor, txHash: string): Promise<OutboxEventRow | null>;
  /** Row-locking lookup (`FOR UPDATE`) used by `confirm` to serialize concurrent confirmations. */
  findByTxHashForUpdate(db: RoseExecutor, txHash: string): Promise<OutboxEventRow | null>;
  listByStatus(db: RoseExecutor, status: OutboxEventRow['status']): Promise<OutboxEventRow[]>;
  stampJournalEntryTxHash(
    db: RoseExecutor,
    input: { journalEntryId: string; txHash: string },
  ): Promise<void>;
}

/** The default production store: the `@rose/ledger` outbox repository. */
export const ledgerOutboxStore: OutboxStore = {
  recordIntent,
  recordSubmission,
  markConfirmed,
  markFailed,
  markCompensated,
  findByTxHash,
  findByTxHashForUpdate,
  listByStatus,
  stampJournalEntryTxHash,
};

/** Context passed to the caller's `LedgerEffect` at the commit point. */
export interface LedgerEffectContext {
  readonly outboxId: string;
  readonly operationKind: OutboxOperationKind;
  readonly payload: unknown;
  readonly txHash: string;
}

/**
 * Posts the balanced journal entry for a confirmed dual-write and returns its id. Supplied by
 * 5.3/5.4 (mint/burn), implemented via `postTransfer`-governed `recordJournalEntry`. Invoked by the
 * saga ONLY at confirmation, inside the confirm transaction (so it is atomic with the status flip).
 */
export type LedgerEffect = (
  executor: RoseExecutor,
  ctx: LedgerEffectContext,
) => Promise<{ journalEntryId: string }>;

export interface OutboxSagaDeps {
  readonly db: RoseDb;
  readonly store?: OutboxStore;
}

/**
 * The outbox/saga orchestrator. Holds the DB handle + the store; exposes the lifecycle steps. The
 * on-chain confirmation is the commit point — `confirm` is the ONLY method that posts a ledger
 * effect, and it does so exactly once per tx hash.
 */
export class OutboxSaga {
  private readonly db: RoseDb;
  private readonly store: OutboxStore;

  constructor(deps: OutboxSagaDeps) {
    this.db = deps.db;
    this.store = deps.store ?? ledgerOutboxStore;
  }

  /** Records a dual-write intent (PENDING). Idempotent on `idempotencyKey`. NO tx, NO ledger effect. */
  async recordIntent(input: {
    idempotencyKey: string;
    operationKind: OutboxOperationKind;
    payload: Record<string, unknown>;
  }): Promise<OutboxEventRow> {
    return this.store.recordIntent(this.db, input);
  }

  /**
   * Submits the on-chain tx (the caller's `submit`, e.g. mintPair/burnPair via the wallet client)
   * and records the resulting tx hash (PENDING -> SUBMITTED). If `submit` throws, the row is marked
   * FAILED (compensation candidate) and the ORIGINAL error is rethrown. The commit point is the later
   * confirmation, NOT this submission — no journal entry is posted here.
   *
   * NOTE (broadcast-uncertainty window, owned by reconcile 5.6): `submit` must resolve with the tx
   * hash the moment the tx is broadcast (viem's `writeContract` returns it pre-mining). If `submit`
   * throws AFTER the node accepted the tx, the hash is unknown here and the row is FAILED with a NULL
   * hash; that on-chain-effect-without-recorded-hash case is reconciled by 5.6's chain-vs-ledger
   * balance comparison (the architecture-sanctioned backstop), not by tx-hash match.
   */
  async submit(
    outboxId: string,
    submit: () => Promise<{ txHash: string }>,
  ): Promise<OutboxEventRow> {
    let txHash: string;
    try {
      ({ txHash } = await submit());
    } catch (error) {
      // Preserve the ORIGINAL submit error even if marking FAILED itself fails (observability).
      try {
        await this.store.markFailed(this.db, {
          id: outboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (markError) {
        console.warn('[outbox] markFailed after submit error also failed', {
          outboxId,
          markError: markError instanceof Error ? markError.message : String(markError),
        });
      }
      throw error;
    }
    return this.store.recordSubmission(this.db, { id: outboxId, txHash });
  }

  /**
   * THE COMMIT POINT. Given a confirmed on-chain tx hash (from a Story 5.1 `ChainEvent`), posts the
   * matching balanced journal entry via `ledgerEffect`, stamps the tx hash on it (NFR-3), and flips
   * SUBMITTED -> CONFIRMED — all in ONE DB transaction (atomic: either CONFIRMED with its entry, or
   * nothing). The row is read `FOR UPDATE`, so concurrent re-deliveries of the same confirmed tx
   * serialize: the first applies the effect, the rest re-read CONFIRMED and no-op. IDEMPOTENT: a
   * tx hash already CONFIRMED returns its row WITHOUT re-applying the effect (safe under watcher
   * re-delivery / reorg re-scan). A row NOT in SUBMITTED (e.g. a FAILED/COMPENSATED row whose tx
   * later mines, or a PENDING row) is NOT confirmed here — the ledger effect is never applied and a
   * WARN is logged (an anomaly for reconcile 5.6 to resolve); confirm never throws into the watcher.
   * Returns null if no outbox row matches the hash.
   */
  async confirm(
    txHash: string,
    ledgerEffect: LedgerEffect,
  ): Promise<{ row: OutboxEventRow; applied: boolean } | null> {
    return this.db.transaction(async (tx) => {
      const row = await this.store.findByTxHashForUpdate(tx, txHash);
      if (!row) {
        // A confirmed on-chain tx with no recorded intent — a reconcile signal (5.6), not an error.
        console.warn('[outbox] confirm: no outbox row matches tx hash', { txHash });
        return null;
      }
      if (row.status === 'CONFIRMED') {
        return { row, applied: false }; // Already committed — replay/reorg no-op (NFR-9).
      }
      if (row.status !== 'SUBMITTED') {
        // FAILED/COMPENSATED/PENDING row whose tx matched: do NOT post the effect, do NOT throw into
        // the watcher; surface as a non-applied anomaly for reconcile (5.6) to investigate.
        console.warn('[outbox] confirm: tx confirmed for a non-SUBMITTED row (anomaly)', {
          outboxId: row.id,
          status: row.status,
          txHash,
        });
        return { row, applied: false };
      }
      const { journalEntryId } = await ledgerEffect(tx, {
        outboxId: row.id,
        operationKind: row.operationKind as OutboxOperationKind,
        payload: row.payload,
        txHash,
      });
      await this.store.stampJournalEntryTxHash(tx, { journalEntryId, txHash });
      const confirmed = await this.store.markConfirmed(tx, { id: row.id, journalEntryId });
      return { row: confirmed, applied: true };
    });
  }

  /**
   * Confirms a dual-write from a Story 5.1 `ChainEvent` envelope — the intended wiring is
   * `watchPairEvents({ onPairMinted: (e) => saga.confirmFromEvent(e, effect) })`. Skips events
   * without a tx hash (already filtered to confirmed/non-removed logs by 5.1, defensive here).
   */
  async confirmFromEvent(
    event: ChainEvent<string, unknown>,
    ledgerEffect: LedgerEffect,
  ): Promise<{ row: OutboxEventRow; applied: boolean } | null> {
    if (event.transactionHash == null) {
      return null;
    }
    return this.confirm(event.transactionHash, ledgerEffect);
  }

  /** Marks a row FAILED (a tx that never confirmed / reverted). Compensation candidate. */
  async fail(outboxId: string, error: string): Promise<OutboxEventRow> {
    return this.store.markFailed(this.db, { id: outboxId, error });
  }

  /** Compensates a FAILED row (FAILED -> COMPENSATED). NEVER posts a ledger effect (NFR-9). */
  async compensate(outboxId: string): Promise<OutboxEventRow> {
    return this.store.markCompensated(this.db, outboxId);
  }

  /**
   * Recovery seam for the reconcile story (5.6): returns the non-terminal rows (PENDING + SUBMITTED)
   * a restarted process must re-drive. 5.2 provides the seam; the cadence / confirmation-depth
   * policy that decides WHEN to re-drive (and how to fetch the tx receipt) is owned by 5.6.
   */
  async resumePending(): Promise<{ pending: OutboxEventRow[]; submitted: OutboxEventRow[] }> {
    const [pending, submitted] = await Promise.all([
      this.store.listByStatus(this.db, 'PENDING'),
      this.store.listByStatus(this.db, 'SUBMITTED'),
    ]);
    return { pending, submitted };
  }
}
