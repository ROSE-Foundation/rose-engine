// THROWAWAY (Story 7.1, FR-15) — fail-closed loading of the model floor parameters m and g.
//
// `m` (safety margin) and `g` (worst plausible gap over the reaction window) are PARKED
// parameters (PRD §11.2, NFR-4): absence is a REFUSAL, never a permissive default (and
// never 0). The env keys mirror @rose/config (MODEL_FLOOR_M / MODEL_FLOOR_G) so the throwaway
// harness stays consistent with PROD while remaining self-contained and independently
// testable. Values are read as decimal strings (never JS `number` — NFR-2) and validated.
// A safety margin and a worst-gap are positive quantities: a zero/negative value would yield
// a floor that never (or perversely) breaches, silently masking the model risk this harness
// exists to surface — so non-positive m/g is refused exactly like absence (fail-closed).

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export const MODEL_FLOOR_M_KEY = 'MODEL_FLOOR_M' as const;
export const MODEL_FLOOR_G_KEY = 'MODEL_FLOOR_G' as const;

/** The model floor inputs as exact decimal strings. */
export interface FloorParams {
  /** Safety margin `m`. */
  readonly m: string;
  /** Worst plausible gap over the reaction window `g`. */
  readonly g: string;
}

/** Thrown when `m` or `g` is absent or invalid — fail-closed, never defaulted (NFR-4, §11.2). */
export class FloorParamRefusalError extends Error {
  readonly missingOrInvalid: readonly string[];
  constructor(keys: readonly string[]) {
    super(
      `Refusing to compute the floor: missing or invalid model floor parameter(s): ${keys.join(
        ', ',
      )}. ` +
        `m and g are parked parameters and are NEVER defaulted (NFR-4, §11.2; SM-C1 falsifiability).`,
    );
    this.name = 'FloorParamRefusalError';
    this.missingOrInvalid = keys;
  }
}

/** A valid floor parameter is a decimal string denoting a STRICTLY POSITIVE value. */
function validDecimal(value: string | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !DECIMAL_PATTERN.test(trimmed)) {
    return false;
  }
  // Strictly positive: not negative, not zero (no "0", "0.0", "-0.0" etc.).
  return !trimmed.startsWith('-') && /[1-9]/.test(trimmed);
}

/**
 * Reads `MODEL_FLOOR_M` / `MODEL_FLOOR_G` from `env` (default `process.env`). Returns the
 * validated `FloorParams` on success; throws `FloorParamRefusalError` naming EVERY offending
 * key on any absence/invalidity. Never substitutes a default for an absent value.
 */
export function loadFloorParams(
  env: Record<string, string | undefined> = process.env,
): FloorParams {
  const offenders: string[] = [];
  if (env === null || typeof env !== 'object') {
    throw new FloorParamRefusalError([MODEL_FLOOR_M_KEY, MODEL_FLOOR_G_KEY]);
  }
  if (!validDecimal(env[MODEL_FLOOR_M_KEY])) {
    offenders.push(MODEL_FLOOR_M_KEY);
  }
  if (!validDecimal(env[MODEL_FLOOR_G_KEY])) {
    offenders.push(MODEL_FLOOR_G_KEY);
  }
  if (offenders.length > 0) {
    throw new FloorParamRefusalError(offenders);
  }
  return Object.freeze({
    m: env[MODEL_FLOOR_M_KEY]!.trim(),
    g: env[MODEL_FLOOR_G_KEY]!.trim(),
  });
}
