// @rose/authorization — the provider substitutability/conformance gate (Story 3.2, AC-2, NFR-8).
//
// REUSES the Story-3.1 shared vectors + `runConformance` harness (no vectors/harness/error are
// redefined here). The bridge adapts any `AuthorizationProvider` into a rule-spec `PlaneAdapter`,
// so the SAME vectors that gate the reference adapter also gate any provider — that is how
// "any conformant provider passes the same vectors" is enforced and how off-chain and on-chain
// rule sets are kept from silently diverging.
import type { ConformanceVector, Plane, PlaneAdapter } from '@rose/rule-spec';
import { assertAllConform, conformanceVectors, runConformance } from '@rose/rule-spec';
import type { AuthorizationProvider } from '../provider/authorization-provider.js';

/**
 * Adapt an {@link AuthorizationProvider} into a rule-spec {@link PlaneAdapter} so it can be driven
 * by the shared conformance harness. The provider's `AuthorizationDecision.effect` IS the adapter's
 * evaluated {@link import('@rose/rule-spec').Effect} — a lossless bridge (the request shapes are the
 * harness's own `TransferScenario` + `ConformanceEnv`).
 */
export function providerToPlaneAdapter(
  provider: AuthorizationProvider,
  plane: Plane = 'OFF_CHAIN',
): PlaneAdapter {
  return {
    name: provider.name,
    plane,
    evaluate(scenario, env) {
      return provider.authorize({ scenario, env }).effect;
    },
  };
}

/**
 * Assert a provider conforms to the shared vectors for its plane. Bridges → `runConformance` →
 * `assertAllConform`; throws the rule-spec `ConformanceFailureError` (listing mismatches) on any
 * divergence. The reusable conformance gate for ANY provider implementation.
 */
export function assertProviderConforms(
  provider: AuthorizationProvider,
  vectors: readonly ConformanceVector[] = conformanceVectors,
  plane: Plane = 'OFF_CHAIN',
): void {
  const adapter = providerToPlaneAdapter(provider, plane);
  const results = runConformance(adapter, vectors);
  // Coverage guard: `runConformance` silently skips vectors for other planes, so an empty/mis-tagged
  // vector set would make `assertAllConform` pass vacuously. Refuse to certify on zero vectors —
  // a green-but-meaningless gate is worse than a loud failure for the 3.4 / Epic-4 consumers.
  if (results.length === 0) {
    throw new Error(
      `assertProviderConforms: no conformance vectors matched plane "${plane}" — ` +
        'the gate would pass vacuously. Provide vectors tagged for this plane.',
    );
  }
  assertAllConform(adapter, results);
}
