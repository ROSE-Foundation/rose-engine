// Mock KYC/AML onboarding registry (Story 9.2, FR-29). A DEMO claim issuer — the ONCHAINID-style
// eligibility-claim analogue used in `ENGINE_MODE=faithful`. It is the substitutable seam (NFR-8)
// behind BOTH the FR-19 token-receipt eligibility AND the FR-7 default-deny authorization gate:
// `onboard(address)` issues an eligibility claim, `revoke(address)` removes it, `isOnboarded(address)`
// reads it. The REAL on-chain claim issuer (a ROSE-operated ONCHAINID issuer against the ERC-3643
// token) is out of scope and ops-deferred; THIS is an in-memory, network-free, secret-free stand-in.
//
// Fail-closed by construction (NFR-4): an unknown / never-onboarded / malformed address is NOT
// onboarded. Addresses are compared by their EIP-55 checksum so casing never causes a false hit/miss.
// `version` is monotonic — it bumps on every state-CHANGING onboard/revoke (a no-op call does not
// bump it), so a UI can detect a real change. Holds NO money state and writes NO postings.
import { getAddress } from 'viem';

/** The onboarding state of one address: the EIP-55 address, whether a claim is held, and the version. */
export interface KycOnboardingState {
  /** The EIP-55 checksum address the state is reported for. */
  readonly address: string;
  /** Whether the mocked KYC/AML onboarding has issued (and not revoked) an eligibility claim. */
  readonly onboarded: boolean;
  /** The registry's monotonic version at the time of this read (bumps on every state change). */
  readonly version: number;
}

/** The substitutable mock KYC registry seam (the ONCHAINID claim-issuer analogue). */
export interface MockKycRegistry {
  /** A human label for logs/audit — clearly names this a DEMO claim issuer. */
  readonly name: string;
  /** Issue an eligibility claim for `address` (idempotent). Returns the new state. */
  onboard(address: string): KycOnboardingState;
  /** Remove `address`'s eligibility claim (idempotent). Returns the new state. */
  revoke(address: string): KycOnboardingState;
  /** Whether `address` currently holds a claim. TOTAL — never throws (a malformed address ⇒ false). */
  isOnboarded(address: string): boolean;
  /** Read the current onboarding state for `address`. Throws `InvalidKycAddressError` if malformed. */
  state(address: string): KycOnboardingState;
  /** The EIP-55 addresses currently onboarded (for an operator/demo overview). */
  list(): readonly string[];
}

/**
 * Thrown when an address handed to the registry is not a structurally valid EVM address — fail-closed
 * (NFR-4). Maps to a 400 at the API boundary (the route also Zod-validates the address up front, so
 * this is the defensive inner guard). Carries the offending input for the audit trail.
 */
export class InvalidKycAddressError extends Error {
  readonly address: string;
  constructor(address: string) {
    super(`'${address}' is not a valid EVM address (cannot onboard/revoke a malformed address).`);
    this.name = 'InvalidKycAddressError';
    this.address = address;
  }
}

/** Normalize to EIP-55 checksum, or `null` for a structurally invalid address (the total-read seam). */
function normalize(address: string): string | null {
  try {
    return getAddress(address);
  } catch {
    return null;
  }
}

/** Normalize to EIP-55 checksum, throwing `InvalidKycAddressError` for a malformed address. */
function requireAddress(address: string): string {
  const norm = normalize(address);
  if (norm === null) {
    throw new InvalidKycAddressError(address);
  }
  return norm;
}

/**
 * Builds an in-memory mock KYC registry. `initialOnboarded` seeds the set of already-onboarded
 * addresses (e.g. the demo identities, so the seeded faithful demo works out of the box) — malformed
 * seed entries are skipped (fail-closed). The seed does NOT advance `version` (it starts at 0).
 */
export function makeMockKycRegistry(initialOnboarded: Iterable<string> = []): MockKycRegistry {
  const onboarded = new Set<string>();
  for (const a of initialOnboarded) {
    const norm = normalize(a);
    if (norm !== null) {
      onboarded.add(norm);
    }
  }
  let version = 0;

  const stateOf = (addr: string): KycOnboardingState => ({
    address: addr,
    onboarded: onboarded.has(addr),
    version,
  });

  return Object.freeze({
    name: 'mock-kyc-onboarding (DEMO claim issuer — faithful mode)',
    onboard(address: string): KycOnboardingState {
      const addr = requireAddress(address);
      if (!onboarded.has(addr)) {
        onboarded.add(addr);
        version += 1;
      }
      return stateOf(addr);
    },
    revoke(address: string): KycOnboardingState {
      const addr = requireAddress(address);
      if (onboarded.has(addr)) {
        onboarded.delete(addr);
        version += 1;
      }
      return stateOf(addr);
    },
    isOnboarded(address: string): boolean {
      const norm = normalize(address);
      return norm !== null && onboarded.has(norm);
    },
    state(address: string): KycOnboardingState {
      return stateOf(requireAddress(address));
    },
    list(): readonly string[] {
      return [...onboarded];
    },
  });
}
