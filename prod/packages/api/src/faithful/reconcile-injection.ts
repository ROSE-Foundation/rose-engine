// Faithful-mode operator reconcile-divergence injection (Story 9.5, FR-32). A tiny in-memory, mutable,
// fail-closed toggle that, while ACTIVE, makes the NEXT `POST /positions/reconcile` run REPORT-AND-CORRECT
// a genuine position↔pair divergence through the SAME real Story-8.5 reconcile-and-correct path (a
// journaled, surfaced, balanced voiding entry + OPEN→CLOSED flip — never a silent change, NFR-3). The
// actual plan (which OPEN position/pair to diverge + the balanced claim/contra correction accounts) is
// built lazily from the live DB by `@rose/positions` `buildInjectedDivergencePlan` at reconcile time —
// this store holds ONLY the on/off intent. Clearable. It holds NO money state and writes NO postings.
// Mirrors the `covenant-override` store idiom: a monotonic `version` bumps on every state-CHANGING set.

/** The reconcile-divergence injection state: whether the next reconcile diverges + the monotonic version. */
export interface FaithfulReconcileInjectionState {
  /** When true, the next `POST /positions/reconcile` injects a divergence (reported-and-corrected). */
  readonly active: boolean;
  /** The store's monotonic version (bumps on every state change). */
  readonly version: number;
}

/** The injected reconcile-divergence port: read the state, set it (active/cleared). */
export interface FaithfulReconcileInjectionStore {
  get(): FaithfulReconcileInjectionState;
  /** Set whether the next reconcile injects a divergence. A no-op (same value) does not bump `version`. */
  set(active: boolean): FaithfulReconcileInjectionState;
}

/** Builds an in-memory faithful reconcile-divergence injection (defaults to inactive). */
export function makeFaithfulReconcileInjectionStore(
  initialActive = false,
): FaithfulReconcileInjectionStore {
  let active = initialActive;
  let version = 0;
  const state = (): FaithfulReconcileInjectionState => ({ active, version });
  return Object.freeze({
    get: state,
    set(next: boolean): FaithfulReconcileInjectionState {
      if (next !== active) {
        active = next;
        version += 1;
      }
      return state();
    },
  });
}
