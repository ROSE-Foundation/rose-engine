// Subscriber eligibility — the curated-allowlist / ONCHAINID-claim analogue (Story 6.2, FR-19).
//
// P0 has NO self-service KYC (architecture §Security line 144): eligibility is a CURATED allowlist,
// materialized on-chain as ERC-3643 ONCHAINID claims issued by a ROSE-operated claim issuer. In
// PAPER/LOCAL mode we model that allowlist with a deterministic, in-memory `EligibilityProvider`
// (NO network, NO secret). The REAL on-chain reject is the ERC-3643 token's mint-to-non-verified
// revert (Epic 4); wiring the live ONCHAINID read against Sepolia is ops-deferred (deferred-work.md
// story-6.2).
//
// Fail-closed by construction: an unknown subscriber is NOT eligible. The decision is TOTAL (returned,
// never thrown) — mirroring `@rose/authorization`'s `AuthorizationProvider`. The orchestration turns a
// non-eligible decision into a thrown `IneligibleSubscriberError` BEFORE any on-chain write (NFR-4).
import { getAddress } from 'viem';

/** An eligibility decision. Discriminated on `eligible`; a refusal carries a SPECIFIC reason (UX-DR5). */
export type EligibilityDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

/** The substitutable eligibility seam (the ONCHAINID-claim allowlist analogue). */
export interface EligibilityProvider {
  readonly name: string;
  /** Decide whether `subscriber` (an EVM address) may receive tokens. Total — never throws. */
  checkEligibility(subscriber: string): EligibilityDecision;
}

/**
 * Thrown by the subscription orchestration when eligibility is refused — BEFORE any on-chain write
 * (fail-closed, NFR-4). Maps to HTTP 403 at the API boundary (the FR-19 recipient rejection — the
 * subscriber cannot receive tokens), carrying the SPECIFIC reason so the surface can name it to the
 * user (UX-DR5; no self-service KYC, not a generic block).
 */
export class IneligibleSubscriberError extends Error {
  readonly subscriber: string;
  readonly reason: string;
  constructor(subscriber: string, reason: string) {
    super(`Subscriber not eligible: ${reason}`);
    this.name = 'IneligibleSubscriberError';
    this.subscriber = subscriber;
    this.reason = reason;
  }
}

/** Normalizes an address to its EIP-55 checksum; returns null for a structurally invalid address. */
function normalizeAddress(address: string): string | null {
  try {
    return getAddress(address);
  } catch {
    return null;
  }
}

/**
 * Builds a PAPER allowlist eligibility provider over a fixed set of allowlisted subscriber addresses
 * (the curated P0 audience). Addresses are compared by their EIP-55 checksum form, so casing never
 * causes a false miss. An absent/expired claim is modeled as "not on the allowlist" with an explicit,
 * named reason. Fail-closed: an unknown or malformed address is NOT eligible. NO network, NO secret.
 */
export function makeAllowlistEligibilityProvider(allowlist: Iterable<string>): EligibilityProvider {
  const allowed = new Set<string>();
  for (const a of allowlist) {
    const norm = normalizeAddress(a);
    if (norm !== null) {
      allowed.add(norm);
    }
  }
  return Object.freeze({
    name: 'paper-allowlist-eligibility',
    checkEligibility(subscriber: string): EligibilityDecision {
      const norm = normalizeAddress(subscriber);
      if (norm === null) {
        return {
          eligible: false,
          reason: `subscriber '${subscriber}' is not a valid address (no valid ONCHAINID claim).`,
        };
      }
      if (!allowed.has(norm)) {
        return {
          eligible: false,
          reason: `subscriber ${norm} is not allowlist-eligible (no valid ONCHAINID claim).`,
        };
      }
      return { eligible: true };
    },
  });
}
