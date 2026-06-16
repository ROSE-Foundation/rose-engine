// Migration 0001 — the four fixed entities and typed accounts (FR-1, NFR-5).
// Raw SQL (SQL-first), shipped as a typed module so it travels with the compiled code.
// APPEND-ONLY after merge: never edit this; add a new 0002+ pair instead.
import type { Migration } from '../migrate.js';

export const migration0001: Migration = {
  version: '0001_entities_accounts',
  up: /* sql */ `
    CREATE TYPE entity_code AS ENUM ('VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER');
    CREATE TYPE account_type AS ENUM (
      'BACKING_FLOAT', 'DEPLOYED_CAPITAL', 'CLIENT_COLLATERAL', 'FEE_INCOME', 'NOTE_LIABILITY'
    );

    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code entity_code NOT NULL UNIQUE,
      jurisdiction text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id),
      type account_type NOT NULL,
      asset text NOT NULL,
      decimal_scale smallint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT accounts_entity_type_asset_uq UNIQUE (entity_id, type, asset),
      CONSTRAINT accounts_decimal_scale_nonneg CHECK (decimal_scale >= 0)
    );
    CREATE INDEX idx_accounts_entity_id ON accounts (entity_id);

    -- Seed exactly the four fixed entities with DETERMINISTIC ids, so that a
    -- forward→down→forward cycle restores identical entity identity (NFR-5 reversibility:
    -- random uuids would change on re-seed). jurisdiction is a free-text placeholder
    -- (§8 Q3 parked); it is NOT a refuse-if-absent config parked parameter.
    INSERT INTO entities (id, code, jurisdiction) VALUES
      ('00000000-0000-4000-8000-000000000001', 'VCC', 'UNSPECIFIED'),
      ('00000000-0000-4000-8000-000000000002', 'HOLDING', 'UNSPECIFIED'),
      ('00000000-0000-4000-8000-000000000003', 'TRADING_CO', 'UNSPECIFIED'),
      ('00000000-0000-4000-8000-000000000004', 'COIN_ISSUER', 'UNSPECIFIED');
  `,
  // Exact inverse, in reverse dependency order. IF EXISTS keeps it safe for test resets.
  down: /* sql */ `
    DROP TABLE IF EXISTS accounts;
    DROP TABLE IF EXISTS entities;
    DROP TYPE IF EXISTS account_type;
    DROP TYPE IF EXISTS entity_code;
  `,
};
