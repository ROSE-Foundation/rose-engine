// Typed, fail-closed configuration loader (Story 1.3, Architecture §Authentication & Security,
// NFR-4, §11.2). The "parked parameters" are correctness-critical values the PRD forbids
// defaulting: absence is a REFUSAL, never a permissive default (and never 0). Values are
// read from the environment as decimal strings (never JS `number` — NFR-2) and validated
// with Zod; downstream stories parse the monetary ones with @rose/shared when asset/scale
// is known.

import { z } from 'zod';

// A required, non-empty decimal string. No `.default(...)` — refuse-if-absent is the point.
// `.trim()` absorbs incidental surrounding whitespace/newlines from env injection; the regex
// then rejects whitespace-only, empty, and non-numeric values. Binary floats cannot enter
// because the input is a string and is never coerced via Number()/parseFloat.
const decimalString = z
  .string()
  .trim()
  .min(1, 'required')
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

const ParkedParametersSchema = z.object({
  NOTE_COUPON: decimalString,
  USE_OF_PROCEEDS_SPLIT: decimalString,
  CONVERSION_TO_PARTICIPATION: decimalString,
  BACKING_FLOAT_FLOOR: decimalString,
  MODEL_FLOOR_M: decimalString,
  MODEL_FLOOR_G: decimalString,
});

/** Env keys for the six parked parameters — derived from the schema so they cannot drift. */
export type ParkedParameterKey = keyof z.infer<typeof ParkedParametersSchema>;
export const PARKED_PARAMETER_KEYS = Object.keys(
  ParkedParametersSchema.shape,
) as ParkedParameterKey[];

/** The validated, typed config consumed by the rest of PROD (decimal strings). */
export interface RoseConfig {
  readonly noteCoupon: string;
  readonly useOfProceedsSplit: string;
  readonly conversionToParticipation: string;
  readonly backingFloatFloor: string;
  readonly modelFloorM: string;
  readonly modelFloorG: string;
}

// Maps each (schema-derived) env key to its camelCase config field. `Record<ParkedParameterKey,…>`
// is exhaustive: adding a parked parameter to the schema without mapping it here fails typecheck.
const KEY_TO_FIELD: Record<ParkedParameterKey, keyof RoseConfig> = {
  NOTE_COUPON: 'noteCoupon',
  USE_OF_PROCEEDS_SPLIT: 'useOfProceedsSplit',
  CONVERSION_TO_PARTICIPATION: 'conversionToParticipation',
  BACKING_FLOAT_FLOOR: 'backingFloatFloor',
  MODEL_FLOOR_M: 'modelFloorM',
  MODEL_FLOOR_G: 'modelFloorG',
};

/** Thrown when one or more parked parameters are absent or invalid — fail-closed (NFR-4). */
export class ConfigRefusalError extends Error {
  readonly missingOrInvalid: readonly string[];
  constructor(keys: readonly string[]) {
    super(
      `Refusing to start: missing or invalid parked parameter(s): ${keys.join(', ')}. ` +
        `Parked parameters must be configured explicitly and are never defaulted (NFR-4, §11.2).`,
    );
    this.name = 'ConfigRefusalError';
    this.missingOrInvalid = keys;
  }
}

/**
 * Loads and validates the parked parameters from `env` (default `process.env`). Returns a
 * typed, frozen config on success; throws `ConfigRefusalError` naming every offending key
 * on any absence/invalidity. Never substitutes a default for an absent value.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): RoseConfig {
  // A non-object env cannot yield any value — refuse, naming every parked parameter.
  if (env === null || typeof env !== 'object') {
    throw new ConfigRefusalError([...PARKED_PARAMETER_KEYS]);
  }
  const result = ParkedParametersSchema.safeParse(env);
  if (!result.success) {
    const named = [
      ...new Set(
        result.error.issues
          .map((issue) => String(issue.path[0]))
          .filter((key) => key !== 'undefined'),
      ),
    ].sort();
    // Fall back to naming all keys if Zod produced only a root-level (path-less) issue.
    throw new ConfigRefusalError(named.length > 0 ? named : [...PARKED_PARAMETER_KEYS]);
  }
  const v = result.data;
  const out: Record<string, string> = {};
  for (const key of PARKED_PARAMETER_KEYS) {
    out[KEY_TO_FIELD[key]] = v[key];
  }
  return Object.freeze(out) as unknown as RoseConfig;
}
