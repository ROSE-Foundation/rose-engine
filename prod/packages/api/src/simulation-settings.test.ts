// The in-memory simulation-settings store: defaults, validated patches (fail-closed on out-of-range,
// never clamped), partial patches, and the monotonic version bump that drives the replay oracle's
// cache rebuild. Pure (no DB, no network).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMULATION_SETTINGS,
  makeSimulationSettingsStore,
  SIMULATION_SETTINGS_BOUNDS,
  SimulationSettingsError,
} from './simulation-settings.js';

describe('simulation-settings store', () => {
  it('starts at the parked defaults, version 0, with the bounds attached', () => {
    const store = makeSimulationSettingsStore();
    const v = store.get();
    expect(v.amplitude).toBe(DEFAULT_SIMULATION_SETTINGS.amplitude);
    expect(v.periodSeconds).toBe(DEFAULT_SIMULATION_SETTINGS.periodSeconds);
    expect(v.version).toBe(0);
    expect(v.bounds).toEqual(SIMULATION_SETTINGS_BOUNDS);
  });

  it('applies a patch and bumps the version (so the oracle rebuilds its series)', () => {
    const store = makeSimulationSettingsStore();
    const next = store.set({ amplitude: 0.2, periodSeconds: 30 });
    expect(next.amplitude).toBe(0.2);
    expect(next.periodSeconds).toBe(30);
    expect(next.version).toBe(1);
    expect(store.get().version).toBe(1);
  });

  it('a partial patch leaves the unspecified field unchanged', () => {
    const store = makeSimulationSettingsStore();
    store.set({ amplitude: 0.15 });
    const v = store.get();
    expect(v.amplitude).toBe(0.15);
    expect(v.periodSeconds).toBe(DEFAULT_SIMULATION_SETTINGS.periodSeconds);
  });

  it('rejects an out-of-range amplitude (fail-closed, not clamped) and does not bump the version', () => {
    const store = makeSimulationSettingsStore();
    expect(() => store.set({ amplitude: 5 })).toThrow(SimulationSettingsError);
    expect(() => store.set({ amplitude: -0.1 })).toThrow(SimulationSettingsError);
    expect(store.get().amplitude).toBe(DEFAULT_SIMULATION_SETTINGS.amplitude);
    expect(store.get().version).toBe(0);
  });

  it('rejects an out-of-range or non-finite period', () => {
    const store = makeSimulationSettingsStore();
    expect(() => store.set({ periodSeconds: 1 })).toThrow(SimulationSettingsError); // below min
    expect(() => store.set({ periodSeconds: 100_000 })).toThrow(SimulationSettingsError); // above max
    expect(() => store.set({ periodSeconds: Number.NaN })).toThrow(SimulationSettingsError);
  });

  it('reset returns to defaults (and counts as a change → version bumps)', () => {
    const store = makeSimulationSettingsStore();
    store.set({ amplitude: 0.3, periodSeconds: 45 });
    const r = store.reset();
    expect(r.amplitude).toBe(DEFAULT_SIMULATION_SETTINGS.amplitude);
    expect(r.periodSeconds).toBe(DEFAULT_SIMULATION_SETTINGS.periodSeconds);
    expect(r.version).toBe(2);
  });
});
