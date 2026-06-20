// Faithful default-deny + KYC authorization (Story 9.2, FR-29 / FR-7 / NFR-4). Replaces the paper /
// Story-9.1 `faithfulAuthorizeAllow` with the REAL default-deny authorization plane fronted by the
// mocked KYC/AML onboarding registry: the baseline effect is DENY (`@rose/authorization`'s
// `DEFAULT_EFFECT`/`denyByDefault`), and the mocked ONCHAINID-style eligibility claim is what LIFTS
// the deny. Both seams the inner write services consult are derived from the SAME `MockKycRegistry`:
//   • the FR-19 token-receipt `EligibilityProvider` (mint receipt), and
//   • the FR-7 capital-flow `MintAuthorizationGate` (the pre-submit chokepoint).
//
// SUBJECT-AWARENESS. `MintAuthorizationGate` is a zero-arg thunk (`() => MintAuthorizationDecision`,
// `@rose/chain` mint-pair.ts) bound at service construction — it cannot see the per-call subject
// through the generic inner service. So the faithful wrappers run each inner write inside
// `runWithKycContext({subject, capitalIn}, …)` (a `node:async_hooks` AsyncLocalStorage — concurrency
// -safe across the inner awaits). The gate reads that context. The gate is consulted PRE-SUBMIT
// (inside `mint.start`, synchronously, fully inside the context window); the DEFERRED confirmation
// callback (Story 9.1) does NOT re-authorize (chain is authoritative once minted), so it needs no
// context. NO network, NO secret.
import { AsyncLocalStorage } from 'node:async_hooks';
import { denyByDefault } from '@rose/authorization';
import type { MintAuthorizationDecision, MintAuthorizationGate } from '@rose/chain';
import type { EligibilityDecision, EligibilityProvider } from '@rose/rose-note';
import type { MockKycRegistry } from './kyc-registry.js';

/**
 * The capital-movement context the faithful wrappers establish around each inner write so the zero-arg
 * authorization gate can decide on the right subject:
 *   - `subject`: the EVM address whose claim is consulted (the recipient on a mint, the holder on a burn).
 *   - `capitalIn`: true for a MINT (subscribe / position-open — receipt is KYC-gated); false for a BURN
 *     (redeem / position-close / strategy-reset — an EXIT is always authorized, governed by the §11.4
 *     solvency guardrail + lifecycle, not by onboarding).
 */
export interface KycAuthorizationContext {
  readonly subject?: string;
  readonly capitalIn: boolean;
}

const kycContextStore = new AsyncLocalStorage<KycAuthorizationContext>();

/** Run `fn` with the given KYC authorization context in scope (read by the gate via AsyncLocalStorage). */
export function runWithKycContext<T>(context: KycAuthorizationContext, fn: () => T): T {
  return kycContextStore.run(context, fn);
}

/** The rule name the default-deny refusal is attributed to (UX-DR5 — a named refusal, not a generic block). */
export const KYC_DEFAULT_DENY_RULE = 'KYC_AML_DEFAULT_DENY' as const;

/**
 * Compute the default-deny + KYC authorization decision for an explicit subject + operation, WITHOUT
 * the AsyncLocalStorage context (the directly-testable core). Built on the real default-deny plane:
 *   - capital-OUT (burn / exit) ⇒ ALLOW (an exit is never blocked by onboarding);
 *   - capital-IN, onboarded ⇒ ALLOW (the KYC claim lifts the deny);
 *   - capital-IN, NOT onboarded ⇒ DENY with the rule-named reason (the baseline `denyByDefault`).
 */
export function decideKycAuthorization(
  registry: MockKycRegistry,
  context: KycAuthorizationContext,
): MintAuthorizationDecision {
  if (!context.capitalIn) {
    return {
      effect: 'ALLOW',
      reason:
        'faithful KYC: capital-out (burn/exit) is authorized — an exit is not onboarding-gated.',
    };
  }
  const subject = context.subject;
  if (subject === undefined || subject.trim().length === 0) {
    // Fail-closed: a capital-in movement with no subject in context cannot be authorized.
    const denied = denyByDefault(
      `${KYC_DEFAULT_DENY_RULE}: no authorization subject in context (fail-closed).`,
    );
    return { effect: denied.effect, reason: denied.reason };
  }
  if (registry.isOnboarded(subject)) {
    return {
      effect: 'ALLOW',
      reason: `faithful KYC: subject ${subject} holds a valid ONCHAINID eligibility claim (onboarded).`,
    };
  }
  // Default-deny baseline (DEFAULT_EFFECT === 'DENY'): no KYC claim ⇒ the deny is not lifted.
  const denied = denyByDefault(
    `${KYC_DEFAULT_DENY_RULE}: subject ${subject} has no ONCHAINID eligibility claim ` +
      '(not onboarded) — capital movement default-denied.',
  );
  return { effect: denied.effect, reason: denied.reason };
}

/**
 * Builds the faithful `MintAuthorizationGate` (the FR-7 capital-flow chokepoint) over the KYC registry.
 * The returned thunk reads the AsyncLocalStorage context the faithful wrapper established and decides
 * via `decideKycAuthorization`. A non-ALLOW decision makes the inner dual-write throw
 * `MintAuthorizationError(effect, reason)` BEFORE any on-chain mint — which the API boundary maps to a
 * named 403 (`effect==='DENY'` ⇒ `AUTHORIZATION_DENIED`). Default-deny on no context (NFR-4).
 */
export function makeKycAuthorizationGate(registry: MockKycRegistry): MintAuthorizationGate {
  return () => {
    const context = kycContextStore.getStore();
    if (context === undefined) {
      // No faithful wrapper established a context — fall to the real default-deny baseline (never ALLOW).
      const denied = denyByDefault(
        `${KYC_DEFAULT_DENY_RULE}: no authorization context (fail-closed).`,
      );
      return { effect: denied.effect, reason: denied.reason };
    }
    return decideKycAuthorization(registry, context);
  };
}

/**
 * Builds the FR-19 token-receipt `EligibilityProvider` over the SAME KYC registry: an onboarded subject
 * is eligible to RECEIVE tokens; an un-onboarded / malformed subject is NOT (a named refusal the
 * subscribe/open orchestration turns into `IneligibleSubscriberError` ⇒ 403, BEFORE any write). This is
 * the substitutable replacement (NFR-8) for the static `makeAllowlistEligibilityProvider` in faithful mode.
 */
export function makeKycEligibilityProvider(registry: MockKycRegistry): EligibilityProvider {
  return Object.freeze({
    name: 'faithful-kyc-eligibility',
    checkEligibility(subscriber: string): EligibilityDecision {
      if (registry.isOnboarded(subscriber)) {
        return { eligible: true };
      }
      return {
        eligible: false,
        reason:
          `subscriber ${subscriber} has not completed KYC/AML onboarding ` +
          '(no valid ONCHAINID eligibility claim).',
      };
    },
  });
}
