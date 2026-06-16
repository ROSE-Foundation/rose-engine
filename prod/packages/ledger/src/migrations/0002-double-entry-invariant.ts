// Migration 0002 — journal entries, postings, and the double-entry balance invariant
// enforced IN the database (FR-3, NFR-1). The invariant is a `DEFERRABLE INITIALLY DEFERRED`
// CONSTRAINT TRIGGER on `postings`, checked at COMMIT, asserting Σ debits = Σ credits per
// journal entry. An unbalanced entry fails the transaction with no partial state, regardless
// of application path. APPEND-ONLY after merge.
import type { Migration } from '../migrate.js';

export const migration0002: Migration = {
  version: '0002_double_entry_invariant',
  up: /* sql */ `
    CREATE TYPE posting_direction AS ENUM ('DEBIT', 'CREDIT');

    CREATE TABLE journal_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      description text NOT NULL,
      coupled_pair_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT journal_entries_description_nonempty CHECK (length(btrim(description)) > 0)
    );

    CREATE TABLE postings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES accounts(id),
      direction posting_direction NOT NULL,
      amount numeric NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT postings_amount_positive CHECK (amount > 0),
      -- Amounts are integers in the smallest unit (NFR-2) — reject fractional NUMERIC.
      CONSTRAINT postings_amount_integer CHECK (amount = trunc(amount))
    );
    CREATE INDEX idx_postings_journal_entry_id ON postings (journal_entry_id);

    -- Balance check: within each journal entry, Σ(DEBIT) must equal Σ(CREDIT) PER
    -- (asset, decimal_scale). You cannot net EUR against BTC, nor amounts at different
    -- scales — raw-sum equality across units would "balance" economically-nonsense entries.
    -- On UPDATE that moves a posting between entries, BOTH the source (OLD) and destination
    -- (NEW) entries are re-validated.
    CREATE FUNCTION check_double_entry_balance() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      affected uuid[] := ARRAY[]::uuid[];
      je uuid;
      bad RECORD;
    BEGIN
      IF TG_OP <> 'DELETE' THEN
        affected := array_append(affected, NEW.journal_entry_id);
      END IF;
      IF TG_OP <> 'INSERT' THEN
        affected := array_append(affected, OLD.journal_entry_id);
      END IF;

      FOREACH je IN ARRAY affected LOOP
        SELECT a.asset AS asset,
               a.decimal_scale AS scale,
               COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0) AS total_debit,
               COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0) AS total_credit
        INTO bad
        FROM postings p
        JOIN accounts a ON a.id = p.account_id
        WHERE p.journal_entry_id = je
        GROUP BY a.asset, a.decimal_scale
        HAVING COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'DEBIT'), 0)
            <> COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'CREDIT'), 0)
        LIMIT 1;

        IF FOUND THEN
          RAISE EXCEPTION
            'Double-entry invariant violated for journal_entry % asset % (scale %): debits % <> credits %',
            je, bad.asset, bad.scale, bad.total_debit, bad.total_credit;
        END IF;
      END LOOP;
      RETURN NULL;
    END;
    $$;

    -- DEFERRABLE INITIALLY DEFERRED: the check runs at COMMIT, so a balanced multi-row
    -- insert passes even though intermediate states are transiently unbalanced.
    CREATE CONSTRAINT TRIGGER trg_postings_double_entry
      AFTER INSERT OR UPDATE OR DELETE ON postings
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_double_entry_balance();
  `,
  down: /* sql */ `
    DROP TRIGGER IF EXISTS trg_postings_double_entry ON postings;
    DROP FUNCTION IF EXISTS check_double_entry_balance();
    DROP TABLE IF EXISTS postings;
    DROP TABLE IF EXISTS journal_entries;
    DROP TYPE IF EXISTS posting_direction;
  `,
};
