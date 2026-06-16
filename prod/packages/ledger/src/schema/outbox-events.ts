// Drizzle schema for the `outbox_events` table (NFR-9 / NFR-3, Story 5.2). Mirrors the raw-SQL
// migration 0007. One row per dual-write operation; the saga (`@rose/chain/src/outbox`) drives it
// through its lifecycle with the on-chain tx confirmation as the commit point. The rules of the
// state machine live in the saga + the repository; this is the persisted projection.
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { journalEntries } from './journal-entries.js';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull(),
    operationKind: text('operation_kind').notNull(),
    status: text('status').notNull().default('PENDING'),
    payload: jsonb('payload').notNull(),
    txHash: text('tx_hash'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    lastError: text('last_error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('outbox_events_idempotency_key_key').on(t.idempotencyKey),
    unique('outbox_events_tx_hash_key').on(t.txHash),
    index('idx_outbox_events_status').on(t.status),
    check(
      'outbox_events_operation_kind_chk',
      sql`${t.operationKind} IN ('PAIR_MINT', 'PAIR_BURN')`,
    ),
    check(
      'outbox_events_status_chk',
      sql`${t.status} IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'COMPENSATED')`,
    ),
  ],
);

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type OutboxEventInsert = typeof outboxEvents.$inferInsert;

/** The dual-write operations the outbox carries. `mintPair`/`burnPair` orchestration is 5.3/5.4. */
export type OutboxOperationKind = 'PAIR_MINT' | 'PAIR_BURN';

/**
 * The saga lifecycle. The on-chain tx confirmation is the COMMIT POINT: the matching journal entry
 * is posted only on `SUBMITTED -> CONFIRMED`. Terminal states are `CONFIRMED` and `COMPENSATED`.
 */
export type OutboxStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'COMPENSATED';
