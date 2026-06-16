// @rose/authorization — an in-memory, policy-backed conformant provider (Story 3.2, AC-2).
//
// This provider DELEGATES its decisions to the Story-3.1 reference semantics
// (`makeReferenceOffChainAdapter`) over a generated off-chain policy artifact. It therefore
// reproduces the single-source rule decisions WITHOUT re-authoring any rule logic, and passes the
// shared conformance vectors (it is a substitutable, conformant implementation of the interface).
//
// SCOPE GUARD: this is NOT the Story-3.4 production `OffChainPolicyProvider`. It has no DB
// `flow_permissions` table and no `@rose/config` floor resolution — it evaluates the in-memory
// artifact. Story 3.4 supplies the DB-backed provider that must reproduce these same semantics
// (proven by running the SAME vectors through the SAME harness).
import type { Effect, OffChainPolicyArtifact } from '@rose/rule-spec';
import { makeReferenceOffChainAdapter } from '@rose/rule-spec';
import type { AuthorizationDecision, AuthorizationProvider } from './authorization-provider.js';

/**
 * Human-readable reason for each terminal effect, recorded on the decision for the audit trail.
 * The reference adapter collapses every DENY origin (a structural prohibition, an uncovered flow,
 * or a guarded-floor breach) into the bare `'DENY'` effect, so the DENY reason is written to cover
 * ALL three origins without falsely claiming the flow was "not explicitly permitted".
 */
function reasonFor(effect: Effect): string {
  switch (effect) {
    case 'ALLOW':
      return 'permitted by an explicit allow-rule in the off-chain policy';
    case 'REFUSE':
      return 'refused: a required floor parameter is absent (never assumed 0, NFR-4)';
    case 'DENY':
      return 'denied (fail-closed): the transfer is prohibited, not explicitly permitted, or would breach a guarded floor';
    default: {
      // Exhaustiveness guard: a new Effect member becomes a compile error here, not a silent
      // `undefined` reason.
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

/**
 * Build a substitutable `AuthorizationProvider` whose decisions are derived purely from a generated
 * off-chain policy artifact, via the shared reference adapter. Pure: no I/O, no DB, no network.
 */
export function makePolicyAuthorizationProvider(
  policy: OffChainPolicyArtifact,
  name = 'policy',
): AuthorizationProvider {
  const adapter = makeReferenceOffChainAdapter(policy);
  return {
    name,
    authorize(request): AuthorizationDecision {
      const effect = adapter.evaluate(request.scenario, request.env);
      return { effect, reason: reasonFor(effect) };
    },
  };
}
