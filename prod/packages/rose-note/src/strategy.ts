// Paper/testnet coupled-pair strategy execution — the FR-20 execution layer (Story 6.4). The
// architecture places paper execution in `@rose/rose-note` alongside subscription/redemption
// (architecture §Project Structure line 319; §Requirements-to-Structure line 357). This is the
// `StrategyExecutor` PORT — the clean interface seam (NFR-7) behind which the latency-sensitive
// executor can be re-implemented in Rust/Go post-P0 WITHOUT caller changes; `@rose/api` injects it.
//
// WHAT IT DOES (execution, not model validation):
//   • `onTick` — the THRESHOLD-ONLY trigger. A reset fires ONLY when a losing leg's (tick-supplied)
//     marked value breaches the floor `f = m·L·g`; it is NEVER triggered by elapsed time / an interval
//     / a scheduler (the addendum's "intrinsic time" — a clock would import leveraged-ETF volatility
//     decay, the trap to avoid). There is NO timer/clock/`Date` branch in the decision path. A
//     within-barrier tick is a strict no-op (no lifecycle transition, no on-chain call, no entry).
//   • On a breach it transitions `ACTIVE → REBALANCING` (after a fail-closed pre-write authorization
//     check, so a refusal leaves the pair ACTIVE) and drives the 5.4 paired-burn dual-write (SUBMITTED,
//     tx hash, NO ledger entry — no optimistic success).
//   • `confirmReset` — THE COMMIT POINT: at the confirmed on-chain `PairBurned` it posts ONE balanced
//     journal entry crystallizing the realized P&L tagged to `TRADING_CO` (D1/D1a — the losing holder
//     bears the loss, the gain is realized/withdrawable), re-bases the pair symmetrically (re-anchor
//     P₀, `V_A = V_B = K/2`, K conserved) and returns it to `ACTIVE`. Idempotent; never throws into the
//     (fire-and-forget) watcher.
//
// BOUNDARY (binding): the coupled-coin reference math + the historical-tick simulator are Epic 7
// (THROWAWAY) and are NOT reimplemented here — the marked leg values are OPAQUE tick inputs (paper:
// the simulated price source; live: a pricing feed/oracle, ops-deferred). All dependencies are
// INJECTED; this module opens no connection and holds no key. PAPER/LOCAL only — the burn runs through
// the injected `BurnPairDualWrite` (mock EIP-1193 in tests) and the confirmation is a synthetic
// `PairBurned`. NO secret, NO `.env`, NO real price feed.
import {
  applyCoupledPairReset,
  CoupledPairNotFoundError,
  findByIdempotencyKey,
  findByTxHash,
  getCoupledPair,
  transitionPair,
  type CoupledPairState,
  type OutboxEventRow,
  type RoseDb,
} from '@rose/ledger';
import { BurnPairDualWrite, type BurnAuthorizationGate, type PairBurnedEvent } from '@rose/chain';
import { assertNotFloat, splitInTwo } from '@rose/shared';
import { getAddress, type Address } from 'viem';
import {
  buildStrategyResetBurnPlan,
  deriveFloorUnits,
  InvalidStrategyResetError,
  type StrategyResetTopology,
} from './strategy-plan.js';
import { UnsupportedPaymentAssetError } from './subscribe.js';

/** A reset's lifecycle status, derived from the outbox `PAIR_BURN` row (pending → confirmed/failed). */
export type StrategyResetStatus = 'pending' | 'confirmed' | 'failed';

/** Whether a leg is the long or short side. */
export type LegSide = 'long' | 'short';

/**
 * A price tick fed to the executor. In paper the simulated price source supplies the marked leg values
 * (OPAQUE inputs — `/prod` never derives them from price; that model is Epic 7). `price` is used only
 * to re-anchor P₀ at a reset. All marks are integer `bigint` smallest-units (NFR-2).
 */
export interface StrategyTick {
  readonly pairId: string;
  /** The observed reference price (decimal string) — the re-anchor target at a reset. */
  readonly price: string;
  /** The current marked value of the long leg, smallest-units (paper-supplied input). */
  readonly longLegMarkValue: bigint;
  /** The current marked value of the short leg, smallest-units (paper-supplied input). */
  readonly shortLegMarkValue: bigint;
  /** The payment asset the reset crystallizes the P&L in (paper P0: the configured asset). */
  readonly paymentAsset: string;
  /** Idempotency key for this reset attempt — exactly-once reset (NFR-9). */
  readonly resetIdempotencyKey: string;
}

/** The outcome of feeding a tick: a strict no-op within the barrier, or a started reset on a breach. */
export interface StrategyTickOutcome {
  readonly pairId: string;
  readonly action: 'none' | 'reset-started';
  /** Human-facing reason (`within-barrier` | `floor-breach` | `not-active:<state>` | `idempotent-replay`). */
  readonly reason: string;
  readonly losingLeg: LegSide | null;
  /** The derived floor threshold in smallest-units (audit). */
  readonly floorUnits: bigint;
  /** The pair's lifecycle state after the tick. */
  readonly state: CoupledPairState;
  /** The reset's on-chain tx hash (present once the burn is submitted). */
  readonly txHash: string | null;
  /** The reset id (= the idempotency key) when a reset started. */
  readonly resetId: string | null;
}

/** A reset as seen by the surfaces: pending until the on-chain commit point, then confirmed. */
export interface StrategyResetView {
  /** The reset idempotency key — the stable reset handle. */
  readonly id: string;
  readonly pairId: string;
  readonly status: StrategyResetStatus;
  readonly txHash: string | null;
  readonly journalEntryId: string | null;
}

/** The strategy executor surface the API boundary calls (the injected NFR-7 port). */
export interface StrategyExecutor {
  /** Feed a tick: threshold-only. A breach starts a reset (pending); within-barrier is a strict no-op. */
  onTick(tick: StrategyTick): Promise<StrategyTickOutcome>;
  /** THE COMMIT POINT: confirm a `PairBurned` → post the balanced P&L entry + re-base once. */
  confirmReset(event: PairBurnedEvent): Promise<StrategyResetView | null>;
  /** Read a reset's pending/confirmed status (the "pending until commit point" read). */
  getReset(id: string): Promise<StrategyResetView | null>;
}

/**
 * Thrown when a `resetIdempotencyKey` is reused with a request that does NOT match the recorded intent
 * (a different pair or reset amount). Returning the original reset for a different request would
 * silently mask a distinct reset, so this is a fail-closed conflict. Maps to 409.
 */
export class StrategyResetIdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `Reset idempotency key '${idempotencyKey}' was already used for a DIFFERENT reset request ` +
        `(pair/amount mismatch). Use a fresh key for a new reset.`,
    );
    this.name = 'StrategyResetIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** Injected dependencies for the strategy executor. The executor opens no connection itself. */
export interface StrategyExecutorDeps {
  readonly db: RoseDb;
  /** The 5.4 paired-burn dual-write (built with the injected chain clients + seam account). */
  readonly burn: BurnPairDualWrite;
  /** The deployed `CoupledPair` address the reset burn targets. */
  readonly pairAddress: Address;
  /** The capital-flow authorization gate (the default-deny `postTransfer` decision), consulted pre-write. */
  readonly authorize: BurnAuthorizationGate;
  /** Caller-supplied account topology for the reset burn plan (incl. the `TRADING_CO` P&L accounts). */
  readonly topology: StrategyResetTopology;
  /** The payment asset the realized-P&L value postings are denominated in (paper P0, single asset). */
  readonly paymentAsset: string;
  /** The position holder whose paired legs are RETIRED at the reset (paper). */
  readonly positionHolder: Address;
  /**
   * The parked floor parameters, resolved by the composition root from `@rose/config` `loadConfig`
   * (which REFUSES-if-absent, `ConfigRefusalError` — the executor never defaults them, NFR-4).
   */
  readonly floor: { readonly modelFloorM: string; readonly modelFloorG: string };
}

/**
 * Builds the strategy executor (the injected NFR-7 port the API calls). Composes the existing seams —
 * capital-flow authorization, the 5.4 paired-burn dual-write, the lifecycle transitions, the parked
 * floor config, the ledger reads — into the FR-20 threshold-only reset loop. Authors no new primitive
 * beyond the additive `applyCoupledPairReset`. Does NOT reimplement the Epic-7 coupled-coin model.
 */
export function makeStrategyExecutor(deps: StrategyExecutorDeps): StrategyExecutor {
  const planDescription = 'Coupled-pair strategy reset — paired burn + TRADING_CO P&L (Story 6.4)';

  // The re-anchor price for a pending reset, captured at onTick and consumed at the commit point. In
  // a single-process paper executor this is sufficient; durable carry of the reset context (so the
  // live `watchPairEvents → confirmReset` cadence survives a restart) is ops-deferred with the live
  // wiring. If absent at confirm, the leg re-base still applies (K-only) and the anchor is unchanged.
  const pendingAnchors = new Map<string, string>();

  function statusOf(outboxStatus: OutboxEventRow['status']): StrategyResetStatus {
    if (outboxStatus === 'CONFIRMED') return 'confirmed';
    if (outboxStatus === 'FAILED' || outboxStatus === 'COMPENSATED') return 'failed';
    return 'pending';
  }

  /**
   * Build a `StrategyResetView` from an outbox row, or `null` when the row is NOT a paired burn (a
   * different `operationKind`, e.g. a `PAIR_MINT` subscription, or a payload missing the burn fields).
   * (A redemption is also a `PAIR_BURN`; distinguishing reset-vs-redemption burns by a richer typed
   * model is deferred to 6.6 — the reset-key namespace is the caller's responsibility.)
   */
  function viewFromRow(row: OutboxEventRow): StrategyResetView | null {
    if (row.operationKind !== 'PAIR_BURN') {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const coupledPairId = payload.coupledPairId;
    const amount = payload.amount;
    if (typeof coupledPairId !== 'string' || typeof amount !== 'string') {
      return null;
    }
    return {
      id: row.idempotencyKey,
      pairId: coupledPairId,
      status: statusOf(row.status),
      txHash: row.txHash,
      journalEntryId: row.journalEntryId,
    };
  }

  return Object.freeze({
    async onTick(tick: StrategyTick): Promise<StrategyTickOutcome> {
      // Paper P0 supports the single configured payment asset.
      if (tick.paymentAsset !== deps.paymentAsset) {
        throw new UnsupportedPaymentAssetError(tick.paymentAsset, deps.paymentAsset);
      }
      // Marks must be non-negative integer smallest-units (NFR-2 — never a binary float).
      for (const [label, v] of [
        ['longLegMarkValue', tick.longLegMarkValue],
        ['shortLegMarkValue', tick.shortLegMarkValue],
      ] as const) {
        try {
          assertNotFloat(v);
        } catch {
          throw new InvalidStrategyResetError(
            `${label} must be a bigint in smallest units (NFR-2).`,
          );
        }
        if (typeof v !== 'bigint' || v < 0n) {
          throw new InvalidStrategyResetError(`${label} must be a non-negative integer.`);
        }
      }
      // Validate the re-anchor `price` UP-FRONT against the anchor column's frozen type (positive
      // decimal, ≤8 fractional digits) — BEFORE any irreversible burn — so the commit-point re-base
      // (`applyCoupledPairReset`) can never throw on it AFTER the burn has posted and strand the pair
      // in REBALANCING (code-review High, Blind/Edge Hunters). Refusing here leaves the pair ACTIVE.
      const priceFrac = tick.price.includes('.') ? tick.price.split('.')[1]!.length : 0;
      if (!/^\d+(\.\d+)?$/.test(tick.price) || /^0+(\.0+)?$/.test(tick.price) || priceFrac > 8) {
        throw new InvalidStrategyResetError(
          `price '${tick.price}' must be a positive decimal with at most 8 fractional digits (NFR-2).`,
        );
      }

      const pair = await getCoupledPair(deps.db, tick.pairId);
      if (pair === null) {
        // Reuse the ledger's typed not-found (maps to 404 at the API).
        throw new CoupledPairNotFoundError(tick.pairId);
      }

      // Threshold derivation from the PARKED floor params + the per-pair leverage (never hard-coded).
      const floorUnits = deriveFloorUnits(
        pair.collateralPool,
        pair.leverage,
        deps.floor.modelFloorM,
        deps.floor.modelFloorG,
      );
      const halfK = pair.collateralPool / 2n;

      // Threshold-only breach: a leg whose marked value is at/below the floor AND below its half-pool
      // anchor (so the crystallized loss is positive). NO time/clock input — purely event-driven.
      const longBreached = tick.longLegMarkValue <= floorUnits && tick.longLegMarkValue < halfK;
      const shortBreached = tick.shortLegMarkValue <= floorUnits && tick.shortLegMarkValue < halfK;
      let losingLeg: LegSide | null = null;
      if (longBreached && shortBreached) {
        losingLeg = tick.longLegMarkValue <= tick.shortLegMarkValue ? 'long' : 'short';
      } else if (longBreached) {
        losingLeg = 'long';
      } else if (shortBreached) {
        losingLeg = 'short';
      }

      const noop = (reason: string): StrategyTickOutcome => ({
        pairId: pair.id,
        action: 'none',
        reason,
        losingLeg,
        floorUnits,
        state: pair.state,
        txHash: null,
        resetId: null,
      });

      if (losingLeg === null) {
        // Strict no-op — within the barrier. Nothing written (the never-clock guarantee).
        return noop('within-barrier');
      }

      const losingMark = losingLeg === 'long' ? tick.longLegMarkValue : tick.shortLegMarkValue;
      const resetDelta = halfK - losingMark; // the crystallized loss (positive — losingMark < halfK)

      // Idempotency (NFR-9): a recorded reset for this key returns the existing reset (no re-broadcast,
      // no re-transition); a key reused for a DIFFERENT request fails closed.
      const existing = await findByIdempotencyKey(deps.db, tick.resetIdempotencyKey);
      if (existing !== null && existing.operationKind === 'PAIR_BURN') {
        const recorded = existing.payload as Record<string, unknown>;
        if (recorded.coupledPairId !== pair.id || recorded.amount !== resetDelta.toString()) {
          throw new StrategyResetIdempotencyConflictError(tick.resetIdempotencyKey);
        }
        // A terminally FAILED/COMPENSATED reset is reported truthfully (not a misleading
        // `reset-started` with a null tx hash) — the surface reads `getReset` for the failed status
        // and a fresh key re-drives the reset (code-review Med, Edge Hunter).
        if (statusOf(existing.status) === 'failed') {
          return {
            pairId: pair.id,
            action: 'none',
            reason: `reset-failed:${existing.status}`,
            losingLeg,
            floorUnits,
            state: pair.state,
            txHash: existing.txHash,
            resetId: tick.resetIdempotencyKey,
          };
        }
        return {
          pairId: pair.id,
          action: 'reset-started',
          reason: 'idempotent-replay',
          losingLeg,
          floorUnits,
          state: pair.state,
          txHash: existing.txHash,
          resetId: tick.resetIdempotencyKey,
        };
      }

      // A reset already in flight (pair not ACTIVE) is not re-triggered — no clock-based re-firing.
      if (pair.state !== 'ACTIVE') {
        return noop(`not-active:${pair.state}`);
      }

      // Submit the paired burn FIRST: the 5.4 dual-write runs the SAME fail-closed default-deny gate
      // PRE-submit and throws `BurnAuthorizationError` before recording — so a refusal OR a submit
      // failure leaves the pair ACTIVE (never a dangling REBALANCING). Only AFTER a successful submit
      // do we enter the rebalance window (commit point remains the confirmed `PairBurned` — no
      // optimistic success). Ordering hardened per code review (Blind/Edge Hunters).
      const holder = getAddress(deps.positionHolder) as Address;
      const result = await deps.burn.start({
        idempotencyKey: tick.resetIdempotencyKey,
        coupledPairId: pair.id,
        pairAddress: deps.pairAddress,
        lFrom: holder,
        sFrom: holder,
        amount: resetDelta,
        authorize: deps.authorize,
      });
      await transitionPair(deps.db, pair.id, 'REBALANCING');
      pendingAnchors.set(tick.resetIdempotencyKey, tick.price);

      console.info(
        '[strategy] floor breach — reset submitted, pending until on-chain commit point',
        {
          pairId: pair.id,
          losingLeg,
          floorUnits: floorUnits.toString(),
          resetDelta: resetDelta.toString(),
          idempotencyKey: tick.resetIdempotencyKey,
          txHash: result.txHash,
        },
      );

      return {
        pairId: pair.id,
        action: 'reset-started',
        reason: 'floor-breach',
        losingLeg,
        floorUnits,
        state: 'REBALANCING',
        txHash: result.outbox.txHash,
        resetId: tick.resetIdempotencyKey,
      };
    },

    async confirmReset(event: PairBurnedEvent): Promise<StrategyResetView | null> {
      // The COMMIT POINT must NEVER throw into the (fire-and-forget) watcher (mirror 6.2/6.3 confirm).
      try {
        if (event.transactionHash === null) {
          return null;
        }
        const row = await findByTxHash(deps.db, event.transactionHash);
        if (row === null || row.operationKind !== 'PAIR_BURN') {
          return null;
        }
        const payload = row.payload as Record<string, unknown>;
        const coupledPairId = payload.coupledPairId;
        if (typeof coupledPairId !== 'string') {
          return null;
        }

        const plan = buildStrategyResetBurnPlan({
          description: planDescription,
          amount: event.args.amount,
          topology: deps.topology,
        });
        const outcome = await deps.burn.confirmFromBurnedEvent(event, plan);

        // Re-base + return to ACTIVE whenever the burn is CONFIRMED and the pair is still REBALANCING.
        // Running on a re-delivery (`noop`) too — not just the first `applied` — makes recovery
        // idempotent: if a prior confirm posted the burn but failed to complete the re-base, a later
        // delivery finishes it instead of stranding the pair forever (code-review High, Edge Hunter).
        // An `anomaly` (divergence/zero) leaves the row SUBMITTED, so this block is skipped.
        if (outcome.status === 'applied' || outcome.status === 'noop') {
          const pair = await getCoupledPair(deps.db, coupledPairId);
          if (pair !== null && pair.state === 'REBALANCING') {
            const [vA, vB] = splitInTwo(pair.collateralPool);
            const newAnchor = pendingAnchors.get(row.idempotencyKey) ?? pair.anchorPrice;
            await applyCoupledPairReset(deps.db, {
              pairId: coupledPairId,
              newAnchorPrice: newAnchor,
              newLongLegValue: vA,
              newShortLegValue: vB,
            });
            await transitionPair(deps.db, coupledPairId, 'ACTIVE');
            pendingAnchors.delete(row.idempotencyKey);
            console.info(
              '[strategy] reset committed — P&L crystallized to TRADING_CO, pair re-based',
              {
                pairId: coupledPairId,
                newAnchorPrice: newAnchor,
                idempotencyKey: row.idempotencyKey,
                txHash: event.transactionHash,
              },
            );
          }
        }

        const after = await findByTxHash(deps.db, event.transactionHash);
        return after === null ? null : viewFromRow(after);
      } catch (error) {
        console.warn('[strategy] confirmReset anomaly — left for reconcile (5.6), nothing thrown', {
          txHash: event.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async getReset(id: string): Promise<StrategyResetView | null> {
      const row = await findByIdempotencyKey(deps.db, id);
      return row === null ? null : viewFromRow(row);
    },
  });
}
