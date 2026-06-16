// Drizzle schema for the four fixed entities (FR-1). The DDL of record is the raw-SQL
// migration (src/migrations/); this typed schema mirrors it for type-safe queries.
import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** The four fixed entity codes — PRD glossary, no dynamic entities. */
export const entityCode = pgEnum('entity_code', ['VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER']);

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: entityCode('code').notNull().unique(),
  jurisdiction: text('jurisdiction').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Entity = typeof entities.$inferSelect;
export type EntityCode = (typeof entityCode.enumValues)[number];
