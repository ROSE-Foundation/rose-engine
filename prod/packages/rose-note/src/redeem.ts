// Live (paper/local) redemption of a Rose Note — the FR-11 composition layer (Story 6.3), the INVERSE
// mirror of the 6.2 subscription against the 5.4 paired burn. This is the `api → rose-note → chain →
// ledger → reconcile` data flow (architecture §Data Flow line 365): a holder redeems (buys back) a
// pre-existing Rose Note → capital-flow authorization (FR-7, default-deny) is checked BEFORE any write
// → the paired ERC-3643 burn (5.4) is submitted (PENDING/SUBMITTED, NO ledger entry — no optimistic
// success) → at the on-chain commit point (the confirmed `PairBurned`, synthetic in paper) ONE
// balanced journal entry is posted, RETIRING the token quantity and EXTINGUISHING `NOTE_LIABILITY`,
// with the recorded quantity == the on-chain amount (D3/NFR-9).
//
// Unlike the subscription, a redemption does NOT consult FR-19 eligibility: eligibility gates token
// RECEIPT (subscription); a redemption RETIRES the holder's tokens and pays cash back, so the
// chokepoint authorization is the gate that applies. The redemption does NOT close the note row or
// re-open the Epic-2 issuance contract: it retires the holder's position against the existing pair.
// Redemption state (pending → confirmed) is DERIVED from the outbox `PAIR_BURN` row (no new table).
//
// All dependencies are INJECTED; this module opens no connection and holds no key. PAPER/LOCAL only:
// the on-chain burn runs through the injected `BurnPairDualWrite` (mock EIP-1193 in tests) and the
// confirmation is a synthetic `PairBurned` event. NO secret, NO `.env`.
import { eq } from 'drizzle-orm';
import {
  getCoupledPair,
  getRoseNote,
  findByIdempotencyKey,
  findByTxHash,
  roseNotes,
  type OutboxEventRow,
  type RoseDb,
} from '@rose/ledger';
import { BurnPairDualWrite, type BurnAuthorizationGate, type PairBurnedEvent } from '@rose/chain';
import { getAddress, type Address } from 'viem';
import { buildRedemptionBurnPlan, type RedemptionAccountTopology } from './redemption-plan.js';
import { RoseNoteNotFoundError, UnsupportedPaymentAssetError } from './subscribe.js';

/**
 * A redemption's lifecycle status, derived from the outbox row: `pending` until the on-chain commit
 * point, `confirmed` once the balanced entry is posted (the position closes), `failed` if the
 * dual-write was marked FAILED/COMPENSATED — a terminal failure is never masked as "still pending".
 */
export type RedemptionStatus = 'pending' | 'confirmed' | 'failed';

/** A redemption as seen by the surfaces: pending until the on-chain commit point, then confirmed. */
export interface RedemptionView {
  /** The idempotency key — the stable redemption handle. */
  readonly id: string;
  readonly roseNoteId: string;
  readonly coupledPairId: string;
  /** The redeemer's EVM address (holds and retires BOTH legs of the paired position). */
  readonly redeemer: string;
  /** Retired token quantity / cash smallest-units (1:1 paper), as `bigint` (NFR-2). */
  readonly amount: bigint;
  readonly paymentAsset: string;
  readonly status: RedemptionStatus;
  /** The on-chain tx hash (present once submitted). */
  readonly txHash: string | null;
  /** The posted journal entry id (present once confirmed at the commit point). */
  readonly journalEntryId: string | null;
}

/** A redeem request (the API boundary validates + maps money to/from strings). */
export interface RedeemInput {
  readonly roseNoteId: string;
  /** The redeemer's EVM address (holds BOTH legs of the paired position being retired). */
  readonly redeemer: string;
  /** Redemption amount in smallest units (the retired token quantity AND the cash value, 1:1 paper). */
  readonly amount: bigint;
  /** The payment asset (fiat or crypto). In paper P0 it MUST equal the service's configured asset. */
  readonly paymentAsset: string;
  /** Idempotency key for the dual-write — exactly-once redemption (NFR-9). */
  readonly idempotencyKey: string;
}

/** The redemption service surface the API boundary calls (injected port). */
export interface RedemptionService {
  /** Redeem: authorization (pre-write) → submit the paired burn → PENDING (no entry). */
  redeem(input: RedeemInput): Promise<RedemptionView>;
  /** The COMMIT POINT: confirm a `PairBurned` → post the balanced entry once. Null if no matching row. */
  confirm(event: PairBurnedEvent): Promise<RedemptionView | null>;
  /** Read a redemption's pending/confirmed status (the "pending until commit point" read). */
  getRedemption(id: string): Promise<RedemptionView | null>;
}

/** Thrown when the note's embedded pair is not ACTIVE (cannot redeem a non-live pair). Maps to 409. */
export class RedemptionPairNotActiveError extends Error {
  readonly coupledPairId: string;
  readonly state: string;
  constructor(coupledPairId: string, state: string) {
    super(`Cannot redeem: coupled pair '${coupledPairId}' is '${state}', not ACTIVE.`);
    this.name = 'RedemptionPairNotActiveError';
    this.coupledPairId = coupledPairId;
    this.state = state;
  }
}

/**
 * Thrown when an `idempotencyKey` is reused with a request that does NOT match the recorded intent
 * (a different note/pair, redeemer, or amount). Returning the original position for a different
 * request would silently hand the caller someone else's redemption, so this is a fail-closed conflict.
 * Maps to 409.
 */
export class RedemptionIdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used for a DIFFERENT redemption request ` +
        `(note/redeemer/amount mismatch). Use a fresh key for a new redemption.`,
    );
    this.name = 'RedemptionIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** Injected dependencies for the redemption service. The service opens no connection itself. */
export interface RedemptionServiceDeps {
  readonly db: RoseDb;
  /** The 5.4 paired-burn dual-write (built with the injected chain clients + seam account). */
  readonly burn: BurnPairDualWrite;
  /** The deployed `CoupledPair` address the burn targets. */
  readonly pairAddress: Address;
  /** The capital-flow authorization gate (the default-deny `postTransfer` decision), consulted pre-submit. */
  readonly authorize: BurnAuthorizationGate;
  /** Caller-supplied account topology for the redemption burn plan (incl. `NOTE_LIABILITY`). */
  readonly topology: RedemptionAccountTopology;
  /** The payment asset the cash/`NOTE_LIABILITY` accounts are denominated in (paper P0, single asset). */
  readonly paymentAsset: string;
}

/**
 * Builds the redemption service (the injected port the API boundary calls). Composes the existing
 * seams — capital-flow authorization, the 5.4 paired-burn dual-write, the ledger reads — into the
 * FR-11 redeem → burn → commit → balanced-entry loop. Authors no new primitive; the INVERSE mirror of
 * `makeSubscriptionService`.
 */
export function makeRedemptionService(deps: RedemptionServiceDeps): RedemptionService {
  const planDescription = 'Rose Note redemption — paired burn (Story 6.3)';

  /** Resolve the embedding note id for a coupled pair (1:1 embedding) for the view. */
  async function roseNoteIdForPair(coupledPairId: string): Promise<string | null> {
    const note = await deps.db.query.roseNotes.findFirst({
      where: eq(roseNotes.coupledPairId, coupledPairId),
    });
    return note?.id ?? null;
  }

  /** Map an outbox status to the redemption lifecycle status (terminal failures never read pending). */
  function statusOf(outboxStatus: OutboxEventRow['status']): RedemptionStatus {
    if (outboxStatus === 'CONFIRMED') return 'confirmed';
    if (outboxStatus === 'FAILED' || outboxStatus === 'COMPENSATED') return 'failed';
    return 'pending';
  }

  /**
   * Build a `RedemptionView` from an outbox row, or `null` when the row is NOT a redemption burn
   * (a different `operationKind`, e.g. a `PAIR_MINT` subscription, or a payload missing the burn
   * fields). This keeps a mint/other idempotency key from being read as a malformed redemption (the
   * shared outbox table holds every dual-write).
   */
  async function viewFromRow(row: OutboxEventRow): Promise<RedemptionView | null> {
    if (row.operationKind !== 'PAIR_BURN') {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const coupledPairId = payload.coupledPairId;
    const redeemer = payload.lFrom;
    const amount = payload.amount;
    if (
      typeof coupledPairId !== 'string' ||
      typeof redeemer !== 'string' ||
      typeof amount !== 'string'
    ) {
      return null;
    }
    const roseNoteId = await roseNoteIdForPair(coupledPairId);
    return {
      id: row.idempotencyKey,
      roseNoteId: roseNoteId ?? '',
      coupledPairId,
      redeemer,
      amount: BigInt(amount),
      paymentAsset: deps.paymentAsset,
      status: statusOf(row.status),
      txHash: row.txHash,
      journalEntryId: row.journalEntryId,
    };
  }

  return Object.freeze({
    async redeem(input: RedeemInput): Promise<RedemptionView> {
      // Paper P0 supports the single configured payment asset (fiat OR crypto, the topology's asset).
      if (input.paymentAsset !== deps.paymentAsset) {
        throw new UnsupportedPaymentAssetError(input.paymentAsset, deps.paymentAsset);
      }

      // 1. Resolve the pre-existing note → its embedded coupled pair.
      const note = await getRoseNote(deps.db, input.roseNoteId);
      if (note === null) {
        throw new RoseNoteNotFoundError(input.roseNoteId);
      }
      const pair = await getCoupledPair(deps.db, note.coupledPairId);
      if (pair === null) {
        throw new RoseNoteNotFoundError(input.roseNoteId);
      }
      // 2. The pair must be live to redeem (documented P0 interpretation).
      if (pair.state !== 'ACTIVE') {
        throw new RedemptionPairNotActiveError(pair.id, pair.state);
      }

      const redeemerAddress = getAddress(input.redeemer) as Address;

      // 3. Drive the paired-burn dual-write: authorize (pre-submit, fail-closed) → submit → SUBMITTED.
      //    NO ledger entry here — the commit point is the confirmed PairBurned (no optimistic success).
      //    (Redemption applies only the capital-flow chokepoint authorization; FR-19 recipient
      //    eligibility gates token RECEIPT, not a burn.)
      const result = await deps.burn.start({
        idempotencyKey: input.idempotencyKey,
        coupledPairId: pair.id,
        pairAddress: deps.pairAddress,
        lFrom: redeemerAddress,
        sFrom: redeemerAddress,
        amount: input.amount,
        authorize: deps.authorize,
      });

      // Idempotency conflict (NFR-9): a reused key returns the EXISTING intent (the new payload is
      // discarded by the outbox `onConflictDoNothing`). Fail closed if the reused key's request does
      // NOT match the recorded intent — never hand the caller a DIFFERENT redeemer's position.
      if (result.alreadyStarted) {
        const recorded = result.outbox.payload as Record<string, unknown>;
        if (
          recorded.coupledPairId !== pair.id ||
          recorded.lFrom !== redeemerAddress ||
          recorded.amount !== input.amount.toString()
        ) {
          throw new RedemptionIdempotencyConflictError(input.idempotencyKey);
        }
      }

      console.info('[redemption] paired burn submitted — pending until on-chain commit point', {
        roseNoteId: input.roseNoteId,
        coupledPairId: pair.id,
        redeemer: redeemerAddress,
        idempotencyKey: input.idempotencyKey,
        txHash: result.txHash,
        alreadyStarted: result.alreadyStarted,
      });

      // Build the view from in-scope data + the outbox row's status (the note id is known here).
      return {
        id: input.idempotencyKey,
        roseNoteId: input.roseNoteId,
        coupledPairId: pair.id,
        redeemer: redeemerAddress,
        amount: input.amount,
        paymentAsset: deps.paymentAsset,
        status: statusOf(result.outbox.status),
        txHash: result.outbox.txHash,
        journalEntryId: result.outbox.journalEntryId,
      };
    },

    async confirm(event: PairBurnedEvent): Promise<RedemptionView | null> {
      // The COMMIT POINT must NEVER throw into the (fire-and-forget) watcher — mirror the 5.4
      // `confirmFromBurnedEvent` contract: a malformed event (e.g. a non-positive on-chain amount that
      // makes the plan build throw) is caught, logged, and surfaced as null (the row is left for
      // reconcile 5.6). `confirmFromBurnedEvent` itself already swallows divergence/plan anomalies.
      try {
        if (event.transactionHash === null) {
          return null;
        }
        const plan = buildRedemptionBurnPlan({
          description: planDescription,
          amount: event.args.amount,
          topology: deps.topology,
        });
        await deps.burn.confirmFromBurnedEvent(event, plan);
        const row = await findByTxHash(deps.db, event.transactionHash);
        return row === null ? null : viewFromRow(row);
      } catch (error) {
        console.warn('[redemption] confirm anomaly — left for reconcile (5.6), nothing thrown', {
          txHash: event.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async getRedemption(id: string): Promise<RedemptionView | null> {
      const row = await findByIdempotencyKey(deps.db, id);
      return row === null ? null : viewFromRow(row);
    },
  });
}
