// Paper-mode simulation settings (infrastructure, NOT a BMAD story). A tiny in-memory, mutable store
// for the parameters of the LIVE replay feed (`paper-replay-oracle`): the oscillation `amplitude`
// (fractional move around each pair's anchor), the `periodSeconds` (one full cycle), the feed `mode`
// (`sine` — a pure clock-based oscillation, or `directional-change` — an intrinsic-time δ-threshold
// random walk with overshoots, PRD §1/§4.7), and the `dcThreshold` (the δ directional-change threshold,
// only meaningful in DC mode but always stored). The Simulation settings screen reads/writes it over the
// API so the demo's price dynamics can be tuned live, with NO redeploy and NO env var. It holds NO money
// state and writes NO postings; it only shapes a simulated market-data feed. A monotonic `version` is
// bumped on every change so the oracle can cheaply rebuild its cached tick series only when a parameter
// actually changed.

/** The selectable shape of the replay feed: a clock-based sine, or a directional-change (intrinsic-time)
 * δ-threshold random walk with overshoots. `sine` is the default (today's behaviour, unchanged). */
export type SimulationFeedMode = 'sine' | 'directional-change';

/** The set of valid feed modes (the single source of truth for the enum validation). */
export const SIMULATION_FEED_MODES: readonly SimulationFeedMode[] = ['sine', 'directional-change'];

/** The tunable parameters of the paper replay feed. */
export interface SimulationSettings {
  /** Fractional oscillation amplitude around each pair's anchor P₀ (0 = a flat feed). */
  readonly amplitude: number;
  /** Duration of one full oscillation cycle, in seconds. */
  readonly periodSeconds: number;
  /** The feed shape: clock-based `sine` (default) or intrinsic-time `directional-change`. */
  readonly mode: SimulationFeedMode;
  /** The δ directional-change threshold as a fraction (e.g. 0.01 = 1%); only meaningful in DC mode. */
  readonly dcThreshold: number;
}

/** The inclusive bounds the settings are validated against (surfaced to the UI for its controls). */
export interface SimulationSettingsBounds {
  readonly amplitudeMin: number;
  readonly amplitudeMax: number;
  readonly periodSecondsMin: number;
  readonly periodSecondsMax: number;
  readonly dcThresholdMin: number;
  readonly dcThresholdMax: number;
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

/**
 * Default feed parameters: a ~7% swing on a 2-minute cycle (a visible, trust-band-safe move), in the
 * baseline `sine` mode with a 1% directional-change threshold parked for when DC mode is selected. Keeping
 * `mode: 'sine'` the default means nothing changes behaviourally unless an operator toggles DC mode.
 */
export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  amplitude: 0.07,
  periodSeconds: 120,
  mode: 'sine',
  dcThreshold: 0.01,
};

/**
 * The validation bounds. `amplitudeMax` is deliberately permissive (up to 1.0) so an operator CAN push
 * the feed past the §15 trust band and demonstrate the DIVERGENT mark state on a 3× pair — the guardrail
 * is in the mark-to-market service, not here. `periodSeconds` is bounded to a sane, demoable range.
 * `dcThreshold` (δ) is bounded to a small, visible band of intrinsic-time reversal sizes (0.1%..20%).
 */
export const SIMULATION_SETTINGS_BOUNDS: SimulationSettingsBounds = {
  amplitudeMin: 0,
  amplitudeMax: 1,
  periodSecondsMin: 5,
  periodSecondsMax: 3600,
  dcThresholdMin: 0.001,
  dcThresholdMax: 0.2,
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

function requireMode(value: SimulationFeedMode): void {
  if (!SIMULATION_FEED_MODES.includes(value)) {
    throw new SimulationSettingsError(
      'mode',
      `mode must be one of [${SIMULATION_FEED_MODES.join(', ')}] (got ${String(value)}).`,
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
    mode: current.mode,
    dcThreshold: current.dcThreshold,
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
    requireMode(next.mode);
    requireInRange(
      'dcThreshold',
      next.dcThreshold,
      SIMULATION_SETTINGS_BOUNDS.dcThresholdMin,
      SIMULATION_SETTINGS_BOUNDS.dcThresholdMax,
    );
    current = {
      amplitude: next.amplitude,
      periodSeconds: next.periodSeconds,
      mode: next.mode,
      dcThreshold: next.dcThreshold,
    };
    version += 1;
    return view();
  };

  return {
    get: view,
    set: (patch) =>
      apply({
        amplitude: patch.amplitude ?? current.amplitude,
        periodSeconds: patch.periodSeconds ?? current.periodSeconds,
        mode: patch.mode ?? current.mode,
        dcThreshold: patch.dcThreshold ?? current.dcThreshold,
      }),
    reset: () => apply({ ...DEFAULT_SIMULATION_SETTINGS }),
  };
}
