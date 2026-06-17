// THROWAWAY (Story 7.3, FR-17 / SM-3) — a pure, in-memory coupled-pair lifecycle state machine.
//
// PURPOSE: make the full pair lifecycle `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) →
// CLOSED` TRAVERSABLE and OBSERVABLE end-to-end over a tick-set trial (SM-3). This is the
// throwaway evidence twin of the /prod lifecycle — no DB, no async, no persistence: just the
// legal transition set and an ordered history log.
//
// SINGLE SOURCE OF TRUTH (FR-4): the allowed transitions below MIRROR
// `prod/packages/ledger/src/repositories/coupled-pairs.ts` `COUPLED_PAIR_TRANSITIONS`. We
// deliberately DO NOT import that module — it pulls `drizzle-orm` and DB types into the throwaway
// typecheck graph, and the regime rule keeps /throwaway lean. The cost of mirroring is a drift
// risk: if the /prod transition set changes, this table must be updated to match. The lifecycle
// test pins the exact table so the mirror is at least self-consistent and reviewable.

/** The six lifecycle states (PRD glossary / FR-4). */
export type CoupledPairState =
  | 'PENDING'
  | 'ACTIVE'
  | 'REBALANCING'
  | 'PARTIAL'
  | 'SETTLING'
  | 'CLOSED';

/**
 * The legal lifecycle transitions, keyed by source state — MIRRORS the /prod single source of
 * truth (FR-4). Notes carried from /prod:
 *   • PENDING activates only to ACTIVE (no skipping activation).
 *   • ACTIVE enters the rebalance cluster via REBALANCING, or winds down via SETTLING.
 *     ACTIVE → PARTIAL is NOT allowed directly: PARTIAL is a mid-rebalance transient, reached
 *     only from within a rebalance (REBALANCING → PARTIAL).
 *   • REBALANCING/PARTIAL return to ACTIVE (rebalance completed) and route to close only via
 *     SETTLING (you settle before you close).
 *   • SETTLING is the single pre-close state → CLOSED. CLOSED is terminal (no resurrection).
 * [Source: prod/packages/ledger/src/repositories/coupled-pairs.ts:215-225 COUPLED_PAIR_TRANSITIONS]
 */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<CoupledPairState, readonly CoupledPairState[]>
> = Object.freeze({
  PENDING: ['ACTIVE'],
  ACTIVE: ['REBALANCING', 'SETTLING'],
  REBALANCING: ['PARTIAL', 'ACTIVE', 'SETTLING'],
  PARTIAL: ['REBALANCING', 'ACTIVE', 'SETTLING'],
  SETTLING: ['CLOSED'],
  CLOSED: [], // terminal
});

/** True if a pair may move directly from `from` to `to` per the FR-4 transition set. */
export function isTransitionAllowed(from: CoupledPairState, to: CoupledPairState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Thrown when a requested lifecycle transition is not in the allowed set (fail-closed). */
export class IllegalLifecycleTransitionError extends Error {
  readonly from: CoupledPairState;
  readonly to: CoupledPairState;
  constructor(from: CoupledPairState, to: CoupledPairState) {
    super(`Illegal coupled-pair lifecycle transition: ${from} -> ${to}.`);
    this.name = 'IllegalLifecycleTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * A coupled pair's lifecycle as a pure in-memory state machine. Starts at `PENDING` and records
 * an ordered transition `history` (the observable audit trail for SM-3). Every transition is
 * validated against `LIFECYCLE_TRANSITIONS`; an illegal move throws (and a same-state no-op is
 * rejected — a transition must change state, matching the /prod trigger semantics).
 */
export class Lifecycle {
  private state: CoupledPairState = 'PENDING';
  private readonly log: CoupledPairState[] = ['PENDING'];

  /** The current lifecycle state. */
  get current(): CoupledPairState {
    return this.state;
  }

  /** The ordered history of states visited, beginning with `PENDING`. */
  get history(): readonly CoupledPairState[] {
    return this.log;
  }

  /** Move to `to`, recording it in history. Throws `IllegalLifecycleTransitionError` if illegal. */
  transitionTo(to: CoupledPairState): void {
    if (!isTransitionAllowed(this.state, to)) {
      throw new IllegalLifecycleTransitionError(this.state, to);
    }
    this.state = to;
    this.log.push(to);
  }

  /** PENDING → ACTIVE (the pair is issued and becomes active). */
  activate(): void {
    this.transitionTo('ACTIVE');
  }

  /** ACTIVE → REBALANCING (a floor breach / reset opens the rebalance window). */
  beginRebalance(): void {
    this.transitionTo('REBALANCING');
  }

  /** REBALANCING → PARTIAL (a mid-rebalance transient: a partial settlement step). */
  partial(): void {
    this.transitionTo('PARTIAL');
  }

  /** REBALANCING|PARTIAL → ACTIVE (the rebalance completed; back to the active state). */
  completeRebalance(): void {
    this.transitionTo('ACTIVE');
  }

  /** ACTIVE → SETTLING (begin wind-down before close). */
  settle(): void {
    this.transitionTo('SETTLING');
  }

  /** SETTLING → CLOSED (terminal). */
  close(): void {
    this.transitionTo('CLOSED');
  }
}
