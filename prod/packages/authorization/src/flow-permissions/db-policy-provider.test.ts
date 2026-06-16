// Story 3.4 — the DB-backed off-chain policy provider passes the SAME 10 shared conformance vectors
// as the reference adapter, via the off-chain `PlaneAdapter` gate (`assertProviderConforms`). This is
// the baseline the on-chain plane (Epic 4) must also satisfy (FR-8, NFR-8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conformanceVectors, generateOffChainPolicy, ruleSpecV1 } from '@rose/rule-spec';
import { createDb, createPool, hardReset, migrateUp, type RoseDb } from '@rose/ledger';
import { assertProviderConforms } from '../conformance/provider-conformance.js';
import {
  DB_OFF_CHAIN_POLICY_PROVIDER_NAME,
  loadDbOffChainPolicyProvider,
  makeDbOffChainPolicyProvider,
} from './db-policy-provider.js';
import { seedFlowPermissions } from './policy-store.js';

let pool: ReturnType<typeof createPool>;
let db: RoseDb;

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  await hardReset(pool);
  await migrateUp(pool);
  await seedFlowPermissions(db, generateOffChainPolicy(ruleSpecV1));
});

afterAll(async () => {
  await pool.end();
});

describe('DB-backed OffChainPolicyProvider — conformance (AC-2)', () => {
  it('exercises the full set of 10 shared vectors (non-vacuous)', () => {
    expect(conformanceVectors.length).toBe(10);
  });

  it('a provider loaded from flow_permissions conforms to all off-chain vectors', async () => {
    const provider = await loadDbOffChainPolicyProvider(db);
    expect(provider.name).toBe(DB_OFF_CHAIN_POLICY_PROVIDER_NAME);
    // Throws ConformanceFailureError on any divergence from the reference semantics.
    expect(() => assertProviderConforms(provider)).not.toThrow();
  });

  it('the pure (pre-loaded artifact) provider conforms identically', () => {
    const provider = makeDbOffChainPolicyProvider(generateOffChainPolicy(ruleSpecV1));
    expect(() => assertProviderConforms(provider)).not.toThrow();
  });
});
