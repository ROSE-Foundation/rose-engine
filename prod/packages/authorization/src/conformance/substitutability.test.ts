import { generateOffChainPolicy, ruleSpecV1 } from '@rose/rule-spec';
import { describe, expect, it } from 'vitest';
import type {
  AuthorizationDecision,
  AuthorizationProvider,
  AuthorizationRequest,
} from '../provider/authorization-provider.js';
import { makeDefaultDenyProvider } from '../provider/default-deny-provider.js';
import { makePolicyAuthorizationProvider } from '../provider/policy-authorization-provider.js';

// AC-2 (caller unchanged): ONE generic call site drives several provider implementations with zero
// changes. This is the SPEC §5 acceptance — substituting a fake `AuthorizationProvider` requires no
// calling-code change (the interface isolates the caller from the implementation).
describe('AuthorizationProvider substitutability (AC-2, caller unchanged)', () => {
  // The single, implementation-agnostic caller. It depends ONLY on the interface.
  const decide = (provider: AuthorizationProvider, request: AuthorizationRequest) =>
    provider.authorize(request);

  // An inline test-fake: a constant-ALLOW stub. Used only to prove the call site is unchanged —
  // it is not claimed to be conformant.
  const allowAllFake: AuthorizationProvider = {
    name: 'allow-all-fake',
    authorize(): AuthorizationDecision {
      return { effect: 'ALLOW', reason: 'test fake: allow everything' };
    },
  };

  const request: AuthorizationRequest = {
    scenario: { from: 'FEE_INCOME', classification: 'NONE', to: 'TREASURY', assetKind: 'VALUE' },
    env: {},
  };

  const providers: readonly AuthorizationProvider[] = [
    makeDefaultDenyProvider(),
    makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1)),
    allowAllFake,
  ];

  it('the same caller drives every provider implementation unchanged', () => {
    for (const provider of providers) {
      const decision = decide(provider, request);
      // Each returns a well-formed decision — the call shape never changes across implementations.
      expect(decision).toHaveProperty('effect');
      expect(decision).toHaveProperty('reason');
      expect(['ALLOW', 'DENY', 'REFUSE']).toContain(decision.effect);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it('swapping implementations changes only the decision, not the call', () => {
    // Same request, same call site — different implementations yield their own decisions.
    expect(decide(makeDefaultDenyProvider(), request).effect).toBe('DENY');
    expect(
      decide(makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1)), request).effect,
    ).toBe('ALLOW');
    expect(decide(allowAllFake, request).effect).toBe('ALLOW');
  });
});
