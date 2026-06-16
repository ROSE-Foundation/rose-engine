// Story 3.4 — the `flow_permissions` policy store: single-source seeding + byte-identical round-trip
// + fail-closed reconstruction. Test-first on the invariants (NFR-6, NFR-4).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateOffChainPolicy, ruleSpecV1 } from '@rose/rule-spec';
import { createDb, createPool, hardReset, migrateUp, type RoseDb } from '@rose/ledger';
import {
  EmptyFlowPolicyError,
  InconsistentFlowPolicyError,
  loadOffChainPolicy,
  seedFlowPermissions,
} from './policy-store.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

const ARTIFACT = generateOffChainPolicy(ruleSpecV1);
// 4 allow-rules + 2 prohibitions + 1 floor guard in the P0 rule-spec.
const EXPECTED_ROWS =
  ARTIFACT.allowRules.length + ARTIFACT.prohibitions.length + ARTIFACT.floorGuards.length;

async function countRows(): Promise<number> {
  const r = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM flow_permissions');
  return Number(r.rows[0]!.n);
}

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE flow_permissions');
});

describe('seedFlowPermissions / loadOffChainPolicy (AC-1, single source)', () => {
  it('seeds one row per generated clause', async () => {
    await seedFlowPermissions(db, ARTIFACT);
    expect(await countRows()).toBe(EXPECTED_ROWS);
    expect(EXPECTED_ROWS).toBe(7);
  });

  it('round-trips the generated artifact byte-for-byte (no rule re-authoring)', async () => {
    await seedFlowPermissions(db, ARTIFACT);
    const loaded = await loadOffChainPolicy(db);
    // The reconstructed artifact equals the codegen output exactly — proving the DB is a faithful
    // projection of the single source, not an independently-authored rule set.
    expect(loaded).toEqual(ARTIFACT);
  });

  it('is idempotent: re-seeding converges (no duplicate clauses)', async () => {
    await seedFlowPermissions(db, ARTIFACT);
    await seedFlowPermissions(db, ARTIFACT);
    expect(await countRows()).toBe(EXPECTED_ROWS);
    expect(await loadOffChainPolicy(db)).toEqual(ARTIFACT);
  });
});

describe('loadOffChainPolicy — fail-closed (NFR-4)', () => {
  it('refuses an empty flow_permissions table (never a vacuous ALLOW)', async () => {
    await expect(loadOffChainPolicy(db)).rejects.toBeInstanceOf(EmptyFlowPolicyError);
  });

  it('refuses rows that disagree on policy-level metadata', async () => {
    await seedFlowPermissions(db, ARTIFACT);
    // Corrupt a single row so the seed is no longer uniform.
    await pool.query(
      `UPDATE flow_permissions SET policy_version = '9.9.9' WHERE clause_id = 'prohibit-model-a-principal-egress'`,
    );
    await expect(loadOffChainPolicy(db)).rejects.toBeInstanceOf(InconsistentFlowPolicyError);
  });

  it('refuses a persisted non-DENY default effect (must be fail-closed)', async () => {
    await seedFlowPermissions(db, ARTIFACT);
    await pool.query(`UPDATE flow_permissions SET default_effect = 'ALLOW'`);
    await expect(loadOffChainPolicy(db)).rejects.toBeInstanceOf(InconsistentFlowPolicyError);
  });

  it('refuses a row whose payload id no longer matches its clause_id (tamper guard)', async () => {
    await seedFlowPermissions(db, ARTIFACT);
    // Re-key a clause so its persisted clause_id diverges from the payload's own id.
    await pool.query(
      `UPDATE flow_permissions SET clause_id = 'tampered' WHERE clause_id = 'allow-fee-income-to-treasury'`,
    );
    await expect(loadOffChainPolicy(db)).rejects.toBeInstanceOf(InconsistentFlowPolicyError);
  });
});

describe('seedFlowPermissions — atomic / composable', () => {
  it('seeds within an outer transaction (nested savepoint) and the policy loads', async () => {
    await db.transaction(async (tx) => {
      await seedFlowPermissions(tx, ARTIFACT);
    });
    expect(await loadOffChainPolicy(db)).toEqual(ARTIFACT);
  });
});
