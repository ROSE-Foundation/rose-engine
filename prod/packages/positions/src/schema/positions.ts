// Drizzle schema for the off-chain per-user position model (FR-23) — the secondary-trading
// position layer (Option C). Mirrors the raw-SQL migration 0009 (in @rose/ledger). A position is a
// DERIVED off-chain row: it records a Subscriber's directional exposure (entry, size, collateral,
// P&L) layered OVER an issued coupled pair — it NEVER mints/holds a single on-chain leg and writes
// no postings. The chain stays authoritative for the underlying pair.
//
// Single-leg / no-pair unrepresentable: `coupled_pair_id` is a NOT NULL FK to coupled_pairs. A
// position therefore ALWAYS references an issued pair — a position with no pair has nowhere to
// exist (the same idiom as rose_notes.coupled_pair_id NOT NULL FK).
//
// Frozen money types (NFR-2): smallest-unit magnitudes (size_units, collateral, realized_pnl,
// unrealized_pnl) are integer NUMERICs (mirroring coupled_pairs.collateral_pool — NUMERIC, not
// bigint, for 18-decimal tokens); entry_price is the anchor P₀ as decimal(18,8); leverage is a
// per-row NUMERIC modelled for forward extensibility but PINNED to 1x in P0 by a CHECK (leverage =
// 1). P&L fields are SIGNED integers — the losing leg's locked loss is negative (D1, separate L/S).
//
// Lifecycle OPEN → (RESET) → CLOSED: RESET is the D1/D1a settlement boundary of the underlying pair
// (an OPERATION on an OPEN position — re-anchor / crystallise / re-base), not a third state. A
// position never outlives a CLOSED pair (enforced by the migration's backstop triggers).
import { check, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { coupledPairs } from '@rose/ledger';

/** Directional side of the position — long or short the reference asset (PRD glossary L/S). */
export const positionSide = pgEnum('position_side', ['LONG', 'SHORT']);

/**
 * The position lifecycle. OPEN positions can be RESET (re-anchored/crystallised/re-based at the
 * underlying pair's D1/D1a settlement boundary) any number of times while staying OPEN; CLOSED is
 * terminal. RESET is an event/operation, NOT a persisted state.
 */
export const positionLifecycle = pgEnum('position_lifecycle', ['OPEN', 'CLOSED']);

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Always references an issued coupled pair: NOT NULL FK ⇒ a position with no pair is
    // structurally unrepresentable, and no single-leg on-chain artifact exists.
    coupledPairId: uuid('coupled_pair_id')
      .notNull()
      .references(() => coupledPairs.id),
    // The per-user owner reference (a non-empty identifier). Not a FK in P0 — there is no
    // Subscribers/Members table yet (that lands with the 8.3 subscribe/redeem flow).
    owner: text('owner').notNull(),
    // The underlying reference (e.g. 'EUR/USD', 'BTC') — must match the linked pair's asset.
    referenceAsset: text('reference_asset').notNull(),
    side: positionSide('side').notNull(),
    // size/units — integer smallest-unit as NUMERIC (non-negative).
    sizeUnits: numeric('size_units').notNull(),
    // entry = anchor P₀ — decimal(18,8).
    entryPrice: numeric('entry_price', { precision: 18, scale: 8 }).notNull(),
    // collateral — integer smallest-unit as NUMERIC (non-negative).
    collateral: numeric('collateral').notNull(),
    // leverage — modelled for forward extensibility, PINNED to 1x in P0 by the CHECK below.
    leverage: numeric('leverage').notNull().default('1'),
    // realized P&L — signed integer smallest-unit (crystallised/withdrawable at each reset).
    realizedPnl: numeric('realized_pnl').notNull().default('0'),
    // unrealized P&L — signed integer smallest-unit (the live mark vs entry; 0 at open).
    unrealizedPnl: numeric('unrealized_pnl').notNull().default('0'),
    lifecycle: positionLifecycle('lifecycle').notNull().default('OPEN'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('positions_owner_nonempty', sql`length(btrim(${t.owner})) > 0`),
    check('positions_reference_asset_nonempty', sql`length(btrim(${t.referenceAsset})) > 0`),
    check('positions_entry_price_positive', sql`${t.entryPrice} > 0`),
    // P0 leverage guard: leverage is pinned to 1x. Leveraged positions (>1x) are post-P0 (§17).
    check('positions_leverage_pinned_1x', sql`${t.leverage} = 1`),
    // Smallest-unit NUMERICs are non-negative integers (NFR-2), mirroring coupled_pairs.
    check(
      'positions_size_units_nonneg_int',
      sql`${t.sizeUnits} >= 0 AND ${t.sizeUnits} = trunc(${t.sizeUnits})`,
    ),
    check(
      'positions_collateral_nonneg_int',
      sql`${t.collateral} >= 0 AND ${t.collateral} = trunc(${t.collateral})`,
    ),
    // P&L is a SIGNED integer smallest-unit (a loss is negative): integer-only, any sign.
    check('positions_realized_pnl_int', sql`${t.realizedPnl} = trunc(${t.realizedPnl})`),
    check('positions_unrealized_pnl_int', sql`${t.unrealizedPnl} = trunc(${t.unrealizedPnl})`),
  ],
);

export type Position = typeof positions.$inferSelect;
export type PositionSide = (typeof positionSide.enumValues)[number];
export type PositionLifecycle = (typeof positionLifecycle.enumValues)[number];
