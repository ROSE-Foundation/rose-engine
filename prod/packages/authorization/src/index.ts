// @rose/authorization — the substitutable, default-deny authorization seam (Story 3.2).
//
// Public surface consumed by `postTransfer` (Story 3.3) and extended by the production
// `OffChainPolicyProvider` (Story 3.4). The package CONSUMES `@rose/rule-spec` (the single source
// of truth) for its decision vocabulary, conformance vectors, and reference semantics — it never
// re-authors rules. Authorization is fail-closed by construction (`DEFAULT_EFFECT` is `DENY`).

/** Package identifier. */
export const AUTHORIZATION_PACKAGE_NAME = '@rose/authorization' as const;

// The decision vocabulary, re-exported for convenience (single source: @rose/rule-spec).
export type { Effect } from '@rose/rule-spec';

// The substitutable interface + request/decision contract + fail-closed default.
export type {
  AuthorizationDecision,
  AuthorizationProvider,
  AuthorizationRequest,
} from './provider/authorization-provider.js';
export { DEFAULT_EFFECT, denyByDefault } from './provider/authorization-provider.js';

// Provider implementations: the fail-closed baseline + the policy-backed conformant provider.
export { makeDefaultDenyProvider } from './provider/default-deny-provider.js';
export { makePolicyAuthorizationProvider } from './provider/policy-authorization-provider.js';

// Substitutability/conformance gate: bridge any provider into the shared Story-3.1 harness.
export {
  assertProviderConforms,
  providerToPlaneAdapter,
} from './conformance/provider-conformance.js';

// The single off-chain capital-movement chokepoint (Story 3.3): authorize-before-write, fail-closed.
export { postTransfer, InvalidTransferError, TransferRefusedError } from './post-transfer.js';
export type {
  PostTransferContext,
  TransferDecisionLog,
  TransferDestination,
  TransferLogger,
  TransferReceipt,
  TransferSource,
} from './post-transfer.js';

// Story 3.4 — the production DB-backed off-chain policy provider over `flow_permissions`
// (generated from the rule-spec), the persisted-state binding, and the chokepoint wiring.
export {
  seedFlowPermissions,
  loadOffChainPolicy,
  EmptyFlowPolicyError,
  InconsistentFlowPolicyError,
} from './flow-permissions/policy-store.js';
export {
  loadDbOffChainPolicyProvider,
  makeDbOffChainPolicyProvider,
  DB_OFF_CHAIN_POLICY_PROVIDER_NAME,
} from './flow-permissions/db-policy-provider.js';
export {
  loadAccountFacts,
  assertAccountTypeMatches,
  readAccountBalance,
  AccountFactMismatchError,
  AccountNotFoundError,
} from './flow-permissions/account-state.js';
export type { PersistedAccountFacts } from './flow-permissions/account-state.js';
export { resolveOffChainEnv, backingFloatFloorFrom } from './flow-permissions/resolve-env.js';
export type { ResolveEnvInput } from './flow-permissions/resolve-env.js';
export { enforceTransfer } from './flow-permissions/enforce-transfer.js';
export type { EnforceTransferContext } from './flow-permissions/enforce-transfer.js';
