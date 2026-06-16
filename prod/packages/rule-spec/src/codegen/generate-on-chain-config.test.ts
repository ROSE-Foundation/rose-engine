import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { ruleSpecSchema } from '../spec/rule-spec-schema.js';
import {
  CLAIM_TOPIC_DERIVATION,
  generateOnChainComplianceConfig,
  serializeOnChainConfig,
} from './generate-on-chain-config.js';
import { generateOffChainPolicy } from './generate-off-chain-policy.js';

const config = generateOnChainComplianceConfig(ruleSpecV1);

describe('generateOnChainComplianceConfig — derivation from the single-source spec', () => {
  it('is deterministic: two generations serialize byte-identically', () => {
    expect(serializeOnChainConfig(generateOnChainComplianceConfig(ruleSpecV1))).toBe(
      serializeOnChainConfig(generateOnChainComplianceConfig(ruleSpecV1)),
    );
  });

  it('stamps generated provenance + fail-closed default', () => {
    expect(config._generated.source).toBe('rule-spec.v1');
    expect(config._generated.generator).toBe('@rose/rule-spec/codegen/generate-on-chain-config');
    expect(config.version).toBe(ruleSpecV1.version);
    expect(config.defaultEffect).toBe('DENY');
  });

  it('mirrors eligibility from the spec (allowlist + required claim-topic LABELS, >=1)', () => {
    expect(config.eligibility.requireAllowlist).toBe(ruleSpecV1.eligibility.requireAllowlist);
    expect(config.eligibility.requiredClaimTopics.length).toBeGreaterThanOrEqual(1);
    expect(config.eligibility.requiredClaimTopics.map((t) => t.label)).toEqual(
      ruleSpecV1.eligibility.requiredClaimTopics,
    );
    for (const topic of config.eligibility.requiredClaimTopics) {
      expect(topic.derivation).toBe(CLAIM_TOPIC_DERIVATION);
    }
  });

  it('mirrors coupling + Model-A params from the spec', () => {
    expect(config.coupling).toEqual({
      atomicPairedMintBurn: ruleSpecV1.pairCoupling.atomicPairedMintBurn,
      singleLegForbidden: ruleSpecV1.pairCoupling.singleLegForbidden,
    });
    expect(config.modelA.protectedAccountType).toBe(
      ruleSpecV1.modelABrightLine.protectedAccountType,
    );
    expect(config.modelA.protectedClassification).toBe(
      ruleSpecV1.modelABrightLine.protectedClassification,
    );
    expect(config.modelA.rule).toBe('PRINCIPAL_MUST_NOT_LEAVE_CLIENT');
    expect(config.modelA.allowedDestination).toBe('CLIENT_ACCOUNT');
  });

  it('derives allowFlows (one per spec allow-rule) and a derived Model-A PRINCIPAL_EGRESS prohibition', () => {
    expect(config.allowFlows.map((f) => f.id).sort()).toEqual(
      ruleSpecV1.transferRestrictions.allow.map((r) => r.id).sort(),
    );
    for (const flow of config.allowFlows) {
      expect(flow.effect).toBe('ALLOW');
    }
    const principalEgress = config.prohibitions.find((p) => p.kind === 'PRINCIPAL_EGRESS');
    expect(principalEgress).toBeDefined();
    expect(principalEgress).toMatchObject({
      kind: 'PRINCIPAL_EGRESS',
      protectedAccountType: 'CLIENT_COLLATERAL',
      protectedClassification: 'PRINCIPAL',
      allowedDestination: 'CLIENT_ACCOUNT',
    });
    expect(config.prohibitions.some((p) => p.kind === 'ROUTE_THROUGH_ENTITY')).toBe(true);
  });

  it('derives a floor guard per floor-guarded allow-rule, keyed to that rule', () => {
    const guarded = ruleSpecV1.transferRestrictions.allow.filter((r) => r.floorGuard !== undefined);
    expect(config.floorGuards.length).toBe(guarded.length);
    for (const guard of config.floorGuards) {
      expect(config.allowFlows.some((f) => f.id === guard.allowRuleId)).toBe(true);
    }
  });

  it('emits ascending-sorted ids (stable, drift-detectable)', () => {
    const allowIds = config.allowFlows.map((f) => f.id);
    const prohibitionIds = config.prohibitions.map((p) => p.id);
    expect(allowIds).toEqual([...allowIds].sort());
    expect(prohibitionIds).toEqual([...prohibitionIds].sort());
  });

  it('shares the off-chain plane rule vocabulary (same allow ids + same prohibition ids)', () => {
    const offChain = generateOffChainPolicy(ruleSpecV1);
    expect(config.allowFlows.map((f) => f.id)).toEqual(offChain.allowRules.map((r) => r.id));
    expect(config.prohibitions.map((p) => p.id)).toEqual(offChain.prohibitions.map((p) => p.id));
    expect(config.floorGuards.map((g) => g.id)).toEqual(offChain.floorGuards.map((g) => g.id));
  });

  it('rejects a claim-topic label that is not EVM-identifier-safe', () => {
    const bad = ruleSpecSchema.parse({
      ...ruleSpecV1,
      eligibility: { requireAllowlist: true, requiredClaimTopics: ['not safe!'] },
    });
    expect(() => generateOnChainComplianceConfig(bad)).toThrow(/EVM-identifier-safe/);
  });
});
