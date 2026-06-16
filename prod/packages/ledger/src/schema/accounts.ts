// Drizzle schema for typed accounts (FR-1). Each account belongs to one entity, has one of
// the five fixed types, an asset, and a decimal scale. Mirrors the raw-SQL migration.
import {
  check,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.js';

/** The five fixed account types — PRD glossary. */
export const accountType = pgEnum('account_type', [
  'BACKING_FLOAT',
  'DEPLOYED_CAPITAL',
  'CLIENT_COLLATERAL',
  'FEE_INCOME',
  'NOTE_LIABILITY',
]);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    type: accountType('type').notNull(),
    asset: text('asset').notNull(),
    decimalScale: smallint('decimal_scale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('accounts_entity_type_asset_uq').on(t.entityId, t.type, t.asset),
    index('idx_accounts_entity_id').on(t.entityId),
    check('accounts_decimal_scale_nonneg', sql`${t.decimalScale} >= 0`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type AccountType = (typeof accountType.enumValues)[number];
