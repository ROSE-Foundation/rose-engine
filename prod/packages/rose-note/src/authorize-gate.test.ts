// Story 6.2 — the capital-flow authorization gate composition. The default-deny provider
// (`@rose/authorization`) yields a fail-closed DENY decision through the gate the paired-mint
// dual-write consults pre-submit. Proves the `rose-note → authorization` edge is real.
import { describe, expect, it } from 'vitest';
import { makeDefaultDenyProvider, type AuthorizationRequest } from '@rose/authorization';
import { makeProviderAuthorizeGate } from './authorize-gate.js';

const REQUEST: AuthorizationRequest = {
  scenario: {
    from: 'BACKING_FLOAT',
    classification: 'NONE',
    to: 'CLIENT_ACCOUNT',
    assetKind: 'VALUE',
  },
  env: {},
};

describe('makeProviderAuthorizeGate', () => {
  it('binds a provider + request into a gate thunk; default-deny ⇒ DENY (fail-closed)', () => {
    const gate = makeProviderAuthorizeGate(makeDefaultDenyProvider(), REQUEST);
    const decision = gate();
    expect(decision.effect).toBe('DENY');
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
