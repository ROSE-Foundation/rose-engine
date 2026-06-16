// @rose/rule-spec — codegen: derive the ON-CHAIN compliance config from the rule spec (Story 4.5).
//
// `generateOnChainComplianceConfig` is the symmetric, on-chain analogue of
// `generateOffChainPolicy`: a PURE, DETERMINISTIC function (same spec in ⇒ byte-identical config
// out, stable id ordering) that derives the on-chain ERC-3643 compliance configuration from the
// SAME single source (`ruleSpecV1`). Together the two emitters guarantee the off-chain
// `flow_permissions` plane and the on-chain compliance plane cannot silently diverge (FR-19, §8 Q5,
// SM-4). Nothing here touches a DB, the network, or a contract — it emits a config artifact only.
//
// Topic-id materialization: the on-chain claim-topic id is `uint256(keccak256(utf8(label)))`. The
// EVM is the authority for that hash, so this config carries the topic LABEL (the single-sourced
// input) and the generated Solidity library (`generate-on-chain-solidity.ts`) materializes the
// numeric id where the EVM computes it. We deliberately do NOT add a keccak256 dependency here —
// the package stays a thin zod-only leaf (see rule-spec-schema.ts).
import type { AccountTypeCode, Classification, RuleSpec } from '../spec/rule-spec-schema.js';
// Reuse the SHARED rule vocabulary from the off-chain emitter so both planes speak ONE set of
// shapes (no divergent forks). These are intentionally NOT re-exported from here — the package
// barrel exports them once, from `generate-off-chain-policy.js`, to avoid a duplicate-name conflict.
import type {
  ArtifactProvenance,
  FloorGuard,
  FlowPermissionRule,
  Prohibition,
} from './generate-off-chain-policy.js';

/** How the on-chain numeric topic id is derived from a label (materialized by the EVM). */
export const CLAIM_TOPIC_DERIVATION = 'uint256(keccak256(utf8(label)))' as const;

/** A required eligibility claim topic, carried as its single-sourced LABEL + derivation note. */
export interface OnChainClaimTopic {
  readonly label: string;
  readonly derivation: typeof CLAIM_TOPIC_DERIVATION;
}

/** The on-chain eligibility contract: curated allowlist == `IdentityRegistry` + required topics. */
export interface OnChainEligibility {
  readonly requireAllowlist: boolean;
  readonly requiredClaimTopics: readonly OnChainClaimTopic[];
}

/** On-chain pair-coupling params (enforced by `CoupledPair`, Story 4.3). */
export interface OnChainCoupling {
  readonly atomicPairedMintBurn: boolean;
  readonly singleLegForbidden: boolean;
}

/** On-chain Model-A bright-line params (enforced by `CoupledLeg` segregated principal, Story 4.4). */
export interface OnChainModelA {
  readonly protectedAccountType: AccountTypeCode;
  readonly protectedClassification: Classification;
  readonly rule: 'PRINCIPAL_MUST_NOT_LEAVE_CLIENT';
  readonly allowedDestination: 'CLIENT_ACCOUNT';
}

/**
 * The generated on-chain compliance config. `defaultEffect` is DENY (fail-closed). The
 * `allowFlows`/`prohibitions`/`floorGuards` reuse the SAME shapes as the off-chain artifact so the
 * two planes share one rule vocabulary; the on-chain-specific projection adds `eligibility`,
 * `coupling`, and `modelA` (the ERC-3643 primitives the contracts enforce).
 */
export interface OnChainComplianceConfig {
  readonly _generated: ArtifactProvenance;
  readonly version: string;
  readonly defaultEffect: 'DENY';
  readonly eligibility: OnChainEligibility;
  readonly coupling: OnChainCoupling;
  readonly modelA: OnChainModelA;
  readonly allowFlows: readonly FlowPermissionRule[];
  readonly prohibitions: readonly Prohibition[];
  readonly floorGuards: readonly FloorGuard[];
}

const GENERATOR_ID = '@rose/rule-spec/codegen/generate-on-chain-config';

/** Claim-topic labels must be EVM-identifier-safe so the Solidity emitter can name a constant. */
const IDENTIFIER_SAFE = /^[A-Z][A-Z0-9_]*$/;

/** Stable ascending sort by `id` so re-generation is byte-identical (drift-detectable). */
function byId<T extends { readonly id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Derive the on-chain compliance config from a validated rule spec. Deterministic and pure.
 *
 * - `eligibility` mirrors `spec.eligibility` (allowlist flag + the required claim-topic LABELS).
 * - `coupling` / `modelA` mirror `spec.pairCoupling` / `spec.modelABrightLine`.
 * - `allowFlows` = each `transferRestrictions.allow` rule (effect ALLOW), identical to the
 *   off-chain artifact's `allowRules`.
 * - `prohibitions` = the derived Model-A `PRINCIPAL_EGRESS` (principal may only move to
 *   `CLIENT_ACCOUNT`) + each `transferRestrictions.prohibit` `ROUTE_THROUGH_ENTITY`.
 * - `floorGuards` = a guard per floor-guarded allow-rule, keyed to that rule.
 */
export function generateOnChainComplianceConfig(spec: RuleSpec): OnChainComplianceConfig {
  for (const label of spec.eligibility.requiredClaimTopics) {
    if (!IDENTIFIER_SAFE.test(label)) {
      throw new Error(
        `claim-topic label "${label}" is not EVM-identifier-safe (must match ${IDENTIFIER_SAFE.source}); ` +
          'the on-chain Solidity emitter uses the label as a constant name',
      );
    }
  }

  const requiredClaimTopics: OnChainClaimTopic[] = spec.eligibility.requiredClaimTopics.map(
    (label) => ({ label, derivation: CLAIM_TOPIC_DERIVATION }),
  );

  const allowFlows: FlowPermissionRule[] = spec.transferRestrictions.allow.map((rule) => ({
    id: rule.id,
    from: { accountType: rule.from.accountType, classification: rule.from.classification },
    to: rule.to,
    effect: 'ALLOW',
  }));

  const floorGuards: FloorGuard[] = spec.transferRestrictions.allow
    .filter((rule) => rule.floorGuard !== undefined)
    .map((rule) => ({
      id: `floor-${rule.id}`,
      allowRuleId: rule.id,
      accountType: rule.from.accountType,
      floorConfigKey: (rule.floorGuard as { floorConfigKey: string }).floorConfigKey,
    }));

  const prohibitions: Prohibition[] = [
    {
      id: 'prohibit-model-a-principal-egress',
      kind: 'PRINCIPAL_EGRESS',
      protectedAccountType: spec.modelABrightLine.protectedAccountType,
      protectedClassification: spec.modelABrightLine.protectedClassification,
      allowedDestination: 'CLIENT_ACCOUNT',
    },
    ...spec.transferRestrictions.prohibit.map(
      (rule): Prohibition => ({
        id: rule.id,
        kind: 'ROUTE_THROUGH_ENTITY',
        entity: rule.match.entity,
        assetKind: rule.match.assetKind,
      }),
    ),
  ];

  return {
    _generated: { source: 'rule-spec.v1', version: spec.version, generator: GENERATOR_ID },
    version: spec.version,
    defaultEffect: 'DENY',
    eligibility: {
      requireAllowlist: spec.eligibility.requireAllowlist,
      requiredClaimTopics,
    },
    coupling: {
      atomicPairedMintBurn: spec.pairCoupling.atomicPairedMintBurn,
      singleLegForbidden: spec.pairCoupling.singleLegForbidden,
    },
    modelA: {
      protectedAccountType: spec.modelABrightLine.protectedAccountType,
      protectedClassification: spec.modelABrightLine.protectedClassification,
      rule: 'PRINCIPAL_MUST_NOT_LEAVE_CLIENT',
      allowedDestination: 'CLIENT_ACCOUNT',
    },
    allowFlows: byId(allowFlows),
    prohibitions: byId(prohibitions),
    floorGuards: byId(floorGuards),
  };
}

/** Serialize a config to canonical JSON (2-space indent, trailing newline) for on-disk emit. */
export function serializeOnChainConfig(config: OnChainComplianceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
