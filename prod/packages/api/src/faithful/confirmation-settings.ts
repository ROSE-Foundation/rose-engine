// Faithful-mode confirmation settings (Story 9.1, FR-28). A tiny in-memory, mutable, fail-closed store
// for the trust inputs of the ASYNC on-chain confirmation transport: the realistic `latencyMs` the mock
// watcher waits before driving the `pending → confirmed` commit point, the `failureRate` (the fraction
// of flows the mock watcher reports as failed → saga compensation), and a `failNext` one-shot ("fail the
// next flow") control. It mirrors `simulation-settings.ts`: documented `faithful` DEFAULTS, inclusive
// validation BOUNDS (out-of-range/non-finite is REFUSED, never silently clamped or defaulted — NFR-4),
// and a monotonic `version`. Story 9.5 will expose an operator control over this store; THIS story
// provides the validated store + a programmatic setter (and the `failNext` one-shot consumer the
// transport reads). It holds NO money state and writes NO postings — it only shapes confirmation timing.

/** The tunable trust inputs of the faithful async-confirmation transport. */
export interface FaithfulConfirmationSettings {
  /** Realistic on-chain confirmation latency, in milliseconds, before the delayed commit point fires. */
  readonly latencyMs: number;
  /** Fraction of flows the mock watcher reports as FAILED (→ saga compensation). 0 = never, 1 = always. */
  readonly failureRate: number;
  /** One-shot "fail the next confirmed flow" control (consumed when the next confirmation is scheduled). */
  readonly failNext: boolean;
}

/** The inclusive bounds the settings are validated against (surfaced to the UI for its controls). */
export interface FaithfulConfirmationBounds {
  readonly latencyMsMin: number;
  readonly latencyMsMax: number;
  readonly failureRateMin: number;
  readonly failureRateMax: number;
}

/** The settings plus the monotonic version + the validation bounds (the full read view). */
export interface FaithfulConfirmationSettingsView extends FaithfulConfirmationSettings {
  readonly version: number;
  readonly bounds: FaithfulConfirmationBounds;
}

/** The injected settings port: read, patch (validated), reset, and consume the `failNext` one-shot. */
export interface FaithfulConfirmationSettingsStore {
  get(): FaithfulConfirmationSettingsView;
  set(patch: Partial<FaithfulConfirmationSettings>): FaithfulConfirmationSettingsView;
  reset(): FaithfulConfirmationSettingsView;
  /**
   * Reads the current `failNext` one-shot and clears it, returning the prior value. The transport calls
   * this exactly once when it schedules a confirmation, so an explicit "fail next" affects exactly one
   * flow. Clearing the one-shot is an internal consumption, NOT an operator change — it does not bump
   * `version`.
   */
  consumeFailNext(): boolean;
}

/** Thrown when a patch is out of range / not a finite number / wrong type. Maps to a 400 at the boundary. */
export class FaithfulConfirmationSettingsError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'FaithfulConfirmationSettingsError';
    this.field = field;
  }
}

/**
 * The documented `faithful` DEFAULTS: a realistic 2-second confirmation latency, NO injected failures
 * (the operator opts in via `failureRate`/`failNext`). These are the ONLY values the store may assume
 * absent an explicit patch (NFR-4: every other input is validated, never silently defaulted).
 */
export const DEFAULT_FAITHFUL_CONFIRMATION_SETTINGS: FaithfulConfirmationSettings = {
  latencyMs: 2000,
  failureRate: 0,
  failNext: false,
};

/**
 * The validation bounds. `latencyMs` spans [0 ms, 10 min] — 0 is a valid (degenerate) instant-ish value
 * (the commit point still fires on a later scheduler turn, preserving "no optimistic success at submit");
 * the default is a realistic 2000 ms. `failureRate` is a probability in [0, 1].
 */
export const FAITHFUL_CONFIRMATION_BOUNDS: FaithfulConfirmationBounds = {
  latencyMsMin: 0,
  latencyMsMax: 600_000,
  failureRateMin: 0,
  failureRateMax: 1,
};

function requireIntInRange(field: string, value: number, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FaithfulConfirmationSettingsError(
      field,
      `${field} must be a finite number (got ${String(value)}).`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new FaithfulConfirmationSettingsError(
      field,
      `${field} must be an integer (got ${value}).`,
    );
  }
  if (value < min || value > max) {
    throw new FaithfulConfirmationSettingsError(
      field,
      `${field} must be within [${min}, ${max}] (got ${value}).`,
    );
  }
}

function requireNumberInRange(field: string, value: number, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FaithfulConfirmationSettingsError(
      field,
      `${field} must be a finite number (got ${String(value)}).`,
    );
  }
  if (value < min || value > max) {
    throw new FaithfulConfirmationSettingsError(
      field,
      `${field} must be within [${min}, ${max}] (got ${value}).`,
    );
  }
}

function requireBoolean(field: string, value: boolean): void {
  if (typeof value !== 'boolean') {
    throw new FaithfulConfirmationSettingsError(
      field,
      `${field} must be a boolean (got ${String(value)}).`,
    );
  }
}

/**
 * Builds an in-memory faithful-confirmation settings store. Validates every patch against the bounds
 * (fail-closed: an out-of-range value is REFUSED, never clamped silently — NFR-4) and bumps `version`
 * on each accepted change. `consumeFailNext` reads+clears the one-shot without bumping `version`.
 */
export function makeFaithfulConfirmationSettingsStore(
  initial: FaithfulConfirmationSettings = DEFAULT_FAITHFUL_CONFIRMATION_SETTINGS,
): FaithfulConfirmationSettingsStore {
  let current: FaithfulConfirmationSettings = { ...initial };
  let version = 0;

  const view = (): FaithfulConfirmationSettingsView => ({
    latencyMs: current.latencyMs,
    failureRate: current.failureRate,
    failNext: current.failNext,
    version,
    bounds: FAITHFUL_CONFIRMATION_BOUNDS,
  });

  const apply = (next: FaithfulConfirmationSettings): FaithfulConfirmationSettingsView => {
    requireIntInRange(
      'latencyMs',
      next.latencyMs,
      FAITHFUL_CONFIRMATION_BOUNDS.latencyMsMin,
      FAITHFUL_CONFIRMATION_BOUNDS.latencyMsMax,
    );
    requireNumberInRange(
      'failureRate',
      next.failureRate,
      FAITHFUL_CONFIRMATION_BOUNDS.failureRateMin,
      FAITHFUL_CONFIRMATION_BOUNDS.failureRateMax,
    );
    requireBoolean('failNext', next.failNext);
    current = {
      latencyMs: next.latencyMs,
      failureRate: next.failureRate,
      failNext: next.failNext,
    };
    version += 1;
    return view();
  };

  // Validate the seed settings up front — a faithful store is never built with an out-of-range default.
  apply({ ...initial });
  version = 0;

  return {
    get: view,
    set: (patch) =>
      apply({
        latencyMs: patch.latencyMs ?? current.latencyMs,
        failureRate: patch.failureRate ?? current.failureRate,
        failNext: patch.failNext ?? current.failNext,
      }),
    reset: () => apply({ ...DEFAULT_FAITHFUL_CONFIRMATION_SETTINGS }),
    consumeFailNext: () => {
      const prior = current.failNext;
      if (prior) {
        current = { ...current, failNext: false };
      }
      return prior;
    },
  };
}
