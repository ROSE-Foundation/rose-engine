// Bind the off-chain capital-movement authorization decision (`@rose/authorization`) into the
// `@rose/chain` `MintAuthorizationGate` thunk the paired-mint dual-write consults PRE-submit (Story
// 6.2). This is the `api → rose-note → authorization` composition edge: the subscription gate IS the
// SAME default-deny decision `postTransfer` consults (5.3), so a non-`ALLOW` decision vetoes the
// dual-write BEFORE any irreversible on-chain mint (fail-closed, NFR-4). Wiring the production
// DB-backed provider + the concrete subscription `TransferScenario`/floor env is the composition-root
// concern; this helper keeps the binding one-directional (rose-note depends on authorization, never
// the reverse).
import type { AuthorizationProvider, AuthorizationRequest } from '@rose/authorization';
import type { MintAuthorizationGate } from '@rose/chain';

/**
 * Wraps an `AuthorizationProvider` + a fixed `AuthorizationRequest` (scenario + env) into the
 * `MintAuthorizationGate` thunk (`() => { effect, reason }`). The provider's `AuthorizationDecision`
 * is structurally the `MintAuthorizationDecision` the gate returns (same `ALLOW | DENY | REFUSE`
 * vocabulary from `@rose/rule-spec`), so no field re-mapping is needed.
 */
export function makeProviderAuthorizeGate(
  provider: AuthorizationProvider,
  request: AuthorizationRequest,
): MintAuthorizationGate {
  return () => provider.authorize(request);
}
