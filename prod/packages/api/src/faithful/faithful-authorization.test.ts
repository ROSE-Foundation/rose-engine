// Story 9.2 — the REAL default-deny + KYC authorization gate and the KYC-derived eligibility provider
// (both over the mock registry). Proves the gate is genuinely subject-aware (not an ALLOW stub):
//   • capital-IN, un-onboarded ⇒ DENY with the rule-named reason (→ 403 at the boundary);
//   • capital-IN, onboarded ⇒ ALLOW;
//   • capital-IN, onboarded-then-REVOKED ⇒ DENY again (revocation honoured);
//   • capital-OUT (exit) ⇒ ALLOW regardless of onboarding;
//   • no context ⇒ fail-closed DENY (NFR-4).
// And the eligibility provider tracks the same registry.
import { describe, expect, it } from 'vitest';
import {
  KYC_DEFAULT_DENY_RULE,
  decideKycAuthorization,
  makeKycAuthorizationGate,
  makeKycEligibilityProvider,
  runWithKycContext,
} from './faithful-authorization.js';
import { makeMockKycRegistry } from './kyc-registry.js';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('decideKycAuthorization (default-deny + KYC, the testable core)', () => {
  it('capital-IN un-onboarded ⇒ DENY with the rule-named reason', () => {
    const reg = makeMockKycRegistry();
    const d = decideKycAuthorization(reg, { subject: ALICE, capitalIn: true });
    expect(d.effect).toBe('DENY');
    expect(d.reason).toContain(KYC_DEFAULT_DENY_RULE);
    expect(d.reason).toContain('not onboarded');
  });

  it('capital-IN onboarded ⇒ ALLOW; then REVOKED ⇒ DENY again (revocation honoured)', () => {
    const reg = makeMockKycRegistry();
    reg.onboard(ALICE);
    expect(decideKycAuthorization(reg, { subject: ALICE, capitalIn: true }).effect).toBe('ALLOW');
    reg.revoke(ALICE);
    expect(decideKycAuthorization(reg, { subject: ALICE, capitalIn: true }).effect).toBe('DENY');
  });

  it('capital-OUT (exit) ⇒ ALLOW regardless of onboarding', () => {
    const reg = makeMockKycRegistry();
    expect(decideKycAuthorization(reg, { subject: ALICE, capitalIn: false }).effect).toBe('ALLOW');
  });

  it('capital-IN with no subject ⇒ fail-closed DENY', () => {
    const reg = makeMockKycRegistry();
    expect(decideKycAuthorization(reg, { capitalIn: true }).effect).toBe('DENY');
  });
});

describe('makeKycAuthorizationGate (the zero-arg gate over AsyncLocalStorage context)', () => {
  it('reads the context the wrapper establishes — onboarded ALLOW, un-onboarded DENY', () => {
    const reg = makeMockKycRegistry([ALICE]);
    const gate = makeKycAuthorizationGate(reg);
    expect(runWithKycContext({ subject: ALICE, capitalIn: true }, () => gate()).effect).toBe(
      'ALLOW',
    );
    reg.revoke(ALICE);
    expect(runWithKycContext({ subject: ALICE, capitalIn: true }, () => gate()).effect).toBe(
      'DENY',
    );
  });

  it('with NO context in scope ⇒ fail-closed DENY (never silently ALLOW)', () => {
    const gate = makeKycAuthorizationGate(makeMockKycRegistry());
    expect(gate().effect).toBe('DENY');
  });
});

describe('makeKycEligibilityProvider (FR-19 token receipt over the SAME registry)', () => {
  it('onboarded ⇒ eligible; un-onboarded ⇒ a named refusal', () => {
    const reg = makeMockKycRegistry();
    const eligibility = makeKycEligibilityProvider(reg);
    const before = eligibility.checkEligibility(ALICE);
    expect(before.eligible).toBe(false);
    if (!before.eligible) expect(before.reason).toContain('onboarding');

    reg.onboard(ALICE);
    expect(eligibility.checkEligibility(ALICE).eligible).toBe(true);
  });
});
