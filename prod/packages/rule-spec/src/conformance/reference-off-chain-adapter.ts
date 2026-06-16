// @rose/rule-spec — the REFERENCE off-chain plane adapter (Story 3.1).
//
// This adapter defines the SEMANTICS of the generated off-chain policy artifact: it is the
// conformance baseline the production off-chain provider (Story 3.4, reading DB `flow_permissions`)
// and the on-chain compliance plane (Epic 4) must reproduce. It is NOT the production provider —
// it has no DB, no `@rose/config`, and no `postTransfer`; it evaluates the in-memory artifact.
import type { OffChainPolicyArtifact, Prohibition } from '../codegen/generate-off-chain-policy.js';
import type { Effect } from '../spec/rule-spec-schema.js';
import type { ConformanceEnv, PlaneAdapter, TransferScenario } from './types.js';

function isPrincipalEgressProhibited(
  prohibition: Extract<Prohibition, { kind: 'PRINCIPAL_EGRESS' }>,
  scenario: TransferScenario,
): boolean {
  return (
    scenario.from === prohibition.protectedAccountType &&
    scenario.classification === prohibition.protectedClassification &&
    scenario.to !== prohibition.allowedDestination
  );
}

function isRouteThroughEntityProhibited(
  prohibition: Extract<Prohibition, { kind: 'ROUTE_THROUGH_ENTITY' }>,
  scenario: TransferScenario,
): boolean {
  // P0 encodes routing through VCC via the scenario's `throughVcc` flag for the given asset kind.
  return (
    prohibition.entity === 'VCC' &&
    scenario.assetKind === prohibition.assetKind &&
    scenario.throughVcc === true
  );
}

/**
 * Build a {@link PlaneAdapter} whose decisions are derived purely from a generated artifact.
 *
 * Resolution order (fail-closed). Absolute prohibitions are evaluated FIRST so a structural
 * bright-line always wins over any floor/config consideration; floor handling is scoped to the
 * matched allow-rule (not the source account), so a flow with no allow-rule cannot leak a REFUSE:
 *
 *  1. DENY — a prohibition matches (Model-A principal egress, or a token flow routed via VCC).
 *     A prohibition is unconditional; it never degrades to REFUSE on absent config.
 *  2. Find the matching allow-rule (from accountType+classification → destination). If none, the
 *     flow is uncovered ⇒ fall through to the fail-closed default (DENY) — NOT a floor REFUSE.
 *  3. If the matched allow-rule has a floor guard:
 *       - floor config ABSENT (`env.backingFloatFloor` undefined) ⇒ REFUSE (never assume 0, NFR-4).
 *       - the move is NOT proven to stay at/above the floor (`postBalanceBelowFloor !== false`)
 *         ⇒ DENY (fail-closed: the egress must affirmatively prove it stays above the floor).
 *       - otherwise ⇒ ALLOW.
 *  4. A matched allow-rule with no floor guard ⇒ ALLOW.
 *  5. Fail-closed default (DENY).
 */
export function makeReferenceOffChainAdapter(policy: OffChainPolicyArtifact): PlaneAdapter {
  return {
    name: 'reference-off-chain',
    plane: 'OFF_CHAIN',
    evaluate(scenario: TransferScenario, env: ConformanceEnv): Effect {
      // (1) Structural prohibitions are absolute — they deny regardless of allow-rules or config.
      for (const prohibition of policy.prohibitions) {
        if (
          prohibition.kind === 'PRINCIPAL_EGRESS' &&
          isPrincipalEgressProhibited(prohibition, scenario)
        ) {
          return 'DENY';
        }
        if (
          prohibition.kind === 'ROUTE_THROUGH_ENTITY' &&
          isRouteThroughEntityProhibited(prohibition, scenario)
        ) {
          return 'DENY';
        }
      }

      // (2) Find the allow-rule (if any) that permits this exact flow.
      const matchedAllow = policy.allowRules.find(
        (rule) =>
          rule.from.accountType === scenario.from &&
          rule.from.classification === scenario.classification &&
          rule.to === scenario.to,
      );
      if (matchedAllow === undefined) {
        // (5) Uncovered flow ⇒ fail-closed default (not a floor REFUSE).
        return policy.defaultEffect;
      }

      // (3) Floor guard scoped to THIS allow-rule.
      const floorGuard = policy.floorGuards.find((g) => g.allowRuleId === matchedAllow.id);
      if (floorGuard !== undefined) {
        if (env.backingFloatFloor === undefined) {
          return 'REFUSE'; // floor config absent — never assume 0 (NFR-4).
        }
        if (env.postBalanceBelowFloor !== false) {
          return 'DENY'; // fail-closed: must prove the move stays at/above the floor.
        }
      }

      // (4) Permitted.
      return 'ALLOW';
    },
  };
}
