// Drizzle schema for the off-chain `flow_permissions` table (FR-8, Story 3.4). Mirrors the
// raw-SQL migration 0006. Each row is one GENERATED policy clause (allow-rule / prohibition /
// floor guard); the clause object lives verbatim in `payload` (jsonb). The rules are NOT authored
// here — they are seeded from `generateOffChainPolicy(ruleSpecV1)` and read back by the provider.
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const flowPermissions = pgTable(
  'flow_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyVersion: text('policy_version').notNull(),
    source: text('source').notNull(),
    generator: text('generator').notNull(),
    defaultEffect: text('default_effect').notNull(),
    clauseKind: text('clause_kind').notNull(),
    clauseId: text('clause_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('flow_permissions_clause_id_key').on(t.clauseId),
    index('idx_flow_permissions_clause_kind').on(t.clauseKind),
    check(
      'flow_permissions_default_effect_chk',
      sql`${t.defaultEffect} IN ('ALLOW', 'DENY', 'REFUSE')`,
    ),
    check(
      'flow_permissions_clause_kind_chk',
      sql`${t.clauseKind} IN ('ALLOW_RULE', 'PROHIBITION', 'FLOOR_GUARD')`,
    ),
  ],
);

export type FlowPermissionRow = typeof flowPermissions.$inferSelect;
export type FlowPermissionInsert = typeof flowPermissions.$inferInsert;

/** The three clause discriminators persisted in `flow_permissions.clause_kind`. */
export type FlowPermissionClauseKind = 'ALLOW_RULE' | 'PROHIBITION' | 'FLOOR_GUARD';
