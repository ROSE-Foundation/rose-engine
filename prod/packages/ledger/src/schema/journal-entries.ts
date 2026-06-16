// Drizzle schema for journal entries (FR-2). Mirrors the raw-SQL migrations 0002 + 0003 + 0007.
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { coupledPairs } from './coupled-pairs.js';

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    description: text('description').notNull(),
    // Optional link to a coupled pair (FR-2). Column created nullable + FK-less in migration 0002;
    // the FK to coupled_pairs(id) is attached in migration 0003 once that table exists.
    coupledPairId: uuid('coupled_pair_id').references(() => coupledPairs.id),
    // The on-chain tx hash recorded on the related journal entry (NFR-3). Added nullable in migration
    // 0007 (Story 5.2): off-chain-only entries and all pre-5.2 entries leave it NULL. Stamped at the
    // outbox commit point (SUBMITTED -> CONFIRMED) via `stampJournalEntryTxHash`.
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One on-chain tx maps to exactly one journal entry (NFR-3); NULLs are distinct so off-chain
  // entries are unconstrained. The fail-closed backstop against a duplicate ledger post (0007).
  (t) => [unique('journal_entries_tx_hash_key').on(t.txHash)],
);

export type JournalEntry = typeof journalEntries.$inferSelect;
