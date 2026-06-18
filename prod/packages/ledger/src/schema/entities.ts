// Drizzle schema for the four fixed entities (FR-1). The DDL of record is the raw-SQL
// migration (src/migrations/); this typed schema mirrors it for type-safe queries.
import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** The four fixed entity codes — PRD glossary, no dynamic entities. */
export const entityCode = pgEnum('entity_code', ['VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER']);

/**
 * The operational role of each fixed entity (added in migration 0008). These are STATIC facts of the
 * four fixed entities (not user data): VCC issues notes / holds treasury, HOLDING coordinates,
 * TRADING_CO trades, COIN_ISSUER issues coins. Seeded deterministically in the migration.
 */
export const entityRole = pgEnum('entity_role', [
  'TREASURY_NOTE_ISSUER',
  'COORDINATION',
  'TRADING',
  'COIN_ISSUANCE',
]);

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: entityCode('code').notNull().unique(),
  jurisdiction: text('jurisdiction').notNull(),
  role: entityRole('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Entity = typeof entities.$inferSelect;
export type EntityCode = (typeof entityCode.enumValues)[number];
export type EntityRole = (typeof entityRole.enumValues)[number];
