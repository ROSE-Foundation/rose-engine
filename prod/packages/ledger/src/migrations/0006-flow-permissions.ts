// Migration 0006 — the off-chain `flow_permissions` table (FR-8, Story 3.4). It persists the
// GENERATED off-chain policy artifact (`generateOffChainPolicy(ruleSpecV1)`, Story 3.1) so the
// production `OffChainPolicyProvider` reads its rules from the single source of truth instead of
// re-authoring them. Raw SQL (SQL-first), shipped as a typed module. APPEND-ONLY after merge.
//
// One row per generated policy CLAUSE (an allow-rule, a prohibition, or a floor guard), with the
// clause object stored verbatim in `payload` (jsonb). The policy-level provenance (version, source,
// generator, defaultEffect) is carried on every row; the seeder writes one consistent artifact, and
// the loader refuses to reconstruct a policy whose rows disagree (fail-closed, NFR-4). The table is
// not the authority on the rules — codegen is — it is the persisted projection the provider reads.
import type { Migration } from '../migrate.js';

export const migration0006: Migration = {
  version: '0006_flow_permissions',
  up: /* sql */ `
    CREATE TABLE flow_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Policy-level provenance (uniform across all rows of one seeded artifact).
      policy_version text NOT NULL,
      source text NOT NULL,
      generator text NOT NULL,
      default_effect text NOT NULL,
      -- Clause discriminator + the generated clause id (e.g. 'allow-fee-income-to-treasury').
      clause_kind text NOT NULL,
      clause_id text NOT NULL,
      -- The generated clause object, stored verbatim so the artifact round-trips byte-for-byte.
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      -- One row per clause id: re-seeding the same artifact cannot create duplicate clauses.
      CONSTRAINT flow_permissions_clause_id_key UNIQUE (clause_id),
      -- Fail-closed vocabulary guards: the persisted effect/kind must be a known code.
      CONSTRAINT flow_permissions_default_effect_chk CHECK (default_effect IN ('ALLOW', 'DENY', 'REFUSE')),
      CONSTRAINT flow_permissions_clause_kind_chk CHECK (clause_kind IN ('ALLOW_RULE', 'PROHIBITION', 'FLOOR_GUARD'))
    );

    CREATE INDEX idx_flow_permissions_clause_kind ON flow_permissions (clause_kind);
  `,
  // Exact inverse: the index drops with the table, so dropping the table suffices. IF EXISTS keeps
  // resets safe regardless of partially-applied state.
  down: /* sql */ `
    DROP TABLE IF EXISTS flow_permissions;
  `,
};
