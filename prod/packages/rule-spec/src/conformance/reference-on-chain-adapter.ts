// @rose/rule-spec — the REFERENCE on-chain plane adapter (Story 4.5).
//
// This is the symmetric counterpart of `makeReferenceOffChainAdapter`. It defines the SEMANTICS of
// the generated ON-CHAIN compliance config: the conformance baseline the on-chain ERC-3643
// compliance plane (Epic 4 contracts) reproduces. It is NOT a contract or a chain client — it
// evaluates the in-memory generated config. It MUST agree, vector-for-vector, with the off-chain
// reference adapter; that agreement IS the FR-19 / SM-4 dual-plane-equivalence proof (the
// dual-plane conformance test fails if the two emitters ever diverge).
//
// Convened on-chain equivalences (proven on the real contracts by the Foundry suite):
//   - curated allowlist          == `IdentityRegistry` (registration presupposes off-chain KYC/AML)
//   - eligibility claim topic     == `uint256(keccak256("ONCHAINID_KYC"))` (`ClaimTopics.ONCHAINID_KYC`)
//   - Model-A bright line         == `CoupledLeg` segregated-principal guard (Story 4.4)
//   - pair coupling               == `CoupledPair` atomic mint/burn (Story 4.3)
import type { Prohibition } from '../codegen/generate-off-chain-policy.js';
import type { OnChainComplianceConfig } from '../codegen/generate-on-chain-config.js';
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
  return (
    prohibition.entity === 'VCC' &&
    scenario.assetKind === prohibition.assetKind &&
    scenario.throughVcc === true
  );
}

/**
 * Build a {@link PlaneAdapter} whose decisions are derived purely from the generated on-chain
 * compliance config. The resolution order is IDENTICAL to the off-chain reference adapter
 * (fail-closed) — keeping them in lockstep is the whole point: a divergence between the two
 * emitters surfaces as a cross-plane conformance failure.
 *
 *  1. DENY — a prohibition matches (Model-A principal egress, or a token flow routed via VCC).
 *  2. Find the matching allow-flow (from accountType+classification → destination). If none, the
 *     flow is uncovered ⇒ fall through to the fail-closed default (DENY).
 *  3. If the matched allow-flow has a floor guard:
 *       - floor config ABSENT ⇒ REFUSE (never assume 0, NFR-4).
 *       - not proven to stay at/above the floor ⇒ DENY (fail-closed).
 *       - otherwise ⇒ ALLOW.
 *  4. A matched allow-flow with no floor guard ⇒ ALLOW.
 *  5. Fail-closed default (DENY).
 */
export function makeReferenceOnChainAdapter(config: OnChainComplianceConfig): PlaneAdapter {
  return {
    name: 'reference-on-chain',
    plane: 'ON_CHAIN',
    evaluate(scenario: TransferScenario, env: ConformanceEnv): Effect {
      // (1) Structural prohibitions are absolute — they deny regardless of allow-flows or config.
      for (const prohibition of config.prohibitions) {
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

      // (2) Find the allow-flow (if any) that permits this exact flow.
      const matchedAllow = config.allowFlows.find(
        (rule) =>
          rule.from.accountType === scenario.from &&
          rule.from.classification === scenario.classification &&
          rule.to === scenario.to,
      );
      if (matchedAllow === undefined) {
        // (5) Uncovered flow ⇒ fail-closed default (not a floor REFUSE).
        return config.defaultEffect;
      }

      // (3) Floor guard scoped to THIS allow-flow.
      const floorGuard = config.floorGuards.find((g) => g.allowRuleId === matchedAllow.id);
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
