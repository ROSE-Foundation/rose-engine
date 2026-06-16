// Outbox-events repository (NFR-9 / NFR-3, Story 5.2). The persisted side of the outbox/saga
// dual-write: it records intents, advances them through the lifecycle, and enforces idempotency at
// the DB level (unique idempotency key, unique tx hash). The on-chain tx confirmation is the COMMIT
// POINT — this layer never decides to post a journal entry; it only flips status + links the
// journal entry the saga (`@rose/chain/src/outbox`) posts inside the confirm transaction.
//
// Append-oriented + explicit transitions: each mutator validates the source status and rejects an
// illegal transition (fail-closed). All functions take a `RoseExecutor`, so the saga can compose
// `applyLedgerEffect` + `markConfirmed` + `stampJournalEntryTxHash` inside ONE `db.transaction`.
import { and, eq } from 'drizzle-orm';
import type { RoseExecutor } from '../db.js';
import { journalEntries, outboxEvents } from '../schema/index.js';
import type { OutboxEventRow, OutboxOperationKind, OutboxStatus } from '../schema/index.js';

/** Thrown when an outbox row is missing for a lookup the caller asserted should exist. */
export class OutboxEventNotFoundError extends Error {
  constructor(by: string, value: string) {
    super(`Outbox event not found by ${by} '${value}'.`);
    this.name = 'OutboxEventNotFoundError';
  }
}

/** Thrown when a status transition is not allowed from the row's current status (fail-closed). */
export class IllegalOutboxTransitionError extends Error {
  readonly from: OutboxStatus;
  readonly to: OutboxStatus;
  constructor(from: OutboxStatus, to: OutboxStatus) {
    super(`Illegal outbox transition ${from} -> ${to}.`);
    this.name = 'IllegalOutboxTransitionError';
    this.from = from;
    this.to = to;
  }
}

export interface RecordIntentInput {
  readonly idempotencyKey: string;
  readonly operationKind: OutboxOperationKind;
  /** The intent, with all amounts as decimal strings (never a JS float, NFR-2). */
  readonly payload: Record<string, unknown>;
}

// Legal forward transitions of the outbox lifecycle (fail-closed: anything else is rejected).
const LEGAL_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = {
  PENDING: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: ['COMPENSATED'],
  COMPENSATED: [],
};

function assertTransition(from: string, to: OutboxStatus): void {
  const legal = LEGAL_TRANSITIONS[from as OutboxStatus];
  if (!legal || !legal.includes(to)) {
    throw new IllegalOutboxTransitionError(from as OutboxStatus, to);
  }
}

function logTransition(
  row: OutboxEventRow,
  to: OutboxStatus,
  extra?: Record<string, unknown>,
): void {
  // Structured "outbox commit" decision-point log (architecture.md §Monitoring/logging, CLAUDE.md §11).
  console.info('[outbox]', {
    outboxId: row.id,
    idempotencyKey: row.idempotencyKey,
    operationKind: row.operationKind,
    from: row.status,
    to,
    txHash: row.txHash ?? extra?.txHash ?? null,
    journalEntryId: row.journalEntryId ?? extra?.journalEntryId ?? null,
  });
}

/**
 * Records a dual-write intent as a `PENDING` outbox row. IDEMPOTENT: if the idempotency key already
 * exists, the existing row is returned unchanged (never a duplicate intent — NFR-9). The on-chain
 * tx is NOT submitted here and NO journal entry is posted; this only journals the intention.
 */
export async function recordIntent(
  db: RoseExecutor,
  input: RecordIntentInput,
): Promise<OutboxEventRow> {
  if (input.idempotencyKey.trim().length === 0) {
    throw new Error('Outbox idempotencyKey must be non-empty.');
  }
  const [row] = await db
    .insert(outboxEvents)
    .values({
      idempotencyKey: input.idempotencyKey,
      operationKind: input.operationKind,
      status: 'PENDING',
      payload: input.payload,
    })
    .onConflictDoNothing({ target: outboxEvents.idempotencyKey })
    .returning();

  if (row) {
    console.info('[outbox]', {
      outboxId: row.id,
      idempotencyKey: row.idempotencyKey,
      operationKind: row.operationKind,
      to: 'PENDING',
    });
    return row;
  }
  // Conflict: the intent already exists — return it (idempotent, exactly-once intent).
  const existing = await findByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) {
    throw new OutboxEventNotFoundError('idempotencyKey', input.idempotencyKey);
  }
  return existing;
}

export async function findByIdempotencyKey(
  db: RoseExecutor,
  idempotencyKey: string,
): Promise<OutboxEventRow | null> {
  const [row] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.idempotencyKey, idempotencyKey));
  return row ?? null;
}

export async function findByTxHash(
  db: RoseExecutor,
  txHash: string,
): Promise<OutboxEventRow | null> {
  const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.txHash, txHash));
  return row ?? null;
}

export async function findById(db: RoseExecutor, id: string): Promise<OutboxEventRow | null> {
  const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  return row ?? null;
}

/**
 * Row-locking lookup by tx hash (`SELECT … FOR UPDATE`) — MUST be called inside a transaction. The
 * saga's `confirm` uses this so concurrent re-deliveries of the same confirmed tx serialize on the
 * row: the first confirms (CONFIRMED) and the others then re-read CONFIRMED and no-op, so the ledger
 * effect is applied exactly once even under concurrency (NFR-9). Outside a transaction the lock is
 * released immediately and provides no serialization — `confirm` always wraps it in one.
 */
export async function findByTxHashForUpdate(
  db: RoseExecutor,
  txHash: string,
): Promise<OutboxEventRow | null> {
  const [row] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.txHash, txHash))
    .for('update');
  return row ?? null;
}

export async function listByStatus(
  db: RoseExecutor,
  status: OutboxStatus,
): Promise<OutboxEventRow[]> {
  return db.select().from(outboxEvents).where(eq(outboxEvents.status, status));
}

export interface RecordSubmissionInput {
  readonly id: string;
  /** The on-chain tx hash returned by the caller's submit. Unique across the outbox (idempotency). */
  readonly txHash: string;
}

/**
 * Records that the on-chain tx was submitted: `PENDING -> SUBMITTED`, storing `tx_hash`. This is NOT
 * the commit point — the journal entry is posted only at confirmation. Runs the read + flip inside a
 * transaction with a row lock (`FOR UPDATE`) and a conditional `WHERE status = 'PENDING'` update, so
 * two concurrent submissions for the same row cannot both win (last-writer-wins on the tx hash is
 * prevented); the second serializes, re-reads SUBMITTED, and is rejected. The cross-row unique
 * `tx_hash` constraint additionally backstops two rows racing for the same hash. Rejects an illegal
 * source status (fail-closed); re-submitting the SAME hash is idempotent.
 */
export async function recordSubmission(
  db: RoseExecutor,
  input: RecordSubmissionInput,
): Promise<OutboxEventRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, input.id))
      .for('update');
    if (!row) {
      throw new OutboxEventNotFoundError('id', input.id);
    }
    if (row.status === 'SUBMITTED' && row.txHash === input.txHash) {
      return row; // Idempotent re-submission of the same tx hash.
    }
    assertTransition(row.status, 'SUBMITTED');
    logTransition(row, 'SUBMITTED', { txHash: input.txHash });
    const [updated] = await tx
      .update(outboxEvents)
      .set({ status: 'SUBMITTED', txHash: input.txHash, updatedAt: new Date() })
      .where(and(eq(outboxEvents.id, input.id), eq(outboxEvents.status, 'PENDING')))
      .returning();
    if (!updated) {
      // Lost the race: another submission flipped the row out of PENDING first.
      throw new IllegalOutboxTransitionError(row.status as OutboxStatus, 'SUBMITTED');
    }
    return updated;
  });
}

export interface MarkConfirmedInput {
  readonly id: string;
  /** The journal entry posted for this dual-write (NFR-3 link). */
  readonly journalEntryId: string;
}

/**
 * The COMMIT POINT flip: `SUBMITTED -> CONFIRMED`, linking the posted journal entry. The caller
 * (saga `confirm`) MUST run this inside the SAME transaction that posts the journal entry and
 * stamps its tx hash, so the row is CONFIRMED with its entry atomically or not at all (NFR-3).
 */
export async function markConfirmed(
  db: RoseExecutor,
  input: MarkConfirmedInput,
): Promise<OutboxEventRow> {
  const row = await findById(db, input.id);
  if (!row) {
    throw new OutboxEventNotFoundError('id', input.id);
  }
  assertTransition(row.status, 'CONFIRMED');
  logTransition(row, 'CONFIRMED', { journalEntryId: input.journalEntryId });
  const [updated] = await db
    .update(outboxEvents)
    .set({ status: 'CONFIRMED', journalEntryId: input.journalEntryId, updatedAt: new Date() })
    .where(eq(outboxEvents.id, input.id))
    .returning();
  return updated!;
}

export interface MarkFailedInput {
  readonly id: string;
  readonly error: string;
}

/** Marks a `PENDING`/`SUBMITTED` row `FAILED` (tx never confirmed/reverted), incrementing attempts. */
export async function markFailed(
  db: RoseExecutor,
  input: MarkFailedInput,
): Promise<OutboxEventRow> {
  const row = await findById(db, input.id);
  if (!row) {
    throw new OutboxEventNotFoundError('id', input.id);
  }
  assertTransition(row.status, 'FAILED');
  logTransition(row, 'FAILED', { error: input.error });
  const [updated] = await db
    .update(outboxEvents)
    .set({
      status: 'FAILED',
      lastError: input.error,
      attempts: row.attempts + 1,
      updatedAt: new Date(),
    })
    .where(eq(outboxEvents.id, input.id))
    .returning();
  return updated!;
}

/** Marks a `FAILED` row `COMPENSATED`. A compensated row NEVER posts a ledger effect (NFR-9). */
export async function markCompensated(db: RoseExecutor, id: string): Promise<OutboxEventRow> {
  const row = await findById(db, id);
  if (!row) {
    throw new OutboxEventNotFoundError('id', id);
  }
  assertTransition(row.status, 'COMPENSATED');
  logTransition(row, 'COMPENSATED');
  const [updated] = await db
    .update(outboxEvents)
    .set({ status: 'COMPENSATED', updatedAt: new Date() })
    .where(eq(outboxEvents.id, id))
    .returning();
  return updated!;
}

export interface StampJournalEntryTxHashInput {
  readonly journalEntryId: string;
  readonly txHash: string;
}

/**
 * Records the on-chain tx hash on the related journal entry (NFR-3). Called by the saga inside the
 * confirm transaction. Idempotent re-stamping with the same hash is a no-op; restamping a different
 * hash is rejected (a journal entry maps to exactly one on-chain tx).
 */
export async function stampJournalEntryTxHash(
  db: RoseExecutor,
  input: StampJournalEntryTxHashInput,
): Promise<void> {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, input.journalEntryId));
  if (!entry) {
    throw new OutboxEventNotFoundError('journalEntryId', input.journalEntryId);
  }
  if (entry.txHash != null && entry.txHash !== input.txHash) {
    throw new Error(
      `Journal entry '${input.journalEntryId}' already stamped with a different tx hash.`,
    );
  }
  await db
    .update(journalEntries)
    .set({ txHash: input.txHash })
    .where(eq(journalEntries.id, input.journalEntryId));
}
