// @rose/authorization — the substitutable AuthorizationProvider interface (Story 3.2, FR-5/FR-8).
//
// This is the single seam through which `postTransfer` (Story 3.3) consults authorization before
// writing any transfer posting. The interface is fail-closed by construction (`DEFAULT_EFFECT` is
// `DENY`) and substitutable: a caller depends ONLY on this interface, so a fake/alternate provider
// (in-memory, DB-backed in Story 3.4, or on-chain in Epic 4) swaps in with zero caller changes
// (NFR-8). The decision vocabulary and the transfer shapes are REUSED from `@rose/rule-spec` (the
// single source of truth) — they are never redeclared here.
import type { ConformanceEnv, Effect, TransferScenario } from '@rose/rule-spec';

/**
 * The inputs a provider needs to decide one capital movement. These are the SAME shapes the
 * Story-3.1 conformance harness drives (`TransferScenario` + `ConformanceEnv`), so any provider is
 * bridgeable to a `PlaneAdapter` with no field re-mapping and can be gated by the shared vectors.
 *  - `scenario`: from-account type + classification, logical destination, asset kind, VCC routing.
 *  - `env`: floor-config presence/breach, modeled abstractly so NO money arithmetic / float happens
 *    in this layer (NFR-2) — the concrete NUMERIC floor math is Story-3.4 runtime.
 */
export interface AuthorizationRequest {
  readonly scenario: TransferScenario;
  readonly env: ConformanceEnv;
}

/**
 * A provider's decision. `effect` is the `ALLOW | DENY | REFUSE` vocabulary from `@rose/rule-spec`;
 * `reason` is a human-readable explanation for the audit trail (NFR-3). `DENY` is the fail-closed
 * baseline returned whenever no rule explicitly permits the transfer.
 */
export interface AuthorizationDecision {
  readonly effect: Effect;
  readonly reason: string;
}

/**
 * The substitutable authorization seam. A caller holds an `AuthorizationProvider` and calls
 * `authorize`; it never knows which concrete implementation answers (in-memory, DB-backed, or
 * on-chain). `authorize` is total: a DENY or REFUSE is a RETURNED decision, never a thrown
 * exception — so a caller can branch on `effect` without a try/catch.
 */
export interface AuthorizationProvider {
  readonly name: string;
  authorize(request: AuthorizationRequest): AuthorizationDecision;
}

/**
 * The fail-closed baseline effect: anything not explicitly permitted is denied (NFR-4). Typed as
 * the `'DENY'` literal (via `satisfies`) so consumers keep type-level narrowing.
 */
export const DEFAULT_EFFECT = 'DENY' satisfies Effect;

/** The fallback audit reason used whenever a caller supplies no (or a blank) reason. */
const DEFAULT_DENY_REASON = 'fail-closed default: no rule explicitly permits this transfer';

/** The single definition of "deny by default" that every provider falls back to. */
export function denyByDefault(reason?: string): AuthorizationDecision {
  return {
    effect: DEFAULT_EFFECT,
    // A blank reason is not a useful audit entry — fall back to the default (empty string is not
    // nullish, so `??` alone would keep it).
    reason: reason !== undefined && reason.trim().length > 0 ? reason : DEFAULT_DENY_REASON,
  };
}
