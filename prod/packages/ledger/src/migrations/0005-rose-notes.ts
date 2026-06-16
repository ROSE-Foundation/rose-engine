// Migration 0005 — the Rose Note ↔ coupled-pair embedding (FR-12). A Rose Note references
// EXACTLY ONE coupled pair (one NOT NULL FK column — a note cannot reference zero or two pairs),
// and a coupled pair is embedded in AT MOST ONE note (UNIQUE on coupled_pair_id ⇒ 1:1 embedding).
// Raw SQL (SQL-first), shipped as a typed module. APPEND-ONLY after merge.
//
// Delta-neutral AT ISSUANCE (FR-12): at the moment a note is created (or re-pointed to a different
// pair) the referenced pair's two legs must be at EQUAL notional (long_leg_value = short_leg_value)
// — market-neutral on the underlying. A BEFORE INSERT OR UPDATE trigger is the non-bypassable
// backstop behind the app-level guard (the same integrity-by-construction idiom as the double-entry
// trigger 0002 and the lifecycle trigger 0004).
//
// On INSERT it always checks. On UPDATE it re-checks ONLY when coupled_pair_id actually CHANGES
// (re-pointing a note to a different pair is a fresh issuance against that pair, so the new pair
// must be delta-neutral too — a raw UPDATE cannot smuggle in a skewed pair). An update that leaves
// coupled_pair_id unchanged (e.g. an updated_at bump) passes untouched. Crucially, after issuance
// the embedded pair's OWN legs may legitimately diverge ("directional risk arises only from
// strategy") — that is an UPDATE on coupled_pairs, NOT on rose_notes, so it never re-triggers this
// check and never invalidates the already-issued note.
//
// AC-2 (D1 parked): the table is deliberately MINIMAL — id, coupled_pair_id, timestamps. It encodes
// NO composition mode (bundled vs separate L/S) and NO post-reset loss-allocation; either D1
// interpretation can be layered on later without changing this contract.
import type { Migration } from '../migrate.js';

export const migration0005: Migration = {
  version: '0005_rose_notes',
  up: /* sql */ `
    CREATE TABLE rose_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Exactly one coupled pair: a single NOT NULL FK column. There is no join table, so a note
      -- referencing zero (NOT NULL) or two (one column) pairs is structurally unrepresentable.
      coupled_pair_id uuid NOT NULL REFERENCES coupled_pairs (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Embed ⇒ at most one note per pair (1:1). Relaxable later via a new migration if D1 decides.
      CONSTRAINT rose_notes_coupled_pair_id_key UNIQUE (coupled_pair_id)
    );

    -- Delta-neutral-at-issuance backstop: reject a note over a pair whose legs are NOT equal notional.
    CREATE FUNCTION enforce_rose_note_delta_neutral() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_long  numeric;
      v_short numeric;
    BEGIN
      -- On UPDATE, only re-validate when the embedded pair is RE-POINTED. A no-op or any update
      -- that leaves coupled_pair_id unchanged passes — the note's issuance was already validated.
      IF TG_OP = 'UPDATE' AND NEW.coupled_pair_id IS NOT DISTINCT FROM OLD.coupled_pair_id THEN
        RETURN NEW;
      END IF;

      SELECT long_leg_value, short_leg_value
        INTO v_long, v_short
        FROM coupled_pairs
       WHERE id = NEW.coupled_pair_id;

      -- An absent or NULL coupled_pair_id leaves v_long/v_short NULL, so the equality test below is
      -- NULL IS DISTINCT FROM NULL = FALSE and the trigger passes the row through. We deliberately
      -- do NOT raise here: existence is the FK's job (23503) and non-null is the NOT NULL column's
      -- job (23502) — they reject with their native codes, so this trigger owns ONLY delta-neutrality.
      IF v_long IS DISTINCT FROM v_short THEN
        RAISE EXCEPTION
          'Rose Note must embed a delta-neutral coupled pair at issuance: pair % has legs % <> %',
          NEW.coupled_pair_id, v_long, v_short
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_rose_notes_delta_neutral
      BEFORE INSERT OR UPDATE ON rose_notes
      FOR EACH ROW EXECUTE FUNCTION enforce_rose_note_delta_neutral();
  `,
  // Exact inverse, in reverse dependency order: trigger → function → table. IF EXISTS keeps resets safe.
  down: /* sql */ `
    DROP TRIGGER IF EXISTS trg_rose_notes_delta_neutral ON rose_notes;
    DROP FUNCTION IF EXISTS enforce_rose_note_delta_neutral();
    DROP TABLE IF EXISTS rose_notes;
  `,
};
