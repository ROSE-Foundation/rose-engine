// @rose/authorization — the production DB-backed off-chain policy provider (Story 3.4, FR-8).
//
// This is the production `OffChainPolicyProvider`: it loads the policy from the `flow_permissions`
// table and serves authorization decisions by DELEGATING to the Story-3.1 reference semantics over
// that loaded artifact (via `makePolicyAuthorizationProvider`). It re-authors NO rule logic — the
// decisions are identical to the reference adapter's, which is why it passes the same conformance
// vectors. Because it is a substitutable `AuthorizationProvider`, wiring it into `postTransfer`
// requires ZERO change to the chokepoint (NFR-8).
import type { RoseExecutor } from '@rose/ledger';
import type { OffChainPolicyArtifact } from '@rose/rule-spec';
import type { AuthorizationProvider } from '../provider/authorization-provider.js';
import { makePolicyAuthorizationProvider } from '../provider/policy-authorization-provider.js';
import { loadOffChainPolicy } from './policy-store.js';

/** The provider name surfaced on decisions/conformance reports for the DB-backed off-chain plane. */
export const DB_OFF_CHAIN_POLICY_PROVIDER_NAME = 'db-off-chain-policy';

/**
 * Build the DB-backed provider from an already-loaded policy artifact (pure; no I/O). Useful when a
 * caller wants to load once and reuse the provider across many transfers.
 */
export function makeDbOffChainPolicyProvider(
  policy: OffChainPolicyArtifact,
  name = DB_OFF_CHAIN_POLICY_PROVIDER_NAME,
): AuthorizationProvider {
  return makePolicyAuthorizationProvider(policy, name);
}

/**
 * Load the off-chain policy from `flow_permissions` and return a conformant `AuthorizationProvider`.
 * Fail-closed: if the table is empty or inconsistent, `loadOffChainPolicy` throws and no permissive
 * provider is produced (NFR-4).
 */
export async function loadDbOffChainPolicyProvider(
  executor: RoseExecutor,
  name = DB_OFF_CHAIN_POLICY_PROVIDER_NAME,
): Promise<AuthorizationProvider> {
  const policy = await loadOffChainPolicy(executor);
  return makeDbOffChainPolicyProvider(policy, name);
}
