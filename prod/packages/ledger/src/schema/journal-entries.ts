// Drizzle schema for journal entries (FR-2). Mirrors the raw-SQL migrations 0002 + 0003.
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { coupledPairs } from './coupled-pairs.js';

export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  description: text('description').notNull(),
  // Optional link to a coupled pair (FR-2). Column created nullable + FK-less in migration 0002;
  // the FK to coupled_pairs(id) is attached in migration 0003 once that table exists.
  coupledPairId: uuid('coupled_pair_id').references(() => coupledPairs.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type JournalEntry = typeof journalEntries.$inferSelect;
