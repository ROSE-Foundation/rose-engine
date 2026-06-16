import { generateOffChainPolicy, ruleSpecV1 } from '@rose/rule-spec';
import { describe, expect, it } from 'vitest';
import { makePolicyAuthorizationProvider } from './policy-authorization-provider.js';

// The policy-backed provider reproduces the rule-spec reference decisions exactly (ALLOW/DENY/REFUSE)
// without re-authoring any rule logic. It delegates to `makeReferenceOffChainAdapter` over the
// generated artifact, so the three terminal effects are all reachable.
describe('policy-backed authorization provider', () => {
  const provider = makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1));

  it('ALLOWs an explicitly permitted flow (fee income → treasury)', () => {
    const decision = provider.authorize({
      scenario: { from: 'FEE_INCOME', classification: 'NONE', to: 'TREASURY', assetKind: 'VALUE' },
      env: {},
    });
    expect(decision.effect).toBe('ALLOW');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('DENYs Model-A principal egress (client principal → treasury)', () => {
    const decision = provider.authorize({
      scenario: {
        from: 'CLIENT_COLLATERAL',
        classification: 'PRINCIPAL',
        to: 'TREASURY',
        assetKind: 'VALUE',
      },
      env: {},
    });
    expect(decision.effect).toBe('DENY');
  });

  it('REFUSEs a floor-guarded egress when the floor config is absent (NFR-4)', () => {
    const decision = provider.authorize({
      scenario: {
        from: 'BACKING_FLOAT',
        classification: 'NONE',
        to: 'EXTERNAL',
        assetKind: 'VALUE',
      },
      env: {},
    });
    expect(decision.effect).toBe('REFUSE');
  });

  it('DENYs an uncovered flow by fail-closed default', () => {
    const decision = provider.authorize({
      scenario: {
        from: 'DEPLOYED_CAPITAL',
        classification: 'NONE',
        to: 'EXTERNAL',
        assetKind: 'VALUE',
      },
      env: {},
    });
    expect(decision.effect).toBe('DENY');
  });

  it('exposes a configurable provider name', () => {
    expect(provider.name).toBe('policy');
    expect(
      makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1), 'off-chain-ref').name,
    ).toBe('off-chain-ref');
  });
});
