// Live (paper/local) subscription to a Rose Note — the FR-11 composition layer (Story 6.2). This is
// the `api → rose-note → chain → ledger → reconcile` data flow (architecture §Data Flow line 365):
// an eligible Subscriber subscribes to a pre-existing Rose Note → eligibility (FR-19) + capital-flow
// authorization (FR-7, default-deny) are checked BEFORE any write → the paired ERC-3643 mint (5.3)
// is submitted (PENDING/SUBMITTED, NO ledger entry — no optimistic success) → at the on-chain commit
// point (the confirmed `PairMinted`, synthetic in paper) ONE balanced journal entry is posted,
// touching `NOTE_LIABILITY`, with the recorded quantity == the on-chain amount (D3/NFR-9).
//
// The subscription does NOT create the note or re-open the Epic-2 issuance contract: the note + its
// delta-neutral coupled pair pre-exist; the subscription mints L/S to the subscriber against them.
// Subscription state (pending → confirmed) is DERIVED from the outbox row (no new table).
//
// All dependencies are INJECTED; this module opens no connection and holds no key. PAPER/LOCAL only:
// the on-chain mint runs through the injected chain clients (mock EIP-1193 in tests) and the
// confirmation is a synthetic `PairMinted` event. NO secret, NO `.env`.
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
import { MintPairDualWrite, type MintAuthorizationGate, type PairMintedEvent } from '@rose/chain';
import { getAddress, type Address } from 'viem';
import { IneligibleSubscriberError, type EligibilityProvider } from './eligibility.js';
import {
  buildSubscriptionMintPlan,
  type SubscriptionAccountTopology,
} from './subscription-plan.js';

/**
 * A subscription's lifecycle status, derived from the outbox row: `pending` until the on-chain
 * commit point, `confirmed` once the balanced entry is posted, `failed` if the dual-write was marked
 * FAILED/COMPENSATED — a terminal failure is never masked as "still pending".
 */
export type SubscriptionStatus = 'pending' | 'confirmed' | 'failed';

/** A subscription as seen by the surfaces: pending until the on-chain commit point, then confirmed. */
export interface SubscriptionView {
  /** The idempotency key — the stable subscription handle. */
  readonly id: string;
  readonly roseNoteId: string;
  readonly coupledPairId: string;
  readonly subscriber: string;
  /** Minted token quantity / cash smallest-units (1:1 paper), as `bigint` (NFR-2). */
  readonly amount: bigint;
  readonly paymentAsset: string;
  readonly status: SubscriptionStatus;
  /** The on-chain tx hash (present once submitted). */
  readonly txHash: string | null;
  /** The posted journal entry id (present once confirmed at the commit point). */
  readonly journalEntryId: string | null;
}

/** A subscribe request (the API boundary validates + maps money to/from strings). */
export interface SubscribeInput {
  readonly roseNoteId: string;
  /** The subscriber's EVM address (receives BOTH legs of the paired position). */
  readonly subscriber: string;
  /** Subscription amount in smallest units (the minted token quantity AND the cash value, 1:1 paper). */
  readonly amount: bigint;
  /** The payment asset (fiat or crypto). In paper P0 it MUST equal the service's configured asset. */
  readonly paymentAsset: string;
  /** Idempotency key for the dual-write — exactly-once subscription (NFR-9). */
  readonly idempotencyKey: string;
}

/** The subscription service surface the API boundary calls (injected port). */
export interface SubscriptionService {
  /** Subscribe: eligibility + authorization (pre-write) → submit the paired mint → PENDING (no entry). */
  subscribe(input: SubscribeInput): Promise<SubscriptionView>;
  /** The COMMIT POINT: confirm a `PairMinted` → post the balanced entry once. Null if no matching row. */
  confirm(event: PairMintedEvent): Promise<SubscriptionView | null>;
  /** Read a subscription's pending/confirmed status (the "pending until commit point" read). */
  getSubscription(id: string): Promise<SubscriptionView | null>;
}

/** Thrown when the referenced Rose Note (or its embedded pair) does not exist. Maps to 404. */
export class RoseNoteNotFoundError extends Error {
  readonly roseNoteId: string;
  constructor(roseNoteId: string) {
    super(`Rose Note '${roseNoteId}' not found.`);
    this.name = 'RoseNoteNotFoundError';
    this.roseNoteId = roseNoteId;
  }
}

/** Thrown when the note's embedded pair is not ACTIVE (cannot subscribe to a non-live pair). Maps to 409. */
export class SubscriptionPairNotActiveError extends Error {
  readonly coupledPairId: string;
  readonly state: string;
  constructor(coupledPairId: string, state: string) {
    super(`Cannot subscribe: coupled pair '${coupledPairId}' is '${state}', not ACTIVE.`);
    this.name = 'SubscriptionPairNotActiveError';
    this.coupledPairId = coupledPairId;
    this.state = state;
  }
}

/**
 * Thrown when an `idempotencyKey` is reused with a request that does NOT match the recorded intent
 * (a different note/pair, subscriber, or amount). Returning the original position for a different
 * request would silently hand the caller someone else's subscription, so this is a fail-closed
 * conflict. Maps to 409.
 */
export class SubscriptionIdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used for a DIFFERENT subscription request ` +
        `(note/subscriber/amount mismatch). Use a fresh key for a new subscription.`,
    );
    this.name = 'SubscriptionIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** Thrown when the requested payment asset is not the service's configured paper asset. Maps to 422. */
export class UnsupportedPaymentAssetError extends Error {
  readonly requested: string;
  readonly supported: string;
  constructor(requested: string, supported: string) {
    super(`Payment asset '${requested}' is not supported (paper mode supports '${supported}').`);
    this.name = 'UnsupportedPaymentAssetError';
    this.requested = requested;
    this.supported = supported;
  }
}

/** Injected dependencies for the subscription service. The service opens no connection itself. */
export interface SubscriptionServiceDeps {
  readonly db: RoseDb;
  /** The 5.3 paired-mint dual-write (built with the injected chain clients + seam account). */
  readonly mint: MintPairDualWrite;
  /** The deployed `CoupledPair` address the mint targets. */
  readonly pairAddress: Address;
  /** The eligibility seam (the ONCHAINID-claim allowlist analogue) — consulted before any write. */
  readonly eligibility: EligibilityProvider;
  /** The capital-flow authorization gate (the default-deny `postTransfer` decision), consulted pre-submit. */
  readonly authorize: MintAuthorizationGate;
  /** Caller-supplied account topology for the subscription mint plan (incl. `NOTE_LIABILITY`). */
  readonly topology: SubscriptionAccountTopology;
  /** The payment asset the cash/`NOTE_LIABILITY` accounts are denominated in (paper P0, single asset). */
  readonly paymentAsset: string;
}

/**
 * Builds the subscription service (the injected port the API boundary calls). Composes the existing
 * seams — eligibility, capital-flow authorization, the 5.3 paired-mint dual-write, the ledger reads —
 * into the FR-11 subscribe → mint → commit → balanced-entry loop. Authors no new primitive.
 */
export function makeSubscriptionService(deps: SubscriptionServiceDeps): SubscriptionService {
  const planDescription = 'Rose Note subscription — paired mint (Story 6.2)';

  /** Resolve the embedding note id for a coupled pair (1:1 embedding) for the view. */
  async function roseNoteIdForPair(coupledPairId: string): Promise<string | null> {
    const note = await deps.db.query.roseNotes.findFirst({
      where: eq(roseNotes.coupledPairId, coupledPairId),
    });
    return note?.id ?? null;
  }

  /** Map an outbox status to the subscription lifecycle status (terminal failures never read pending). */
  function statusOf(outboxStatus: OutboxEventRow['status']): SubscriptionStatus {
    if (outboxStatus === 'CONFIRMED') return 'confirmed';
    if (outboxStatus === 'FAILED' || outboxStatus === 'COMPENSATED') return 'failed';
    return 'pending';
  }

  /**
   * Build a `SubscriptionView` from an outbox row, or `null` when the row is NOT a subscription mint
   * (a different `operationKind`, e.g. a `PAIR_BURN`, or a payload missing the subscription fields).
   * This keeps a burn/other idempotency key from being read as a malformed subscription (the shared
   * outbox table holds every dual-write).
   */
  async function viewFromRow(row: OutboxEventRow): Promise<SubscriptionView | null> {
    if (row.operationKind !== 'PAIR_MINT') {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const coupledPairId = payload.coupledPairId;
    const subscriber = payload.lTo;
    const amount = payload.amount;
    if (
      typeof coupledPairId !== 'string' ||
      typeof subscriber !== 'string' ||
      typeof amount !== 'string'
    ) {
      return null;
    }
    const roseNoteId = await roseNoteIdForPair(coupledPairId);
    return {
      id: row.idempotencyKey,
      roseNoteId: roseNoteId ?? '',
      coupledPairId,
      subscriber,
      amount: BigInt(amount),
      paymentAsset: deps.paymentAsset,
      status: statusOf(row.status),
      txHash: row.txHash,
      journalEntryId: row.journalEntryId,
    };
  }

  return Object.freeze({
    async subscribe(input: SubscribeInput): Promise<SubscriptionView> {
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
      // 2. The pair must be live to subscribe (documented P0 interpretation).
      if (pair.state !== 'ACTIVE') {
        throw new SubscriptionPairNotActiveError(pair.id, pair.state);
      }

      // 3. Eligibility (FR-19) — fail-closed BEFORE any write (no self-service KYC; named reason).
      const decision = deps.eligibility.checkEligibility(input.subscriber);
      if (!decision.eligible) {
        console.warn('[subscription] eligibility refused — nothing written (fail-closed)', {
          roseNoteId: input.roseNoteId,
          subscriber: input.subscriber,
          reason: decision.reason,
        });
        throw new IneligibleSubscriberError(input.subscriber, decision.reason);
      }
      const subscriberAddress = getAddress(input.subscriber) as Address;

      // 4. Drive the paired-mint dual-write: authorize (pre-submit, fail-closed) → submit → SUBMITTED.
      //    NO ledger entry here — the commit point is the confirmed PairMinted (no optimistic success).
      const result = await deps.mint.start({
        idempotencyKey: input.idempotencyKey,
        coupledPairId: pair.id,
        pairAddress: deps.pairAddress,
        lTo: subscriberAddress,
        sTo: subscriberAddress,
        amount: input.amount,
        authorize: deps.authorize,
      });

      // Idempotency conflict (NFR-9): a reused key returns the EXISTING intent (the new payload is
      // discarded by the outbox `onConflictDoNothing`). Fail closed if the reused key's request does
      // NOT match the recorded intent — never hand the caller a DIFFERENT subscriber's position.
      if (result.alreadyStarted) {
        const recorded = result.outbox.payload as Record<string, unknown>;
        if (
          recorded.coupledPairId !== pair.id ||
          recorded.lTo !== subscriberAddress ||
          recorded.amount !== input.amount.toString()
        ) {
          throw new SubscriptionIdempotencyConflictError(input.idempotencyKey);
        }
      }

      console.info('[subscription] paired mint submitted — pending until on-chain commit point', {
        roseNoteId: input.roseNoteId,
        coupledPairId: pair.id,
        subscriber: subscriberAddress,
        idempotencyKey: input.idempotencyKey,
        txHash: result.txHash,
        alreadyStarted: result.alreadyStarted,
      });

      // Build the view from in-scope data + the outbox row's status (the note id is known here).
      return {
        id: input.idempotencyKey,
        roseNoteId: input.roseNoteId,
        coupledPairId: pair.id,
        subscriber: subscriberAddress,
        amount: input.amount,
        paymentAsset: deps.paymentAsset,
        status: statusOf(result.outbox.status),
        txHash: result.outbox.txHash,
        journalEntryId: result.outbox.journalEntryId,
      };
    },

    async confirm(event: PairMintedEvent): Promise<SubscriptionView | null> {
      // The COMMIT POINT must NEVER throw into the (fire-and-forget) watcher — mirror the 5.3
      // `confirmFromMintedEvent` contract: a malformed event (e.g. a non-positive on-chain amount that
      // makes the plan build throw) is caught, logged, and surfaced as null (the row is left for
      // reconcile 5.6). `confirmFromMintedEvent` itself already swallows divergence/plan anomalies.
      try {
        if (event.transactionHash === null) {
          return null;
        }
        const plan = buildSubscriptionMintPlan({
          description: planDescription,
          amount: event.args.amount,
          topology: deps.topology,
        });
        await deps.mint.confirmFromMintedEvent(event, plan);
        const row = await findByTxHash(deps.db, event.transactionHash);
        return row === null ? null : viewFromRow(row);
      } catch (error) {
        console.warn('[subscription] confirm anomaly — left for reconcile (5.6), nothing thrown', {
          txHash: event.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async getSubscription(id: string): Promise<SubscriptionView | null> {
      const row = await findByIdempotencyKey(deps.db, id);
      return row === null ? null : viewFromRow(row);
    },
  });
}
