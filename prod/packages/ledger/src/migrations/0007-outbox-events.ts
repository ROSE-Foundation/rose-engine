// Migration 0007 — the `outbox_events` table (NFR-9 / NFR-3, Story 5.2). It persists the
// outbox/saga dual-write state machine where the on-chain transaction is the COMMIT POINT: the
// off-chain intent is recorded (PENDING) → the on-chain tx is submitted (SUBMITTED, tx hash stored)
// → and the matching balanced journal entry is posted ONLY after on-chain confirmation (CONFIRMED).
// Failures move to FAILED and are compensated (COMPENSATED) or caught by reconciliation (5.6).
// Raw SQL (SQL-first), shipped as a typed module. APPEND-ONLY after merge.
//
// Idempotency is DB-enforced in two layers (NFR-9): `idempotency_key UNIQUE` makes recording an
// intent exactly-once for a logical operation; `tx_hash UNIQUE` makes a confirmed tx apply its
// ledger effect at most once even under watcher re-delivery / reorg re-scan (Postgres treats the
// many NULL tx_hash values of not-yet-submitted rows as distinct, so the constraint binds only on
// submitted rows). The table is the persisted projection the saga (`@rose/chain/src/outbox`) drives.
//
// This migration ALSO adds a nullable `tx_hash` column to `journal_entries` (NFR-3 — the on-chain
// tx hash recorded on the related journal entry). It is nullable with no default, so every entry
// recorded before this migration (and every off-chain-only entry) is unaffected.
import type { Migration } from '../migrate.js';

export const migration0007: Migration = {
  version: '0007_outbox_events',
  up: /* sql */ `
    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Logical-operation idempotency key: recording the same intent twice returns the same row.
      idempotency_key text NOT NULL,
      -- The dual-write operation this row carries (named here; mintPair/burnPair land in 5.3/5.4).
      operation_kind text NOT NULL,
      -- Saga lifecycle. The ONLY transition that posts a journal entry is SUBMITTED -> CONFIRMED.
      status text NOT NULL DEFAULT 'PENDING',
      -- The intent, stored verbatim (amounts as decimal strings — never a binary float, NFR-2).
      payload jsonb NOT NULL,
      -- Set when the on-chain tx is submitted; the commit point is its CONFIRMATION, not submission.
      tx_hash text,
      -- Set at confirmation: the balanced journal entry posted for this dual-write (NFR-3 link).
      journal_entry_id uuid REFERENCES journal_entries (id),
      -- Observability for retries/compensation.
      last_error text,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Idempotency: one row per logical operation; one row per on-chain tx (NULLs are distinct).
      CONSTRAINT outbox_events_idempotency_key_key UNIQUE (idempotency_key),
      CONSTRAINT outbox_events_tx_hash_key UNIQUE (tx_hash),
      -- Fail-closed vocabulary guards: the persisted kind/status must be a known code.
      CONSTRAINT outbox_events_operation_kind_chk CHECK (operation_kind IN ('PAIR_MINT', 'PAIR_BURN')),
      CONSTRAINT outbox_events_status_chk CHECK (status IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'COMPENSATED'))
    );

    CREATE INDEX idx_outbox_events_status ON outbox_events (status);

    -- NFR-3: the on-chain tx hash recorded on the related journal entry. Nullable, no default, so
    -- all pre-existing and off-chain-only journal entries are unaffected.
    ALTER TABLE journal_entries ADD COLUMN tx_hash text;
    -- One on-chain tx maps to exactly one journal entry (NFR-3). NULLs are distinct in Postgres, so
    -- this binds only on stamped entries; it is the fail-closed DB backstop that makes a duplicate
    -- ledger post for the same confirmed tx (e.g. a racing/replayed confirm) impossible.
    ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_tx_hash_key UNIQUE (tx_hash);
  `,
  // Exact inverse. The index drops with the table; drop the table first (it FK-references
  // journal_entries), then remove the column. IF EXISTS keeps resets safe under partial state.
  down: /* sql */ `
    DROP TABLE IF EXISTS outbox_events;
    ALTER TABLE journal_entries DROP COLUMN IF EXISTS tx_hash;
  `,
};
