// Migration 0008 — the `entities.role` column (Treasury Dashboard enrichment). Each of the four
// fixed entities plays a STATIC operational role surfaced on the dashboard's cross-entity table.
// The roles are facts of the four fixed entities, seeded deterministically here (mirroring the
// 0001 entity seed) so a forward→down→forward cycle restores identical role assignments (NFR-5).
// Raw SQL (SQL-first), shipped as a typed module. APPEND-ONLY after merge.
import type { Migration } from '../migrate.js';

export const migration0008: Migration = {
  version: '0008_entity_role',
  // Add the enum + a nullable column, backfill each fixed entity's real role, then make it NOT NULL.
  // The backfill keys on the stable entity `code`, so it is independent of the seeded uuids.
  up: /* sql */ `
    CREATE TYPE entity_role AS ENUM ('TREASURY_NOTE_ISSUER', 'COORDINATION', 'TRADING', 'COIN_ISSUANCE');
    ALTER TABLE entities ADD COLUMN role entity_role;
    UPDATE entities SET role = 'TREASURY_NOTE_ISSUER' WHERE code = 'VCC';
    UPDATE entities SET role = 'COORDINATION' WHERE code = 'HOLDING';
    UPDATE entities SET role = 'TRADING' WHERE code = 'TRADING_CO';
    UPDATE entities SET role = 'COIN_ISSUANCE' WHERE code = 'COIN_ISSUER';
    ALTER TABLE entities ALTER COLUMN role SET NOT NULL;
  `,
  // Exact inverse. Drop the column first (it depends on the type), then the type. IF EXISTS keeps
  // resets safe under partial state.
  down: /* sql */ `
    ALTER TABLE entities DROP COLUMN IF EXISTS role;
    DROP TYPE IF EXISTS entity_role;
  `,
};
