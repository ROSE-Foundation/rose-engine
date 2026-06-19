// Migration 0009 — the off-chain per-user position model (FR-23): the secondary-trading position
// layer (Option C). A `positions` row records a Subscriber's directional exposure (entry, size,
// collateral, P&L) layered OVER an issued coupled pair. It is a DERIVED off-chain row — it never
// mints/holds a single on-chain leg and writes no postings. Raw SQL (SQL-first), shipped as a typed
// module mirroring positions/src/schema/positions.ts. APPEND-ONLY after merge.
//
// No-pair-unrepresentable: coupled_pair_id is a NOT NULL FK to coupled_pairs — a position ALWAYS
// references an issued pair (the same idiom as rose_notes.coupled_pair_id). There is no single-leg
// table; positions hold no leg.
//
// Frozen money types (NFR-2): size_units / collateral / realized_pnl / unrealized_pnl are integer
// NUMERICs (smallest-units, like coupled_pairs.collateral_pool — NUMERIC, not bigint); entry_price
// is decimal(18,8); leverage is a per-row NUMERIC modelled for forward extensibility but PINNED to
// 1x in P0 by CHECK (leverage = 1). size_units/collateral are non-negative; P&L is SIGNED (a loss
// is negative — D1 separate L/S).
//
// "A position never outlives a CLOSED pair" — enforced by TWO non-bypassable BEFORE triggers (the
// integrity-by-construction idiom of migrations 0002/0004/0005), so even a raw SQL write cannot
// produce an OPEN position coexisting with a CLOSED pair:
//   (1) on positions: reject inserting/keeping an OPEN position whose referenced pair is CLOSED;
//   (2) on coupled_pairs: reject transitioning a pair to CLOSED while any OPEN position references it.
import type { Migration } from '../migrate.js';

export const migration0009: Migration = {
  version: '0009_positions',
  up: /* sql */ `
    CREATE TYPE position_side AS ENUM ('LONG', 'SHORT');
    CREATE TYPE position_lifecycle AS ENUM ('OPEN', 'CLOSED');

    CREATE TABLE positions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Always references an issued coupled pair: a NOT NULL FK ⇒ a position with no pair is
      -- structurally unrepresentable, and no single-leg on-chain artifact is created.
      coupled_pair_id uuid NOT NULL REFERENCES coupled_pairs (id),
      owner text NOT NULL,
      reference_asset text NOT NULL,
      side position_side NOT NULL,
      size_units numeric NOT NULL,
      entry_price numeric(18, 8) NOT NULL,
      collateral numeric NOT NULL,
      leverage numeric NOT NULL DEFAULT 1,
      realized_pnl numeric NOT NULL DEFAULT 0,
      unrealized_pnl numeric NOT NULL DEFAULT 0,
      lifecycle position_lifecycle NOT NULL DEFAULT 'OPEN',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT positions_owner_nonempty CHECK (length(btrim(owner)) > 0),
      CONSTRAINT positions_reference_asset_nonempty CHECK (length(btrim(reference_asset)) > 0),
      CONSTRAINT positions_entry_price_positive CHECK (entry_price > 0),
      -- P0 leverage guard: leverage is pinned to 1x. Leveraged positions (>1x) are post-P0 (§17).
      CONSTRAINT positions_leverage_pinned_1x CHECK (leverage = 1),
      -- Smallest-unit NUMERICs are non-negative integers (NFR-2), mirroring coupled_pairs.
      CONSTRAINT positions_size_units_nonneg_int
        CHECK (size_units >= 0 AND size_units = trunc(size_units)),
      CONSTRAINT positions_collateral_nonneg_int
        CHECK (collateral >= 0 AND collateral = trunc(collateral)),
      -- P&L is a SIGNED integer smallest-unit (a loss is negative): integer-only, any sign.
      CONSTRAINT positions_realized_pnl_int CHECK (realized_pnl = trunc(realized_pnl)),
      CONSTRAINT positions_unrealized_pnl_int CHECK (unrealized_pnl = trunc(unrealized_pnl))
    );

    CREATE INDEX idx_positions_coupled_pair_id ON positions (coupled_pair_id);

    -- Backstop (1): a position may never be OPEN against a CLOSED pair. Guards INSERT and any UPDATE
    -- that lands an OPEN lifecycle, looking through the FK to the pair's current state.
    CREATE FUNCTION enforce_position_pair_not_closed() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_state coupled_pair_state;
    BEGIN
      IF NEW.lifecycle = 'OPEN' THEN
        SELECT state INTO v_state FROM coupled_pairs WHERE id = NEW.coupled_pair_id;
        -- An absent pair is the FK's job (23503); we only own the CLOSED check here.
        IF v_state = 'CLOSED' THEN
          RAISE EXCEPTION
            'A position cannot be OPEN against a CLOSED coupled pair (pair %)', NEW.coupled_pair_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_positions_pair_not_closed
      BEFORE INSERT OR UPDATE ON positions
      FOR EACH ROW EXECUTE FUNCTION enforce_position_pair_not_closed();

    -- Backstop (2): a pair may not transition to CLOSED while any OPEN position references it — so a
    -- position can never be left alive after its pair closes. Only acts on the genuine →CLOSED edge.
    CREATE FUNCTION enforce_pair_close_no_open_positions() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_open_count bigint;
    BEGIN
      IF NEW.state = 'CLOSED' AND OLD.state IS DISTINCT FROM 'CLOSED' THEN
        SELECT count(*) INTO v_open_count
          FROM positions
         WHERE coupled_pair_id = NEW.id AND lifecycle = 'OPEN';
        IF v_open_count > 0 THEN
          RAISE EXCEPTION
            'Cannot close coupled pair %: % open position(s) still reference it', NEW.id, v_open_count
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_coupled_pairs_close_no_open_positions
      BEFORE UPDATE ON coupled_pairs
      FOR EACH ROW EXECUTE FUNCTION enforce_pair_close_no_open_positions();
  `,
  // Exact inverse, in reverse dependency order: triggers → functions → table → enum types.
  // IF EXISTS keeps it safe for test resets.
  down: /* sql */ `
    DROP TRIGGER IF EXISTS trg_coupled_pairs_close_no_open_positions ON coupled_pairs;
    DROP FUNCTION IF EXISTS enforce_pair_close_no_open_positions();
    DROP TRIGGER IF EXISTS trg_positions_pair_not_closed ON positions;
    DROP FUNCTION IF EXISTS enforce_position_pair_not_closed();
    DROP TABLE IF EXISTS positions;
    DROP TYPE IF EXISTS position_lifecycle;
    DROP TYPE IF EXISTS position_side;
  `,
};
