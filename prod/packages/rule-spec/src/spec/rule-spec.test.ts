import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from './rule-spec.v1.js';
import { RULE_SPEC_VERSION, RuleSpecValidationError, loadRuleSpec } from './load-rule-spec.js';
import { generateOffChainPolicy } from '../codegen/generate-off-chain-policy.js';

describe('rule-spec v1', () => {
  it('validates the shipped v1 spec and exposes all four mandated sections', () => {
    const spec = loadRuleSpec(ruleSpecV1);
    expect(spec.version).toBe(RULE_SPEC_VERSION);
    expect(spec.defaultEffect).toBe('DENY');
    // The four mandated sections (AC-1).
    expect(spec.eligibility.requireAllowlist).toBe(true);
    expect(spec.eligibility.requiredClaimTopics.length).toBeGreaterThan(0);
    expect(spec.transferRestrictions.allow.length).toBeGreaterThan(0);
    expect(spec.modelABrightLine.rule).toBe('PRINCIPAL_MUST_NOT_LEAVE_CLIENT');
    expect(spec.pairCoupling.atomicPairedMintBurn).toBe(true);
    expect(spec.pairCoupling.singleLegForbidden).toBe(true);
  });

  it('encodes the Model-A bright line on CLIENT_COLLATERAL principal', () => {
    expect(ruleSpecV1.modelABrightLine.protectedAccountType).toBe('CLIENT_COLLATERAL');
    expect(ruleSpecV1.modelABrightLine.protectedClassification).toBe('PRINCIPAL');
  });

  it('encodes the token-flow-through-VCC prohibition', () => {
    const vccProhibition = ruleSpecV1.transferRestrictions.prohibit.find(
      (p) => p.match.entity === 'VCC' && p.match.assetKind === 'TOKEN',
    );
    expect(vccProhibition).toBeDefined();
  });
});

describe('loadRuleSpec — refuse-if-invalid', () => {
  it('refuses input missing a mandated section', () => {
    const broken: Record<string, unknown> = { ...ruleSpecV1 };
    delete broken.modelABrightLine;
    expect(() => loadRuleSpec(broken)).toThrow(RuleSpecValidationError);
  });

  it('refuses a non-semver version', () => {
    expect(() => loadRuleSpec({ ...ruleSpecV1, version: 'v1' })).toThrow(RuleSpecValidationError);
  });

  it('refuses an unknown enum value', () => {
    const broken = {
      ...ruleSpecV1,
      modelABrightLine: { ...ruleSpecV1.modelABrightLine, protectedAccountType: 'NOT_AN_ACCOUNT' },
    };
    expect(() => loadRuleSpec(broken)).toThrow(RuleSpecValidationError);
  });

  it('refuses a defaultEffect other than DENY (fail-closed contract)', () => {
    expect(() => loadRuleSpec({ ...ruleSpecV1, defaultEffect: 'ALLOW' })).toThrow(
      RuleSpecValidationError,
    );
  });

  it('attaches structured Zod issues to the error', () => {
    try {
      loadRuleSpec({ ...ruleSpecV1, version: 'nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleSpecValidationError);
      expect((err as RuleSpecValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it('refuses a spec with duplicate rule ids (single-source integrity)', () => {
    const firstAllow = ruleSpecV1.transferRestrictions.allow[0];
    if (firstAllow === undefined) throw new Error('fixture must have an allow-rule');
    const broken = {
      ...ruleSpecV1,
      transferRestrictions: {
        ...ruleSpecV1.transferRestrictions,
        allow: [...ruleSpecV1.transferRestrictions.allow, { ...firstAllow }],
      },
    };
    expect(() => loadRuleSpec(broken)).toThrow(RuleSpecValidationError);
  });

  it('refuses an authored rule id that collides with a codegen-reserved id', () => {
    const firstAllow = ruleSpecV1.transferRestrictions.allow[0];
    if (firstAllow === undefined) throw new Error('fixture must have an allow-rule');
    const broken = {
      ...ruleSpecV1,
      transferRestrictions: {
        ...ruleSpecV1.transferRestrictions,
        allow: [
          { ...firstAllow, id: 'floor-something' },
          ...ruleSpecV1.transferRestrictions.allow.slice(1),
        ],
      },
    };
    expect(() => loadRuleSpec(broken)).toThrow(RuleSpecValidationError);
  });
});

describe('Model-A bright line — codegen / allow-rule coherence', () => {
  it('the derived principal-egress prohibition agrees with an allow-rule (single-source coupling)', () => {
    const policy = generateOffChainPolicy(ruleSpecV1);
    const modelA = policy.prohibitions.find((p) => p.kind === 'PRINCIPAL_EGRESS');
    expect(modelA?.kind).toBe('PRINCIPAL_EGRESS');
    if (modelA?.kind === 'PRINCIPAL_EGRESS') {
      // The one destination the prohibition still permits for principal MUST be backed by an
      // allow-rule — otherwise the bright line and the allow surface would silently disagree.
      const backing = policy.allowRules.find(
        (r) =>
          r.from.accountType === modelA.protectedAccountType &&
          r.from.classification === modelA.protectedClassification &&
          r.to === modelA.allowedDestination,
      );
      expect(backing).toBeDefined();
    }
  });
});
