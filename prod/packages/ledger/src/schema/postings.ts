// Drizzle schema for postings (FR-2/FR-3). Debits/credits of a journal entry; the
// double-entry balance invariant is enforced by the DEFERRABLE constraint trigger in
// migration 0002. Amounts are integer smallest-units stored as NUMERIC (NFR-2).
import { index, numeric, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal-entries.js';
import { accounts } from './accounts.js';

export const postingDirection = pgEnum('posting_direction', ['DEBIT', 'CREDIT']);

export const postings = pgTable(
  'postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    direction: postingDirection('direction').notNull(),
    // Integer smallest-units; NUMERIC for 18-decimal token magnitudes. Read as a string.
    amount: numeric('amount').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_postings_journal_entry_id').on(t.journalEntryId)],
);

export type Posting = typeof postings.$inferSelect;
export type PostingDirection = (typeof postingDirection.enumValues)[number];
