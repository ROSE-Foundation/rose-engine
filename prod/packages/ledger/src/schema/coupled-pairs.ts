// Drizzle schema for the coupled-pair shared data model (FR-6) — the inter-track contract,
// frozen first. Mirrors the raw-SQL migration 0003. Field types are the frozen set
// (PRD addendum §D): anchor_price decimal(18,8), leverage decimal (per-pair, never
// hard-coded), collateral_pool NUMERIC smallest-unit, floor decimal, state enum, reference_asset
// text, timestamptz timestamps.
//
// Single-leg-unrepresentable mechanism: BOTH legs live as NOT NULL columns on this single row
// (`long_leg_value` = V_A, `short_leg_value` = V_B). There is deliberately no separate legs
// table, so a leg has nowhere to exist on its own and an orphan/single leg is structurally
// impossible. The schema does NOT encode the V_A + V_B = K conservation invariant nor any
// post-reset loss-allocation (D1 parked) — that stays free for either Rose-Note interpretation.
import { check, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** The six lifecycle states — PRD glossary. Transitions are enforced in Story 2.2, not here. */
export const coupledPairState = pgEnum('coupled_pair_state', [
  'PENDING',
  'ACTIVE',
  'REBALANCING',
  'PARTIAL',
  'SETTLING',
  'CLOSED',
]);

export const coupledPairs = pgTable(
  'coupled_pairs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The underlying reference (e.g. 'EUR/USD', 'BTC') — free-text per the frozen model.
    referenceAsset: text('reference_asset').notNull(),
    // P₀ anchor price — decimal(18,8).
    anchorPrice: numeric('anchor_price', { precision: 18, scale: 8 }).notNull(),
    // L leverage — per-pair, read from the row, NEVER hard-coded. Unconstrained decimal.
    leverage: numeric('leverage').notNull(),
    // K collateral pool — integer smallest-unit as NUMERIC (not bigint) for 18-decimal tokens.
    collateralPool: numeric('collateral_pool').notNull(),
    // f floor — decimal.
    floor: numeric('floor').notNull(),
    // Both legs as NOT NULL columns on this single row: a pair always carries both legs.
    longLegValue: numeric('long_leg_value').notNull(),
    shortLegValue: numeric('short_leg_value').notNull(),
    state: coupledPairState('state').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('coupled_pairs_reference_asset_nonempty', sql`length(btrim(${t.referenceAsset})) > 0`),
    check('coupled_pairs_anchor_price_positive', sql`${t.anchorPrice} > 0`),
    check('coupled_pairs_leverage_positive', sql`${t.leverage} > 0`),
    check('coupled_pairs_floor_nonneg', sql`${t.floor} >= 0`),
    // Smallest-unit NUMERICs must be non-negative integers (NFR-2), mirroring postings.amount.
    check(
      'coupled_pairs_collateral_pool_nonneg_int',
      sql`${t.collateralPool} >= 0 AND ${t.collateralPool} = trunc(${t.collateralPool})`,
    ),
    check(
      'coupled_pairs_long_leg_nonneg_int',
      sql`${t.longLegValue} >= 0 AND ${t.longLegValue} = trunc(${t.longLegValue})`,
    ),
    check(
      'coupled_pairs_short_leg_nonneg_int',
      sql`${t.shortLegValue} >= 0 AND ${t.shortLegValue} = trunc(${t.shortLegValue})`,
    ),
  ],
);

export type CoupledPair = typeof coupledPairs.$inferSelect;
export type CoupledPairState = (typeof coupledPairState.enumValues)[number];
