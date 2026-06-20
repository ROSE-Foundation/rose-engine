// Faithful-mode operator covenant-breach override (Story 9.5, FR-32). A tiny in-memory, mutable,
// fail-closed toggle the REAL `@rose/reconcile` group-view covenant computation consults (via
// `BuildGroupViewOptions.forceCovenantBreach`) so an operator can make the Treasury/Covenant monitor
// report a GENUINE BREACH — derived through the real `computeCovenant`/`covenantStatus` path against a
// documented stress threshold, NOT a cosmetic label. Clearable. It holds NO money state and writes NO
// postings — it only shapes whether the covenant monitor stresses the backing-float-floor. Mirrors the
// `simulation-settings` / `confirmation-settings` store idiom: a monotonic `version` bumps on every
// state-CHANGING set (a no-op does not bump it), so a UI can detect a real change.

/** The covenant-breach override state: whether a breach is being forced + the monotonic version. */
export interface FaithfulCovenantOverrideState {
  /** When true, the group-view covenant monitor genuinely reports a BREACH (operator injection). */
  readonly active: boolean;
  /** The store's monotonic version (bumps on every state change). */
  readonly version: number;
}

/** The injected covenant-override port: read the state, set it (active/cleared). */
export interface FaithfulCovenantOverrideStore {
  get(): FaithfulCovenantOverrideState;
  /** Set whether a covenant breach is forced. A no-op (same value) does not bump `version`. */
  set(active: boolean): FaithfulCovenantOverrideState;
}

/** Builds an in-memory faithful covenant-breach override (defaults to inactive — no breach forced). */
export function makeFaithfulCovenantOverrideStore(
  initialActive = false,
): FaithfulCovenantOverrideStore {
  let active = initialActive;
  let version = 0;
  const state = (): FaithfulCovenantOverrideState => ({ active, version });
  return Object.freeze({
    get: state,
    set(next: boolean): FaithfulCovenantOverrideState {
      if (next !== active) {
        active = next;
        version += 1;
      }
      return state();
    },
  });
}
