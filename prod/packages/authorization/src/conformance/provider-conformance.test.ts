import {
  ConformanceFailureError,
  conformanceVectors,
  generateOffChainPolicy,
  ruleSpecV1,
} from '@rose/rule-spec';
import { describe, expect, it } from 'vitest';
import { makeDefaultDenyProvider } from '../provider/default-deny-provider.js';
import { makePolicyAuthorizationProvider } from '../provider/policy-authorization-provider.js';
import { assertProviderConforms, providerToPlaneAdapter } from './provider-conformance.js';

// AC-2 (substitutability via the SHARED harness): any CONFORMANT provider passes the same vectors,
// and the gate is proven non-vacuous (the all-deny baseline FAILS it).
describe('provider conformance gate (AC-2, reuses Story-3.1 harness)', () => {
  it('the gate is non-empty AND discriminating: an OFF_CHAIN vector expects a non-DENY effect', () => {
    const offChain = conformanceVectors.filter((v) => v.planes.includes('OFF_CHAIN'));
    expect(offChain.length).toBeGreaterThanOrEqual(1);
    // Without at least one non-DENY expectation, an all-deny provider would PASS the gate and the
    // "discriminates, not vacuous" test below would itself be vacuous.
    expect(offChain.some((v) => v.expected !== 'DENY')).toBe(true);
  });

  it('refuses to certify vacuously when no vector matches the plane', () => {
    const provider = makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1));
    // No OFF_CHAIN vectors in the set ⇒ the gate must throw rather than pass on zero coverage.
    expect(() => assertProviderConforms(provider, [])).toThrow(/pass vacuously/);
  });

  it('a policy-backed provider passes ALL shared OFF_CHAIN vectors', () => {
    const provider = makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1));
    expect(() => assertProviderConforms(provider)).not.toThrow();
  });

  it('the all-deny baseline FAILS the gate (proving it discriminates, not vacuous)', () => {
    const provider = makeDefaultDenyProvider();
    expect(() => assertProviderConforms(provider)).toThrow(ConformanceFailureError);
  });

  it('providerToPlaneAdapter threads BOTH scenario and env through to the provider', () => {
    const provider = makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1));
    const adapter = providerToPlaneAdapter(provider);
    expect(adapter.plane).toBe('OFF_CHAIN');
    expect(adapter.name).toBe(provider.name);
    // A floor-guarded egress: the decision depends ENTIRELY on `env`. If the bridge dropped or
    // ignored `env`, both calls would return the same effect — here they must differ, proving the
    // env is threaded (not just that two identical expressions are equal by construction).
    const floorGuarded = {
      from: 'BACKING_FLOAT',
      classification: 'NONE',
      to: 'EXTERNAL',
      assetKind: 'VALUE',
    } as const;
    // Floor config absent ⇒ REFUSE.
    expect(adapter.evaluate(floorGuarded, {})).toBe('REFUSE');
    // Floor present and not breached ⇒ ALLOW.
    expect(
      adapter.evaluate(floorGuarded, { backingFloatFloor: 1000n, postBalanceBelowFloor: false }),
    ).toBe('ALLOW');
  });
});
