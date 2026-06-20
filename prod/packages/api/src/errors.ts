// The typed structured-error contract for the REST boundary (Story 6.1, AC-2; UX-DR5/NFR-4).
//
// `mapErrorToResponse` is the SINGLE translator from a thrown domain/authorization error to an HTTP
// status + the structured envelope `{ error: { code, message, details? } }`. The headline is the
// authorization `TransferRefusedError` split (`DENY` ⇒ 403, `REFUSE` ⇒ 422) carrying the audit
// reason so a surface can NAME the refusing rule to the user (refusals are never collapsed into a
// generic error). This is the boundary the live write paths (Stories 6.2→6.6) surface refusals
// through.
//
// DESIGN — name-keyed, not instanceof: the registry keys on `error.name` (every domain error class
// in the codebase sets `this.name`) rather than importing each domain package's error class. This
// keeps `@rose/api`'s dependency graph minimal (it depends only on what it READS — ledger, reconcile,
// shared) while still translating refusals from `@rose/authorization`/`@rose/chain`/`@rose/config`
// that it does not import. The one exception is the `TransferRefusedError` 403/422 split, which reads
// the structural `effect` field off the matched error.

/** The structured error envelope returned over the wire: `{ error: { code, message, details? } }`. */
export interface StructuredErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/** A mapped HTTP response: the status code + the structured body. */
export interface MappedErrorResponse {
  readonly status: number;
  readonly body: StructuredErrorBody;
}

/** Base class for errors raised by the API layer itself. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A requested resource was absent (a well-formed id that matched no row ⇒ 404). */
export class NotFoundError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(404, 'NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}

// The name-keyed status registry. `code` defaults to the error `name` (the specific machine code the
// surface reads) unless overridden. Grouped by the AC's status taxonomy.
interface Mapping {
  readonly status: number;
  readonly code?: string;
}

const ERROR_REGISTRY: Readonly<Record<string, Mapping>> = Object.freeze({
  // ── 404 not found ──
  CoupledPairNotFoundError: { status: 404 },
  AccountNotFoundError: { status: 404 },
  OutboxEventNotFoundError: { status: 404 },
  RoseNoteNotFoundError: { status: 404 },
  // Epic-8 position flow (Stories 8.3/8.6): an absent pair/position the open/close referenced.
  PositionPairNotFoundError: { status: 404 },
  PositionNotFoundError: { status: 404 },
  NotFoundError: { status: 404, code: 'NOT_FOUND' },

  // ── 403 recipient eligibility rejection (FR-19 — the subscriber cannot receive tokens) ──
  IneligibleSubscriberError: { status: 403, code: 'SUBSCRIBER_NOT_ELIGIBLE' },

  // ── 422 domain rule rejection ──
  NotDeltaNeutralError: { status: 422 },
  InvalidCoupledPairError: { status: 422 },
  InvalidPairAmountError: { status: 422 },
  SingleLegIssuanceError: { status: 422 },
  InvalidMintAmountError: { status: 422 },
  InvalidTransferError: { status: 422 },
  InvalidJournalEntryError: { status: 422 },
  AccountPlacementError: { status: 422 },
  AccountFactMismatchError: { status: 422 },
  RuleSpecValidationError: { status: 422 },
  EmptyFlowPolicyError: { status: 422 },
  InconsistentFlowPolicyError: { status: 422 },
  MintAuthorizationError: { status: 422 },
  BurnAuthorizationError: { status: 422 },
  // Simulation settings (paper-mode replay feed): an out-of-range/non-finite parameter patch.
  SimulationSettingsError: { status: 400 },
  MintQuantityDivergenceError: { status: 422 },
  BurnQuantityDivergenceError: { status: 422 },
  ConformanceFailureError: { status: 422 },
  UnsupportedPaymentAssetError: { status: 422 },
  InvalidSubscriptionAmountError: { status: 422 },
  InvalidRedemptionAmountError: { status: 422 },
  InvalidStrategyResetError: { status: 422 },

  // ── 409 invariant / idempotency conflict ──
  UnbalancedEntryError: { status: 409 },
  IllegalPairTransitionError: { status: 409 },
  IllegalOutboxTransitionError: { status: 409 },
  UnreconciledDivergenceError: { status: 409 },
  InvalidCorrectionAccountsError: { status: 409 },
  SubscriptionPairNotActiveError: { status: 409 },
  SubscriptionIdempotencyConflictError: { status: 409 },
  RedemptionPairNotActiveError: { status: 409 },
  RedemptionIdempotencyConflictError: { status: 409 },
  StrategyResetIdempotencyConflictError: { status: 409 },
  CoupledPairResetStateError: { status: 409 },
  // Epic-8 position flow (Stories 8.3/8.6): a non-ACTIVE pair, a reused idempotency key with a
  // different request, or a re-close of a non-OPEN position — all invariant/lifecycle conflicts.
  PositionPairNotActiveError: { status: 409 },
  PositionIdempotencyConflictError: { status: 409 },
  PositionLifecycleError: { status: 409 },
  // §11.4 solvency guardrail (Story 8.6): the independent single-side close (D1 topology — the
  // opposite leg held by another user) is fail-closed until the §8 Q8 counterparty/inventory model
  // lands. A named refusal (UX-DR5), not a silent failure; the message names the guardrail rule.
  SolvencyGuardrailError: { status: 409, code: 'SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED' },

  // ── 503 refuse-if-absent server configuration (a typed refusal, NOT an opaque 500) ──
  ConfigRefusalError: { status: 503 },
  ChainConfigRefusalError: { status: 503 },
});

const GENERIC_500: MappedErrorResponse = Object.freeze({
  status: 500,
  body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
});

function asError(error: unknown): { name?: string; message?: string } {
  return typeof error === 'object' && error !== null
    ? (error as { name?: string; message?: string })
    : {};
}

/**
 * Translate a thrown error into `{ status, body }`. Authorization `TransferRefusedError` splits on
 * its `effect` (`DENY` ⇒ 403, `REFUSE` ⇒ 422); every other mapped class uses the name registry; an
 * `ApiError` carries its own status/code; anything unmapped is a generic, NON-LEAKING 500 (the raw
 * message/stack is never echoed). Mapped domain refusals DO carry their specific message so a
 * surface can name the refusing rule (UX-DR5).
 */
export function mapErrorToResponse(error: unknown): MappedErrorResponse {
  // An API-layer error carries its own status/code.
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, ...detailsOf(error.details) } },
    };
  }

  const e = asError(error);
  const name = e.name;
  const message = typeof e.message === 'string' ? e.message : '';

  // Authorization refusal split: DENY ⇒ 403, REFUSE ⇒ 422 (named-rule reason in the message). The
  // capital-flow chokepoint (`TransferRefusedError`) AND the paired mint/burn gate
  // (`MintAuthorizationError`/`BurnAuthorizationError`) carry the SAME `effect`, so they map
  // consistently — a default-deny DENY on a subscription is a 403, not a 422 (UX-DR5).
  if (
    name === 'TransferRefusedError' ||
    name === 'MintAuthorizationError' ||
    name === 'BurnAuthorizationError'
  ) {
    const effect = (error as { effect?: unknown }).effect;
    const reason = (error as { reason?: unknown }).reason;
    const details = typeof reason === 'string' ? { details: { reason } } : {};
    if (effect === 'DENY') {
      return {
        status: 403,
        body: { error: { code: 'AUTHORIZATION_DENIED', message, ...details } },
      };
    }
    if (effect === 'REFUSE') {
      return {
        status: 422,
        body: { error: { code: 'AUTHORIZATION_REFUSED', message, ...details } },
      };
    }
    // `TransferRefusedError` with an unknown effect fails closed to 403 (still a refusal). A
    // Mint/Burn authorization error WITHOUT a structured effect falls through to the name registry
    // (422) — preserving the established mapping for those classes.
    if (name === 'TransferRefusedError') {
      return {
        status: 403,
        body: { error: { code: 'AUTHORIZATION_DENIED', message, ...details } },
      };
    }
  }

  if (name !== undefined && Object.prototype.hasOwnProperty.call(ERROR_REGISTRY, name)) {
    const mapping = ERROR_REGISTRY[name]!;
    return { status: mapping.status, body: { error: { code: mapping.code ?? name, message } } };
  }

  // Unmapped ⇒ generic, non-leaking 500.
  return GENERIC_500;
}

function detailsOf(details: unknown): { details?: unknown } {
  return details === undefined ? {} : { details };
}
