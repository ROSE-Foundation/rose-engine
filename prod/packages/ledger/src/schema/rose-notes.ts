// Drizzle schema for Rose Notes (FR-12) — the Note ↔ coupled-pair embedding. Mirrors the raw-SQL
// migration 0005. A Rose Note references EXACTLY ONE coupled pair (NOT NULL FK), and that pair is
// embedded in AT MOST ONE note (UNIQUE coupled_pair_id ⇒ 1:1). Delta-neutrality at issuance
// (equal-notional legs) is enforced by the migration's BEFORE INSERT trigger + the repository guard,
// not by a column here.
//
// AC-2 (D1 resolved 2026-06-16 — separate L/S, zero-sum directional): this table stays
// deliberately minimal — no composition-mode or post-reset loss-allocation columns. By decision,
// the directional "note as one leg" shape lands with the L/S token & position model (Epics 4–6,
// where holders first exist), and the loss-allocation accounting with the reset machinery
// (Epics 5–7). D1a is resolved (crystallised & withdrawable: realize/settle at each reset, re-base
// symmetric) — NOT retro-fitted here, since issuance is delta-neutral and nothing is loss-allocated
// yet. See PRD §8 Q1 / §4.2.
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { coupledPairs } from './coupled-pairs.js';

export const roseNotes = pgTable('rose_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Exactly one coupled pair (NOT NULL), embedded in at most one note (UNIQUE).
  coupledPairId: uuid('coupled_pair_id')
    .notNull()
    .unique()
    .references(() => coupledPairs.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RoseNote = typeof roseNotes.$inferSelect;
