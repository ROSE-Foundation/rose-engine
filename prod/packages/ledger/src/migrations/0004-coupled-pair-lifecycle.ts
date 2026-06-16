// Migration 0004 — the coupled-pair lifecycle state machine enforced IN the database (FR-4,
// NFR-1). A BEFORE UPDATE trigger on `coupled_pairs` rejects any state CHANGE that is not in the
// explicit allowed-transitions set, making an illegal transition non-bypassable even via raw SQL
// (the integrity-by-construction backstop behind the typed app-level `transitionPair` guard).
// APPEND-ONLY after merge.
//
// The allowed set MUST mirror `COUPLED_PAIR_TRANSITIONS` in repositories/coupled-pairs.ts:
//   PENDING     → ACTIVE
//   ACTIVE      → REBALANCING | SETTLING
//   REBALANCING → PARTIAL | ACTIVE | SETTLING
//   PARTIAL     → REBALANCING | ACTIVE | SETTLING
//   SETTLING    → CLOSED
//   CLOSED      → (terminal — none)
//
// The trigger only acts when `state` actually changes (NEW.state IS DISTINCT FROM OLD.state), so a
// no-op same-state UPDATE and any non-state update (e.g. a future anchor_price reset write) pass
// through untouched. PARTIAL is a known transient mid-rebalance state, reached only from within a
// rebalance (REBALANCING → PARTIAL), never directly from ACTIVE.
import type { Migration } from '../migrate.js';

export const migration0004: Migration = {
  version: '0004_coupled_pair_lifecycle',
  up: /* sql */ `
    CREATE FUNCTION enforce_coupled_pair_transition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Only guard genuine state changes; non-state updates and no-op same-state writes pass.
      IF NEW.state IS DISTINCT FROM OLD.state THEN
        IF NOT (
          (OLD.state = 'PENDING'     AND NEW.state = 'ACTIVE') OR
          (OLD.state = 'ACTIVE'      AND NEW.state IN ('REBALANCING', 'SETTLING')) OR
          (OLD.state = 'REBALANCING' AND NEW.state IN ('PARTIAL', 'ACTIVE', 'SETTLING')) OR
          (OLD.state = 'PARTIAL'     AND NEW.state IN ('REBALANCING', 'ACTIVE', 'SETTLING')) OR
          (OLD.state = 'SETTLING'    AND NEW.state = 'CLOSED')
          -- CLOSED is terminal: no transition out of it is legal.
        ) THEN
          RAISE EXCEPTION
            'Illegal coupled-pair lifecycle transition: % -> % (pair %)',
            OLD.state, NEW.state, OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_coupled_pairs_lifecycle
      BEFORE UPDATE ON coupled_pairs
      FOR EACH ROW EXECUTE FUNCTION enforce_coupled_pair_transition();
  `,
  // Exact inverse: drop the trigger before the function it calls. IF EXISTS keeps resets safe.
  down: /* sql */ `
    DROP TRIGGER IF EXISTS trg_coupled_pairs_lifecycle ON coupled_pairs;
    DROP FUNCTION IF EXISTS enforce_coupled_pair_transition();
  `,
};
