// Migration 0003 — the coupled-pair shared data model (FR-6): the inter-track contract,
// frozen first. Raw SQL (SQL-first), shipped as a typed module. APPEND-ONLY after merge.
//
// Frozen field types (PRD addendum §D): anchor_price decimal(18,8); leverage decimal (per-pair,
// never hard-coded); collateral_pool NUMERIC integer smallest-unit (not bigint); floor decimal;
// state enum PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED; reference_asset text; timestamptz.
//
// Single-leg-unrepresentable guarantee: both legs are NOT NULL columns on the single pair row
// (long_leg_value = V_A, short_leg_value = V_B). There is no separate legs table, so a lone leg
// has nowhere to be stored, and the NOT NULL constraints reject a row missing either leg.
//
// Also wires the deferred FK from journal_entries.coupled_pair_id (created nullable + FK-less in
// migration 0002) to coupled_pairs(id), now that the referenced table exists.
import type { Migration } from '../migrate.js';

export const migration0003: Migration = {
  version: '0003_coupled_pairs',
  up: /* sql */ `
    CREATE TYPE coupled_pair_state AS ENUM (
      'PENDING', 'ACTIVE', 'REBALANCING', 'PARTIAL', 'SETTLING', 'CLOSED'
    );

    CREATE TABLE coupled_pairs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reference_asset text NOT NULL,
      anchor_price numeric(18, 8) NOT NULL,
      leverage numeric NOT NULL,
      collateral_pool numeric NOT NULL,
      floor numeric NOT NULL,
      -- Both legs on the single row: a coupled pair is one atomic row carrying BOTH legs.
      -- No separate legs table exists, so a single/orphan leg is structurally unrepresentable.
      long_leg_value numeric NOT NULL,
      short_leg_value numeric NOT NULL,
      state coupled_pair_state NOT NULL DEFAULT 'PENDING',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT coupled_pairs_reference_asset_nonempty CHECK (length(btrim(reference_asset)) > 0),
      CONSTRAINT coupled_pairs_anchor_price_positive CHECK (anchor_price > 0),
      -- L is per-pair and must be a positive factor; it is read from the row, never hard-coded.
      CONSTRAINT coupled_pairs_leverage_positive CHECK (leverage > 0),
      CONSTRAINT coupled_pairs_floor_nonneg CHECK (floor >= 0),
      -- Smallest-unit NUMERICs are non-negative integers (NFR-2), mirroring postings.amount.
      CONSTRAINT coupled_pairs_collateral_pool_nonneg_int
        CHECK (collateral_pool >= 0 AND collateral_pool = trunc(collateral_pool)),
      CONSTRAINT coupled_pairs_long_leg_nonneg_int
        CHECK (long_leg_value >= 0 AND long_leg_value = trunc(long_leg_value)),
      CONSTRAINT coupled_pairs_short_leg_nonneg_int
        CHECK (short_leg_value >= 0 AND short_leg_value = trunc(short_leg_value))
    );

    -- Wire the deferred FK: journal_entries.coupled_pair_id was created nullable + FK-less in
    -- migration 0002; now that coupled_pairs exists, attach the referential integrity constraint.
    ALTER TABLE journal_entries
      ADD CONSTRAINT journal_entries_coupled_pair_id_fkey
      FOREIGN KEY (coupled_pair_id) REFERENCES coupled_pairs (id);
  `,
  // Exact inverse, in reverse dependency order: drop the FK before the table it points at,
  // and the table before its enum type. IF EXISTS keeps it safe for test resets.
  down: /* sql */ `
    ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_coupled_pair_id_fkey;
    DROP TABLE IF EXISTS coupled_pairs;
    DROP TYPE IF EXISTS coupled_pair_state;
  `,
};
