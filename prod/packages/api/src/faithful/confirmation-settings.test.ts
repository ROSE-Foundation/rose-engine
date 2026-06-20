// Story 9.1 (AC3) — the faithful-confirmation settings store is FAIL-CLOSED: out-of-range / non-finite /
// wrong-type inputs are REFUSED (never silently clamped or defaulted, NFR-4), EXCEPT the documented
// `faithful` defaults. Plus the `failNext` one-shot consumption semantics the transport relies on.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAITHFUL_CONFIRMATION_SETTINGS,
  FAITHFUL_CONFIRMATION_BOUNDS,
  FaithfulConfirmationSettingsError,
  makeFaithfulConfirmationSettingsStore,
} from './confirmation-settings.js';

describe('faithful-confirmation settings store — documented defaults', () => {
  it('starts at the documented faithful defaults (latency 2000ms, no failures) with version 0', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    const view = store.get();
    expect(view.latencyMs).toBe(DEFAULT_FAITHFUL_CONFIRMATION_SETTINGS.latencyMs);
    expect(view.latencyMs).toBe(2000);
    expect(view.failureRate).toBe(0);
    expect(view.failNext).toBe(false);
    expect(view.version).toBe(0);
    expect(view.bounds).toEqual(FAITHFUL_CONFIRMATION_BOUNDS);
  });

  it('accepts in-range patches and bumps version monotonically', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    const v1 = store.set({ latencyMs: 50 });
    expect(v1.latencyMs).toBe(50);
    expect(v1.version).toBe(1);
    const v2 = store.set({ failureRate: 1 });
    expect(v2.failureRate).toBe(1);
    expect(v2.latencyMs).toBe(50); // unchanged fields persist
    expect(v2.version).toBe(2);
  });

  it('allows the degenerate latency 0 and the boundary failureRate 0/1 (inclusive bounds)', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(store.set({ latencyMs: 0 }).latencyMs).toBe(0);
    expect(store.set({ failureRate: 0 }).failureRate).toBe(0);
    expect(store.set({ failureRate: 1 }).failureRate).toBe(1);
  });

  it('reset returns to the documented defaults', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    store.set({ latencyMs: 999, failureRate: 0.5 });
    const back = store.reset();
    expect(back.latencyMs).toBe(2000);
    expect(back.failureRate).toBe(0);
  });
});

describe('faithful-confirmation settings store — fail-closed validation (NFR-4)', () => {
  it('refuses a latency below the minimum', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(() => store.set({ latencyMs: -1 })).toThrow(FaithfulConfirmationSettingsError);
  });

  it('refuses a latency above the maximum', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(() => store.set({ latencyMs: FAITHFUL_CONFIRMATION_BOUNDS.latencyMsMax + 1 })).toThrow(
      FaithfulConfirmationSettingsError,
    );
  });

  it('refuses a non-integer latency', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(() => store.set({ latencyMs: 12.5 })).toThrow(/integer/);
  });

  it('refuses a non-finite latency', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(() => store.set({ latencyMs: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });

  it('refuses a failureRate below 0 or above 1', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(() => store.set({ failureRate: -0.01 })).toThrow(FaithfulConfirmationSettingsError);
    expect(() => store.set({ failureRate: 1.01 })).toThrow(FaithfulConfirmationSettingsError);
  });

  it('refuses a non-finite failureRate', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(() => store.set({ failureRate: Number.NaN })).toThrow(/finite/);
  });

  it('a refused patch leaves the prior value intact (no partial apply)', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    store.set({ latencyMs: 100 });
    expect(() => store.set({ latencyMs: -5 })).toThrow();
    expect(store.get().latencyMs).toBe(100);
    expect(store.get().version).toBe(1); // the refused patch did not bump version
  });

  it('refuses a seed built out of range', () => {
    expect(() =>
      makeFaithfulConfirmationSettingsStore({ latencyMs: -1, failureRate: 0, failNext: false }),
    ).toThrow(FaithfulConfirmationSettingsError);
  });
});

describe('faithful-confirmation settings store — failNext one-shot', () => {
  it('consumeFailNext returns true once then clears, without bumping version', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    const v = store.set({ failNext: true });
    expect(v.failNext).toBe(true);
    const versionBefore = store.get().version;
    expect(store.consumeFailNext()).toBe(true); // consumed
    expect(store.consumeFailNext()).toBe(false); // one-shot cleared
    expect(store.get().failNext).toBe(false);
    expect(store.get().version).toBe(versionBefore); // consumption is not an operator change
  });

  it('consumeFailNext is false when failNext was never set', () => {
    const store = makeFaithfulConfirmationSettingsStore();
    expect(store.consumeFailNext()).toBe(false);
  });
});
