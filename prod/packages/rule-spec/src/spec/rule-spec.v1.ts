// @rose/rule-spec — the concrete v1 rule specification (Story 3.1).
//
// This object is THE single source of truth for ROSE authorization rules. Codegen
// (`generateOffChainPolicy`) derives the off-chain policy artifact from it, and Epic 4 will
// derive the on-chain compliance config from the SAME object. Edit rules HERE only — never in
// a generated artifact (a drift test enforces this).
import type { RuleSpec } from './rule-spec-schema.js';

/** Config key for the BACKING_FLOAT floor — resolved at runtime by Story 3.4 (refuse-if-absent). */
export const BACKING_FLOAT_FLOOR_CONFIG_KEY = 'backing_float.floor' as const;

/**
 * The P0 rule spec (v1). Sections:
 *  - eligibility: subscribers must be allowlisted and carry the ONCHAINID KYC claim (Epic 4
 *    maps `requiredClaimTopics` onto on-chain ERC-3643 claim topics).
 *  - transferRestrictions.allow: the permitted off-chain flows (FR-8) — fee income → treasury,
 *    client yield → treasury (principal excluded), client principal may move within the client
 *    account, and a floor-guarded BACKING_FLOAT egress.
 *  - transferRestrictions.prohibit: token/trading flows must not route through VCC accounts.
 *  - modelABrightLine: ring-fenced CLIENT_COLLATERAL principal must never leave the client (UJ-3).
 *  - pairCoupling: atomic paired mint/burn; a single leg is forbidden.
 */
export const ruleSpecV1: RuleSpec = {
  version: '1.0.0',
  defaultEffect: 'DENY',
  eligibility: {
    requireAllowlist: true,
    requiredClaimTopics: ['ONCHAINID_KYC'],
  },
  transferRestrictions: {
    allow: [
      {
        id: 'allow-fee-income-to-treasury',
        from: { accountType: 'FEE_INCOME', classification: 'NONE' },
        to: 'TREASURY',
      },
      {
        id: 'allow-client-yield-to-treasury',
        from: { accountType: 'CLIENT_COLLATERAL', classification: 'YIELD' },
        to: 'TREASURY',
      },
      {
        id: 'allow-client-principal-within-client',
        from: { accountType: 'CLIENT_COLLATERAL', classification: 'PRINCIPAL' },
        to: 'CLIENT_ACCOUNT',
      },
      {
        id: 'allow-backing-float-egress',
        from: { accountType: 'BACKING_FLOAT', classification: 'NONE' },
        to: 'EXTERNAL',
        floorGuard: { floorConfigKey: BACKING_FLOAT_FLOOR_CONFIG_KEY },
      },
    ],
    prohibit: [
      {
        id: 'prohibit-token-flow-through-vcc',
        description: 'Token/trading flows must not route through VCC accounts.',
        match: { kind: 'ROUTE_THROUGH_ENTITY', entity: 'VCC', assetKind: 'TOKEN' },
      },
    ],
  },
  modelABrightLine: {
    protectedAccountType: 'CLIENT_COLLATERAL',
    protectedClassification: 'PRINCIPAL',
    rule: 'PRINCIPAL_MUST_NOT_LEAVE_CLIENT',
  },
  pairCoupling: {
    atomicPairedMintBurn: true,
    singleLegForbidden: true,
  },
};
