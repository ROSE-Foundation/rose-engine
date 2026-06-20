// Story 9.2 — the mock KYC/AML onboarding registry (the DEMO ONCHAINID claim issuer). Asserts the
// onboard/revoke/isOnboarded round-trip, EIP-55 normalisation (casing never causes a false hit/miss),
// the monotonic version (bumps only on a real state change), the seeded-onboarded set, and fail-closed
// behaviour for malformed addresses.
import { describe, expect, it } from 'vitest';
import { InvalidKycAddressError, makeMockKycRegistry } from './kyc-registry.js';

const ALICE_LOWER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('makeMockKycRegistry', () => {
  it('onboards and revokes, reading isOnboarded back (fail-closed default: unknown ⇒ false)', () => {
    const reg = makeMockKycRegistry();
    expect(reg.isOnboarded(ALICE_LOWER)).toBe(false); // never-onboarded ⇒ not eligible

    const onboarded = reg.onboard(ALICE_LOWER);
    expect(onboarded.onboarded).toBe(true);
    expect(reg.isOnboarded(ALICE_LOWER)).toBe(true);

    const revoked = reg.revoke(ALICE_LOWER);
    expect(revoked.onboarded).toBe(false);
    expect(reg.isOnboarded(ALICE_LOWER)).toBe(false);
  });

  it('compares by EIP-55 checksum — reads back via the checksummed form, casing-insensitive', () => {
    const reg = makeMockKycRegistry();
    reg.onboard(ALICE_LOWER);
    const checksummed = reg.state(ALICE_LOWER).address;
    expect(checksummed).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The checksummed alias (different casing than the lowercase input) resolves to the SAME claim.
    expect(reg.isOnboarded(checksummed)).toBe(true);
  });

  it('bumps version only on a real state change (idempotent onboard/revoke do not bump)', () => {
    const reg = makeMockKycRegistry();
    expect(reg.state(ALICE_LOWER).version).toBe(0);
    expect(reg.onboard(ALICE_LOWER).version).toBe(1);
    expect(reg.onboard(ALICE_LOWER).version).toBe(1); // already onboarded ⇒ no bump
    expect(reg.revoke(ALICE_LOWER).version).toBe(2);
    expect(reg.revoke(ALICE_LOWER).version).toBe(2); // already revoked ⇒ no bump
  });

  it('seeds the initial-onboarded set (version starts at 0); list reflects it', () => {
    const reg = makeMockKycRegistry([ALICE_LOWER]);
    expect(reg.isOnboarded(ALICE_LOWER)).toBe(true);
    expect(reg.isOnboarded(BOB)).toBe(false);
    expect(reg.state(ALICE_LOWER).version).toBe(0);
    expect(reg.list()).toHaveLength(1);
  });

  it('is fail-closed for malformed addresses: isOnboarded ⇒ false, onboard/revoke/state ⇒ throw', () => {
    const reg = makeMockKycRegistry(['not-an-address']); // malformed seed is skipped
    expect(reg.list()).toHaveLength(0);
    expect(reg.isOnboarded('not-an-address')).toBe(false);
    expect(() => reg.onboard('0x123')).toThrow(InvalidKycAddressError);
    expect(() => reg.revoke('0x123')).toThrow(InvalidKycAddressError);
    expect(() => reg.state('0x123')).toThrow(InvalidKycAddressError);
  });
});
