import { describe, expect, it } from 'vitest';
import { ruleSpecV1, BACKING_FLOAT_FLOOR_CONFIG_KEY } from '../spec/rule-spec.v1.js';
import { generateOffChainPolicy } from './generate-off-chain-policy.js';

describe('generateOffChainPolicy', () => {
  it('is deterministic — two runs deep-equal with stable id ordering', () => {
    const a = generateOffChainPolicy(ruleSpecV1);
    const b = generateOffChainPolicy(ruleSpecV1);
    expect(a).toEqual(b);
    const ids = a.allowRules.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('emits a fail-closed default and a provenance stamp', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    expect(policy.defaultEffect).toBe('DENY');
    expect(policy.version).toBe(ruleSpecV1.version);
    expect(policy._generated.generator).toContain('@rose/rule-spec');
  });

  it('derives one allow-rule per spec allow entry, all effect ALLOW', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    expect(policy.allowRules.length).toBe(ruleSpecV1.transferRestrictions.allow.length);
    expect(policy.allowRules.every((r) => r.effect === 'ALLOW')).toBe(true);
    const feeRule = policy.allowRules.find((r) => r.from.accountType === 'FEE_INCOME');
    expect(feeRule?.to).toBe('TREASURY');
  });

  it('derives the Model-A principal-egress prohibition from the bright line section', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    const modelA = policy.prohibitions.find((p) => p.kind === 'PRINCIPAL_EGRESS');
    expect(modelA).toBeDefined();
    if (modelA?.kind === 'PRINCIPAL_EGRESS') {
      expect(modelA.protectedAccountType).toBe('CLIENT_COLLATERAL');
      expect(modelA.protectedClassification).toBe('PRINCIPAL');
      expect(modelA.allowedDestination).toBe('CLIENT_ACCOUNT');
    }
  });

  it('derives the VCC token-routing prohibition', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    const vcc = policy.prohibitions.find((p) => p.kind === 'ROUTE_THROUGH_ENTITY');
    expect(vcc).toBeDefined();
    if (vcc?.kind === 'ROUTE_THROUGH_ENTITY') {
      expect(vcc.entity).toBe('VCC');
      expect(vcc.assetKind).toBe('TOKEN');
    }
  });

  it('derives a BACKING_FLOAT floor guard carrying the config key (not a baked value)', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    expect(policy.floorGuards.length).toBe(1);
    const guard = policy.floorGuards[0];
    expect(guard?.accountType).toBe('BACKING_FLOAT');
    expect(guard?.floorConfigKey).toBe(BACKING_FLOAT_FLOOR_CONFIG_KEY);
  });

  it('scopes each floor guard to a real allow-rule (not just an account type)', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    const allowIds = new Set(policy.allowRules.map((r) => r.id));
    for (const guard of policy.floorGuards) {
      expect(allowIds.has(guard.allowRuleId)).toBe(true);
    }
  });
});
