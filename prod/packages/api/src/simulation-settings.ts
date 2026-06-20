// Paper-mode simulation settings (infrastructure, NOT a BMAD story). A tiny in-memory, mutable store
// for the parameters of the LIVE replay feed (`paper-replay-oracle`): the oscillation `amplitude`
// (fractional move around each pair's anchor) and the `periodSeconds` (one full cycle). The Simulation
// settings screen reads/writes it over the API so the demo's price dynamics can be tuned live, with NO
// redeploy and NO env var. It holds NO money state and writes NO postings; it only shapes a simulated
// market-data feed. A monotonic `version` is bumped on every change so the oracle can cheaply rebuild
// its cached tick series only when a parameter actually changed.

/** The tunable parameters of the paper replay feed. */
export interface SimulationSettings {
  /** Fractional oscillation amplitude around each pair's anchor P₀ (0 = a flat feed). */
  readonly amplitude: number;
  /** Duration of one full oscillation cycle, in seconds. */
  readonly periodSeconds: number;
}

/** The inclusive bounds the settings are validated against (surfaced to the UI for its controls). */
export interface SimulationSettingsBounds {
  readonly amplitudeMin: number;
  readonly amplitudeMax: number;
  readonly periodSecondsMin: number;
  readonly periodSecondsMax: number;
}

/** The settings plus the monotonic version + the validation bounds (the full read view). */
export interface SimulationSettingsView extends SimulationSettings {
  readonly version: number;
  readonly bounds: SimulationSettingsBounds;
}

/** The injected settings port: read the current view, patch it, or reset to defaults. */
export interface SimulationSettingsStore {
  get(): SimulationSettingsView;
  set(patch: Partial<SimulationSettings>): SimulationSettingsView;
  reset(): SimulationSettingsView;
}

/** Thrown when a patch is out of range / not a finite number. Maps to a 400 at the API boundary. */
export class SimulationSettingsError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'SimulationSettingsError';
    this.field = field;
  }
}

/** Default feed parameters: a ~7% swing on a 2-minute cycle (a visible, trust-band-safe move). */
export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  amplitude: 0.07,
  periodSeconds: 120,
};

/**
 * The validation bounds. `amplitudeMax` is deliberately permissive (up to 1.0) so an operator CAN push
 * the feed past the §15 trust band and demonstrate the DIVERGENT mark state on a 3× pair — the guardrail
 * is in the mark-to-market service, not here. `periodSeconds` is bounded to a sane, demoable range.
 */
export const SIMULATION_SETTINGS_BOUNDS: SimulationSettingsBounds = {
  amplitudeMin: 0,
  amplitudeMax: 1,
  periodSecondsMin: 5,
  periodSecondsMax: 3600,
};

function requireInRange(field: string, value: number, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SimulationSettingsError(
      field,
      `${field} must be a finite number (got ${String(value)}).`,
    );
  }
  if (value < min || value > max) {
    throw new SimulationSettingsError(
      field,
      `${field} must be within [${min}, ${max}] (got ${value}).`,
    );
  }
}

/**
 * Builds an in-memory simulation-settings store. Validates every patch against the bounds (fail-closed:
 * an out-of-range value is rejected, never clamped silently) and bumps `version` on each accepted change.
 */
export function makeSimulationSettingsStore(
  initial: SimulationSettings = DEFAULT_SIMULATION_SETTINGS,
): SimulationSettingsStore {
  let current: SimulationSettings = { ...initial };
  let version = 0;

  const view = (): SimulationSettingsView => ({
    amplitude: current.amplitude,
    periodSeconds: current.periodSeconds,
    version,
    bounds: SIMULATION_SETTINGS_BOUNDS,
  });

  const apply = (next: SimulationSettings): SimulationSettingsView => {
    requireInRange(
      'amplitude',
      next.amplitude,
      SIMULATION_SETTINGS_BOUNDS.amplitudeMin,
      SIMULATION_SETTINGS_BOUNDS.amplitudeMax,
    );
    requireInRange(
      'periodSeconds',
      next.periodSeconds,
      SIMULATION_SETTINGS_BOUNDS.periodSecondsMin,
      SIMULATION_SETTINGS_BOUNDS.periodSecondsMax,
    );
    current = { amplitude: next.amplitude, periodSeconds: next.periodSeconds };
    version += 1;
    return view();
  };

  return {
    get: view,
    set: (patch) =>
      apply({
        amplitude: patch.amplitude ?? current.amplitude,
        periodSeconds: patch.periodSeconds ?? current.periodSeconds,
      }),
    reset: () => apply({ ...DEFAULT_SIMULATION_SETTINGS }),
  };
}
