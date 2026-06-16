// Reconciliation finality & cadence (Story 5.6, FR-10 / NFR-9, AC-4). PURE decision helpers that
// implement the architecture's reconciliation-cadence default (PRD §8 Q6, revisable):
//
//   • PER-EVENT  — reconciliation is triggered on each CONFIRMED mint/burn/transfer, once it has
//     reached the configured Sepolia CONFIRMATION DEPTH (finality);
//   • ON-DEMAND  — `reconcile` may also be invoked at any time (the caller just runs
//     `reconcileLedgerToChain` against a fresh authoritative snapshot);
//   • REORG      — a chain reorg that removes a previously-seen log, or drops it below the
//     confirmation depth, is itself treated as a RECONCILIATION EVENT: the ledger token quantities
//     are RE-DERIVED from the (new) authoritative chain state. Because `reconcileLedgerToChain` is
//     idempotent and corrects strictly TOWARD the chain (D3), re-running it after a reorg simply
//     moves the ledger to the new chain truth.
//
// DECOUPLING (the codebase's injected-port precedent — kept from Story 5.5): `@rose/reconcile` does
// NOT import `@rose/chain`. These helpers operate on PLAIN block-coordinate data
// (`ChainEventFinalityInput`), which is a structural SUBSET of `@rose/chain`'s `ChainEvent`
// envelope — so the live watcher→reconcile loop (Epic-6 composition) can pass its events directly
// with no new package edge. The real confirmation-depth value and the live cadence loop are the
// Epic-6 / ops-deferred seam; this module ships the pure, LOCAL-tested decision logic.
//
// All block numbers are `bigint` (chain block heights — never a JS float, NFR-2 spirit).

/** Thrown when a confirmation depth is not a positive integer (a meaningless finality threshold). */
export class InvalidConfirmationDepthError extends Error {
  constructor(depth: bigint) {
    super(`Confirmation depth must be a positive integer, got ${depth}.`);
    this.name = 'InvalidConfirmationDepthError';
  }
}

/**
 * Returns true when a transaction mined in `blockNumber` has reached `confirmationDepth`
 * confirmations relative to the current chain head `headBlockNumber`. The mining block counts as
 * the first confirmation, so depth 1 means "mined", depth 12 means "11 blocks built on top".
 * `confirmations = headBlockNumber − blockNumber + 1`; final ⇔ `confirmations >= confirmationDepth`.
 */
export function isFinal(
  blockNumber: bigint,
  headBlockNumber: bigint,
  confirmationDepth: bigint,
): boolean {
  if (confirmationDepth <= 0n) {
    throw new InvalidConfirmationDepthError(confirmationDepth);
  }
  const confirmations = headBlockNumber - blockNumber + 1n;
  return confirmations >= confirmationDepth;
}

/** Plain block-coordinate input for a finality decision — a structural subset of `ChainEvent`. */
export interface ChainEventFinalityInput {
  /** The block the event's tx mined in (null ⇒ pending, never mined). */
  readonly blockNumber: bigint | null;
  /** True when the log was removed by a reorg (viem's `Log.removed`). */
  readonly removed?: boolean;
  /** Current chain head height (from the public client). */
  readonly headBlockNumber: bigint;
  /** Configured Sepolia confirmation depth (positive integer). */
  readonly confirmationDepth: bigint;
}

/** The finality classification of a chain event for reconciliation-cadence purposes. */
export type ChainEventFinality = 'final' | 'pending' | 'reorg';

/**
 * Classifies a chain event for the reconciliation cadence (the architecture default: act AT the
 * configured confirmation depth; a reorg below that depth is itself a reconciliation event):
 *   • `reorg`   — the log was REMOVED (`removed === true`): a previously-observed log dropped by a
 *     reorg. This is the re-derivation trigger — re-read the (new) authoritative chain state and
 *     reconcile.
 *   • `final`   — mined and at/over the confirmation depth (safe to act on per-event).
 *   • `pending` — not yet mined (`blockNumber === null`) OR mined but still BELOW the confirmation
 *     depth (not yet final). Wait — do NOT reconcile before finality.
 *
 * Ordering: `removed` always wins (a removed log is a reorg even if `blockNumber` is set), then a
 * not-mined log is `pending`, then the depth threshold decides `final` vs `pending`. A mined-but-
 * shallow event is `pending` (NOT `reorg`): the cadence acts AT the confirmation depth, so a tx that
 * has not yet reached it is simply awaited — reconciling against not-yet-final supply would correct
 * toward a state a reorg could still rewrite.
 */
export function classifyChainEventFinality(input: ChainEventFinalityInput): ChainEventFinality {
  if (input.confirmationDepth <= 0n) {
    throw new InvalidConfirmationDepthError(input.confirmationDepth);
  }
  if (input.removed === true) {
    return 'reorg';
  }
  if (input.blockNumber === null) {
    return 'pending';
  }
  return isFinal(input.blockNumber, input.headBlockNumber, input.confirmationDepth)
    ? 'final'
    : 'pending';
}

/**
 * The per-event cadence decision: should reconciliation run for this event? `final` events trigger
 * the normal per-event reconcile; `reorg` events trigger a re-derivation reconcile (both correct the
 * ledger toward the current authoritative chain state). `pending` events are not yet actionable.
 */
export function shouldReconcileOnEvent(input: ChainEventFinalityInput): boolean {
  const finality = classifyChainEventFinality(input);
  return finality === 'final' || finality === 'reorg';
}
