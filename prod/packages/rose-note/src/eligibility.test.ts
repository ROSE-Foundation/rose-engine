// Story 6.2 — the eligibility seam (the curated-allowlist / ONCHAINID-claim analogue). Pure unit
// (no DB, no network): fail-closed by construction, a specific named reason on refusal (UX-DR5).
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { makeAllowlistEligibilityProvider } from './eligibility.js';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('makeAllowlistEligibilityProvider', () => {
  it('admits an allowlisted subscriber (valid ONCHAINID claim analogue)', () => {
    const provider = makeAllowlistEligibilityProvider([ALICE]);
    expect(provider.checkEligibility(ALICE)).toEqual({ eligible: true });
  });

  it('matches regardless of address casing (compares EIP-55 checksum form)', () => {
    const provider = makeAllowlistEligibilityProvider([getAddress(ALICE)]);
    expect(provider.checkEligibility(ALICE.toLowerCase()).eligible).toBe(true);
    expect(provider.checkEligibility(getAddress(ALICE)).eligible).toBe(true);
  });

  it('refuses a non-allowlisted subscriber with a specific, named reason (fail-closed)', () => {
    const provider = makeAllowlistEligibilityProvider([ALICE]);
    const decision = provider.checkEligibility(BOB);
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      expect(decision.reason).toContain('not allowlist-eligible');
      expect(decision.reason).toContain('ONCHAINID');
    }
  });

  it('refuses a structurally invalid address with an explicit reason (not a generic block)', () => {
    const provider = makeAllowlistEligibilityProvider([ALICE]);
    const decision = provider.checkEligibility('not-an-address');
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      expect(decision.reason).toContain('not a valid address');
    }
  });

  it('is fail-closed for an empty allowlist (nobody is eligible)', () => {
    const provider = makeAllowlistEligibilityProvider([]);
    expect(provider.checkEligibility(ALICE).eligible).toBe(false);
  });
});
