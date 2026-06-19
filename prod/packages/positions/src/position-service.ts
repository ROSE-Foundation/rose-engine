// Position open/close over the atomic subscribe/redeem package flow (Story 8.3, FR-25). The
// secondary-trading position layer (Option C): a Subscriber's DIRECTIONAL position is acquired by
// the REAL FR-11/FR-18 subscribe+mint path and released by the REAL FR-21 redeem/burn path, with the
// on-chain transaction as the COMMIT POINT (no optimistic success). This module COMPOSES the proven
// seams — it authors no new mint/burn/ledger primitive:
//
//   • open  → `MintPairDualWrite` (5.3) submits a PAIRED `mintPair(owner, owner, amount)` (PENDING/
//             SUBMITTED, NO ledger entry); at the confirmed `PairMinted` commit point ONE balanced
//             journal entry (incl. `NOTE_LIABILITY`, via `makeMintPairLedgerEffect` + the 6.2
//             `buildSubscriptionMintPlan`) is posted AND the position row is created
//             (`@rose/positions` `createPosition`) — ATOMICALLY in the same confirm transaction.
//   • close → `BurnPairDualWrite` (5.4) submits a PAIRED `burnPair(owner, owner, sizeUnits)`; at the
//             confirmed `PairBurned` commit point ONE balanced retirement entry (via
//             `makeBurnPairLedgerEffect` + the 6.3 `buildRedemptionBurnPlan`) is posted AND the
//             position is flipped `OPEN → CLOSED` (`@rose/positions` `closePosition`) — atomically.
//
// BOTH-OR-NEITHER / single-leg impossible: on-chain `mintPair`/`burnPair` are atomic by the epic-4
// coupling contract (unchanged, not re-audited); off-chain the 5.3/5.4 effects ALWAYS post BOTH
// leg-quantity postings from the single confirmed on-chain amount — there is no single-leg path. The
// user holds the WHOLE package (`lTo == sTo == owner`); the `side` is the off-chain directional view.
//
// NO optimistic success: before the on-chain confirmation NO position row exists (open) and the
// lifecycle stays OPEN (close); the "pending" state is observable purely from the 5.2 outbox row
// (mirrors 6.2/6.3). A crash between submit and commit leaves a SUBMITTED outbox row (re-driven by the
// 5.6 `resumePending` seam) and NO half-open position.
//
// OUT OF SCOPE (do NOT add here): the independent single-side close when the opposite leg is held by
// ANOTHER user (the D1 topology) — that is Story 8.6 (§8 Q8 counterparty/inventory + §11.4 guardrail).
// All deps are INJECTED; PAPER/LOCAL only (mock transport + synthetic events in tests); NO secret.
import { and, desc, eq, ne } from 'drizzle-orm';
import {
  getCoupledPair,
  findByIdempotencyKey,
  findByTxHash,
  type OutboxEventRow,
  type RoseDb,
} from '@rose/ledger';
import {
  MintPairDualWrite,
  BurnPairDualWrite,
  OutboxSaga,
  makeMintPairLedgerEffect,
  makeBurnPairLedgerEffect,
  type LedgerEffect,
  type MintAuthorizationGate,
  type PairMintedEvent,
  type PairBurnedEvent,
} from '@rose/chain';
import {
  buildSubscriptionMintPlan,
  buildRedemptionBurnPlan,
  IneligibleSubscriberError,
  UnsupportedPaymentAssetError,
  type EligibilityProvider,
  type SubscriptionAccountTopology,
  type RedemptionAccountTopology,
} from '@rose/rose-note';
import { getAddress, type Address } from 'viem';
import { positions, type PositionSide } from './schema/positions.js';
import {
  createPosition,
  closePosition,
  getPosition,
  PositionLifecycleError,
  PositionNotFoundError,
  type PositionView,
} from './repositories/positions.js';

/**
 * A position-flow lifecycle status, DERIVED from the 5.2 outbox row: `pending` until the on-chain
 * commit point, `confirmed` once the balanced entry + position write commit, `failed` if the
 * dual-write was marked FAILED/COMPENSATED — a terminal failure is never masked as "still pending".
 */
export type PositionFlowStatus = 'pending' | 'confirmed' | 'failed';

/** An open-position flow as seen by the surfaces: pending until the on-chain commit point. */
export interface OpenPositionView {
  /** The idempotency key — the stable open-flow handle. */
  readonly id: string;
  readonly coupledPairId: string;
  /** The owner EVM address (holds BOTH legs of the paired package). */
  readonly owner: string;
  readonly side: PositionSide;
  /** Minted token quantity / collateral smallest-units (1:1 paper), as `bigint` (NFR-2). */
  readonly amount: bigint;
  readonly paymentAsset: string;
  readonly status: PositionFlowStatus;
  /** The on-chain tx hash (present once submitted). */
  readonly txHash: string | null;
  /** The posted journal entry id (present once confirmed at the commit point). */
  readonly journalEntryId: string | null;
  /** The persisted position (present once confirmed — created AT the commit point, not before). */
  readonly position: PositionView | null;
}

/** A close-position flow as seen by the surfaces: pending until the on-chain commit point. */
export interface ClosePositionView {
  /** The idempotency key — the stable close-flow handle. */
  readonly id: string;
  readonly positionId: string;
  readonly coupledPairId: string;
  readonly owner: string;
  /** Retired token quantity smallest-units, as `bigint` (NFR-2). */
  readonly amount: bigint;
  readonly paymentAsset: string;
  readonly status: PositionFlowStatus;
  readonly txHash: string | null;
  readonly journalEntryId: string | null;
  /** The position after the flip (CLOSED once confirmed; still OPEN while pending). */
  readonly position: PositionView | null;
}

/** Input to open a directional position over the atomic subscribe/mint path. */
export interface OpenPositionInput {
  /** The issued coupled pair the position is layered over (must be ACTIVE). */
  readonly coupledPairId: string;
  /** The owner's EVM address (receives BOTH legs of the paired package). */
  readonly owner: string;
  /** The recorded directional side (the off-chain synthetic view over the held package). */
  readonly side: PositionSide;
  /** Amount in smallest units — the minted token quantity per leg AND the collateral (1:1 paper). */
  readonly amount: bigint;
  /** The payment/collateral asset. In paper P0 it MUST equal the service's configured asset. */
  readonly paymentAsset: string;
  /** Idempotency key for the dual-write — exactly-once open (NFR-9). */
  readonly idempotencyKey: string;
}

/** Input to close a position over the atomic redeem/burn path (whole-package / same-user). */
export interface ClosePositionInput {
  /** The OPEN position to close (its owner holds BOTH legs in the 8.3 whole-package case). */
  readonly positionId: string;
  /** The payment/collateral asset. In paper P0 it MUST equal the service's configured asset. */
  readonly paymentAsset: string;
  /** Idempotency key for the dual-write — exactly-once close (NFR-9). */
  readonly idempotencyKey: string;
}

/** The position service surface (injected port). Open/close compose the atomic pair flow. */
export interface PositionService {
  /** Open: eligibility + authorization (pre-write) → submit the paired mint → PENDING (no entry/position). */
  openPosition(input: OpenPositionInput): Promise<OpenPositionView>;
  /** The COMMIT POINT for open: confirm a `PairMinted` → post the balanced entry + create the position, once. */
  confirmOpen(
    event: PairMintedEvent,
    ctx: { side: PositionSide },
  ): Promise<OpenPositionView | null>;
  /** Read an open flow's pending/confirmed status (+ the position once confirmed). */
  getOpenPosition(id: string): Promise<OpenPositionView | null>;
  /** Close: authorization (pre-write) → submit the paired burn → PENDING (no entry, position stays OPEN). */
  closePosition(input: ClosePositionInput): Promise<ClosePositionView>;
  /** The COMMIT POINT for close: confirm a `PairBurned` → post the balanced entry + flip OPEN→CLOSED, once. */
  confirmClose(event: PairBurnedEvent): Promise<ClosePositionView | null>;
  /** Read a close flow's pending/confirmed status (+ the position). */
  getClosePosition(id: string): Promise<ClosePositionView | null>;
}

/** Thrown when the referenced coupled pair does not exist. Maps to 404. */
export class PositionPairNotFoundError extends Error {
  readonly coupledPairId: string;
  constructor(coupledPairId: string) {
    super(`Coupled pair '${coupledPairId}' not found.`);
    this.name = 'PositionPairNotFoundError';
    this.coupledPairId = coupledPairId;
  }
}

/** Thrown when the pair is not ACTIVE (cannot open/close a position against a non-live pair). Maps to 409. */
export class PositionPairNotActiveError extends Error {
  readonly coupledPairId: string;
  readonly state: string;
  constructor(coupledPairId: string, state: string) {
    super(`Coupled pair '${coupledPairId}' is '${state}', not ACTIVE.`);
    this.name = 'PositionPairNotActiveError';
    this.coupledPairId = coupledPairId;
    this.state = state;
  }
}

/**
 * Thrown when an `idempotencyKey` is reused with a request that does NOT match the recorded intent
 * (a different pair, owner, or amount). Returning the original flow for a different request would
 * silently hand the caller someone else's position, so this is a fail-closed conflict. Maps to 409.
 */
export class PositionIdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used for a DIFFERENT position request ` +
        `(pair/owner/amount mismatch). Use a fresh key for a new open/close.`,
    );
    this.name = 'PositionIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** The rule name the §11.4 solvency guardrail refusal carries (UX-DR5 — a stable, surface-nameable id). */
export const SOLVENCY_GUARDRAIL_RULE = '§11.4-solvency-guardrail-independent-single-side-close';

/**
 * Thrown when a holder attempts an INDEPENDENT single-side close in the D1 topology — the opposite
 * leg of the same pair is held by ANOTHER user (a live counterparty leg the closer does not control).
 * The counterparty / inventory model (matched-book re-assignment vs house/inventory — §8 Q8 / §11.4)
 * is a board-gated, pre-build product/risk decision that is NOT yet resolved, so this path is
 * FAIL-CLOSED under the §11.4 solvency guardrail (NFR-4): the close is refused BEFORE any `burnPair`
 * is submitted. This deliberately does NOT force a whole-package burn of the other holder's leg — the
 * on-chain package is burned ONLY when BOTH sides are released. The full re-assignment/house model is
 * out of P0 and lands once §8 Q8 is chosen and shown solvency-preserving. UX-DR5: the refusal NAMES
 * the guardrail rule so a surface can name it to the operator (maps to a 409 at the API boundary).
 * [Source: epics.md §Story 8.6; architecture.md line 186 "Open sub-decision (§8 Q8 / §11.4)".]
 */
export class SolvencyGuardrailError extends Error {
  /** The position the holder tried to close independently. */
  readonly positionId: string;
  readonly coupledPairId: string;
  /** The side being closed; the live counterparty holds the OPPOSITE side. */
  readonly side: PositionSide;
  /** The other user who holds the opposite leg (the un-controlled counterparty). */
  readonly counterpartyOwner: string;
  readonly counterpartyPositionId: string;
  /** The named guardrail rule (UX-DR5). */
  readonly rule: string;
  constructor(args: {
    positionId: string;
    coupledPairId: string;
    side: PositionSide;
    counterpartyOwner: string;
    counterpartyPositionId: string;
  }) {
    const opposite = args.side === 'LONG' ? 'SHORT' : 'LONG';
    super(
      `§11.4 solvency guardrail: independent single-side close of position '${args.positionId}' is ` +
        `refused — its opposite (${opposite}) leg of pair '${args.coupledPairId}' is held by another ` +
        `user ('${args.counterpartyOwner}'). The on-chain package is burned ONLY when BOTH sides are ` +
        `released; the counterparty/inventory model (§8 Q8) is not yet resolved, so this path is ` +
        `fail-closed (no whole-package burn of the other holder's leg).`,
    );
    this.name = 'SolvencyGuardrailError';
    this.positionId = args.positionId;
    this.coupledPairId = args.coupledPairId;
    this.side = args.side;
    this.counterpartyOwner = args.counterpartyOwner;
    this.counterpartyPositionId = args.counterpartyPositionId;
    this.rule = SOLVENCY_GUARDRAIL_RULE;
  }
}

/** Injected dependencies for the position service. The service opens no connection and holds no key. */
export interface PositionServiceDeps {
  readonly db: RoseDb;
  /** The 5.2 outbox/saga — `confirmOpen`/`confirmClose` drive its `confirmFromEvent` commit point. */
  readonly saga: OutboxSaga;
  /** The 5.3 paired-mint dual-write (built with the injected chain clients + seam account). */
  readonly mint: MintPairDualWrite;
  /** The 5.4 paired-burn dual-write. */
  readonly burn: BurnPairDualWrite;
  /** The deployed `CoupledPair` address the mint/burn target. */
  readonly pairAddress: Address;
  /** The eligibility seam (FR-19) — consulted before any OPEN write (token receipt). */
  readonly eligibility: EligibilityProvider;
  /** The capital-flow authorization gate (the default-deny `postTransfer` decision), consulted pre-submit. */
  readonly authorize: MintAuthorizationGate;
  /** Caller-supplied account topology for the open (subscription) mint plan (incl. `NOTE_LIABILITY`). */
  readonly openTopology: SubscriptionAccountTopology;
  /** Caller-supplied account topology for the close (redemption) burn plan (incl. `NOTE_LIABILITY`). */
  readonly closeTopology: RedemptionAccountTopology;
  /** The payment/collateral asset the cash/`NOTE_LIABILITY` accounts are denominated in (paper P0). */
  readonly paymentAsset: string;
}

/** Map an outbox status to the position-flow status (terminal failures never read pending). */
function statusOf(outboxStatus: OutboxEventRow['status']): PositionFlowStatus {
  if (outboxStatus === 'CONFIRMED') return 'confirmed';
  if (outboxStatus === 'FAILED' || outboxStatus === 'COMPENSATED') return 'failed';
  return 'pending';
}

/**
 * Builds the position service (the injected port). Composes the existing seams — eligibility,
 * capital-flow authorization, the 5.3/5.4 dual-writes, the 6.2/6.3 ledger plans, the 8.2 position
 * repository — into the FR-25 open → mint → commit → (balanced entry + position) and
 * close → burn → commit → (balanced entry + OPEN→CLOSED) loops. Authors no new primitive.
 */
export function makePositionService(deps: PositionServiceDeps): PositionService {
  const openDescription = 'Position open — paired mint over subscribe/mint (Story 8.3)';
  const closeDescription = 'Position close — paired burn over redeem/burn (Story 8.3)';

  /** Find the single OPEN position for a (pair, owner) — the 8.3 whole-package case. */
  async function findOpenPosition(
    executor: Parameters<typeof getPosition>[0],
    coupledPairId: string,
    owner: string,
  ): Promise<{ id: string } | null> {
    const rows = await executor
      .select({ id: positions.id })
      .from(positions)
      .where(
        and(
          eq(positions.coupledPairId, coupledPairId),
          eq(positions.owner, owner),
          eq(positions.lifecycle, 'OPEN'),
        ),
      );
    // 8.3 assumes one OPEN position per (owner, pair) (whole-package). 0 or >1 ⇒ not closeable here.
    return rows.length === 1 && rows[0] ? { id: rows[0].id } : null;
  }

  /**
   * The §11.4 solvency-guardrail detector for the D1 topology. Returns the OPEN position on the SAME
   * pair holding the OPPOSITE side owned by a DIFFERENT user (the live counterparty leg the closer
   * does not control), or null. The closer's OWN opposite-side leg never matches (`owner != closer`),
   * and a CLOSED opposite leg never matches (`lifecycle = 'OPEN'`) — neither is a live counterparty.
   */
  async function findOpposingHolder(
    executor: Parameters<typeof getPosition>[0],
    coupledPairId: string,
    side: PositionSide,
    owner: string,
  ): Promise<{ id: string; owner: string } | null> {
    const oppositeSide: PositionSide = side === 'LONG' ? 'SHORT' : 'LONG';
    const rows = await executor
      .select({ id: positions.id, owner: positions.owner })
      .from(positions)
      .where(
        and(
          eq(positions.coupledPairId, coupledPairId),
          eq(positions.side, oppositeSide),
          eq(positions.lifecycle, 'OPEN'),
          ne(positions.owner, owner),
        ),
      )
      .limit(1);
    return rows.length === 1 && rows[0] ? rows[0] : null;
  }

  /** Build an OpenPositionView from the outbox row (+ the linked position, once confirmed). */
  async function openViewFromRow(row: OutboxEventRow): Promise<OpenPositionView | null> {
    if (row.operationKind !== 'PAIR_MINT') {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const coupledPairId = payload.coupledPairId;
    const owner = payload.lTo;
    const amount = payload.amount;
    if (
      typeof coupledPairId !== 'string' ||
      typeof owner !== 'string' ||
      typeof amount !== 'string'
    ) {
      return null;
    }
    // The position is created AT the commit point, keyed off (pair, owner) (whole-package). It is
    // null until confirmed (no optimistic success). A CLOSED position is no longer the open view's.
    const position = await findOpenPositionView(deps.db, coupledPairId, owner);
    return {
      id: row.idempotencyKey,
      coupledPairId,
      owner,
      side: position?.side ?? 'LONG',
      amount: BigInt(amount),
      paymentAsset: deps.paymentAsset,
      status: statusOf(row.status),
      txHash: row.txHash,
      journalEntryId: row.journalEntryId,
      position,
    };
  }

  /** Resolve the OPEN position view for (pair, owner), or null. */
  async function findOpenPositionView(
    executor: Parameters<typeof getPosition>[0],
    coupledPairId: string,
    owner: string,
  ): Promise<PositionView | null> {
    const found = await findOpenPosition(executor, coupledPairId, owner);
    return found ? getPosition(deps.db, found.id) : null;
  }

  /**
   * Build a ClosePositionView from the outbox burn row. The 5.4 burn intent payload carries no
   * `positionId` (its fixed shape is `{coupledPairId, lFrom, sFrom, amount}`), so the position is
   * derived from persisted state by `(coupledPairId, owner=lFrom)` — the most-recently-updated match
   * (the one this close targets in the 8.3 whole-package case). `null` until/unless a position exists.
   */
  async function closeViewFromRow(row: OutboxEventRow): Promise<ClosePositionView | null> {
    if (row.operationKind !== 'PAIR_BURN') {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const coupledPairId = payload.coupledPairId;
    const owner = payload.lFrom;
    const amount = payload.amount;
    if (
      typeof coupledPairId !== 'string' ||
      typeof owner !== 'string' ||
      typeof amount !== 'string'
    ) {
      return null;
    }
    const position = await findLatestPositionForOwner(coupledPairId, owner);
    return {
      id: row.idempotencyKey,
      positionId: position?.id ?? '',
      coupledPairId,
      owner,
      amount: BigInt(amount),
      paymentAsset: deps.paymentAsset,
      status: statusOf(row.status),
      txHash: row.txHash,
      journalEntryId: row.journalEntryId,
      position,
    };
  }

  /** The most-recently-updated position for a (pair, owner) — the close flow's target. */
  async function findLatestPositionForOwner(
    coupledPairId: string,
    owner: string,
  ): Promise<PositionView | null> {
    const rows = await deps.db
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.coupledPairId, coupledPairId), eq(positions.owner, owner)))
      .orderBy(desc(positions.updatedAt))
      .limit(1);
    return rows.length === 1 && rows[0] ? getPosition(deps.db, rows[0].id) : null;
  }

  return Object.freeze({
    async openPosition(input: OpenPositionInput): Promise<OpenPositionView> {
      if (input.paymentAsset !== deps.paymentAsset) {
        throw new UnsupportedPaymentAssetError(input.paymentAsset, deps.paymentAsset);
      }
      if (input.side !== 'LONG' && input.side !== 'SHORT') {
        throw new PositionPairNotActiveError(
          input.coupledPairId,
          `invalid side '${String(input.side)}'`,
        );
      }

      // 1. Resolve the pair: it must exist and be ACTIVE to acquire exposure against it.
      const pair = await getCoupledPair(deps.db, input.coupledPairId);
      if (pair === null) {
        throw new PositionPairNotFoundError(input.coupledPairId);
      }
      if (pair.state !== 'ACTIVE') {
        throw new PositionPairNotActiveError(pair.id, pair.state);
      }

      // 2. Eligibility (FR-19) — fail-closed BEFORE any write (opening acquires token receipt).
      const decision = deps.eligibility.checkEligibility(input.owner);
      if (!decision.eligible) {
        console.warn('[position] open eligibility refused — nothing written (fail-closed)', {
          coupledPairId: input.coupledPairId,
          owner: input.owner,
          reason: decision.reason,
        });
        throw new IneligibleSubscriberError(input.owner, decision.reason);
      }
      const ownerAddress = getAddress(input.owner) as Address;

      // 3. Drive the paired-mint dual-write: authorize (pre-submit, fail-closed) → submit → SUBMITTED.
      //    NO ledger entry, NO position row here — the commit point is the confirmed PairMinted.
      const result = await deps.mint.start({
        idempotencyKey: input.idempotencyKey,
        coupledPairId: pair.id,
        pairAddress: deps.pairAddress,
        lTo: ownerAddress,
        sTo: ownerAddress,
        amount: input.amount,
        authorize: deps.authorize,
      });

      // Idempotency conflict (NFR-9): a reused key returns the EXISTING intent. Fail closed if its
      // recorded request does NOT match (never hand the caller a DIFFERENT owner's package).
      if (result.alreadyStarted) {
        const recorded = result.outbox.payload as Record<string, unknown>;
        if (
          recorded.coupledPairId !== pair.id ||
          recorded.lTo !== ownerAddress ||
          recorded.amount !== input.amount.toString()
        ) {
          throw new PositionIdempotencyConflictError(input.idempotencyKey);
        }
      }

      console.info('[position] open paired mint submitted — pending until on-chain commit point', {
        coupledPairId: pair.id,
        owner: ownerAddress,
        side: input.side,
        idempotencyKey: input.idempotencyKey,
        txHash: result.txHash,
        alreadyStarted: result.alreadyStarted,
      });

      const position = await findOpenPositionView(deps.db, pair.id, ownerAddress);
      return {
        id: input.idempotencyKey,
        coupledPairId: pair.id,
        owner: ownerAddress,
        side: input.side,
        amount: input.amount,
        paymentAsset: deps.paymentAsset,
        status: statusOf(result.outbox.status),
        txHash: result.outbox.txHash,
        journalEntryId: result.outbox.journalEntryId,
        position,
      };
    },

    async confirmOpen(
      event: PairMintedEvent,
      ctx: { side: PositionSide },
    ): Promise<OpenPositionView | null> {
      // THE COMMIT POINT — must NEVER throw into the (fire-and-forget) watcher (mirror 5.3/6.2). The
      // composed effect posts the balanced both-legs entry AND creates the position, atomically.
      try {
        if (event.transactionHash === null) {
          return null;
        }
        const ownerAddress = getAddress(event.args.lTo);
        const mintPlan = buildSubscriptionMintPlan({
          description: openDescription,
          amount: event.args.amount,
          topology: deps.openTopology,
        });
        const baseEffect = makeMintPairLedgerEffect(event.args, mintPlan);
        const openEffect: LedgerEffect = async (executor, effectCtx) => {
          // 1. Post the balanced both-legs mint entry (incl. NOTE_LIABILITY). This cross-checks the
          //    on-chain amount/recipients vs the intent (divergence ⇒ throws ⇒ confirm rolls back).
          const posted = await baseEffect(executor, effectCtx);
          // 2. Record the position AT the commit point, atomically. entry = pair anchor P₀; size =
          //    the confirmed on-chain amount; leverage pinned '1' (8.2 rejects anything else).
          const payload = effectCtx.payload as Record<string, unknown>;
          const coupledPairId = payload.coupledPairId;
          if (typeof coupledPairId !== 'string') {
            throw new Error('Open confirm: outbox payload has no coupledPairId.');
          }
          const pair = await getCoupledPair(executor, coupledPairId);
          if (pair === null) {
            throw new Error(`Open confirm: coupled pair '${coupledPairId}' not found.`);
          }
          await createPosition(executor, {
            coupledPairId,
            owner: ownerAddress,
            referenceAsset: pair.referenceAsset,
            side: ctx.side,
            sizeUnits: event.args.amount,
            entryPrice: pair.anchorPrice,
            collateral: event.args.amount,
            leverage: '1',
          });
          return posted;
        };
        await deps.saga.confirmFromEvent(event, openEffect);

        const row = await findByTxHash(deps.db, event.transactionHash);
        return row === null ? null : openViewFromRow(row);
      } catch (error) {
        console.warn('[position] open confirm anomaly — left for reconcile (5.6), nothing thrown', {
          txHash: event.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async getOpenPosition(id: string): Promise<OpenPositionView | null> {
      const row = await findByIdempotencyKey(deps.db, id);
      return row === null ? null : openViewFromRow(row);
    },

    async closePosition(input: ClosePositionInput): Promise<ClosePositionView> {
      if (input.paymentAsset !== deps.paymentAsset) {
        throw new UnsupportedPaymentAssetError(input.paymentAsset, deps.paymentAsset);
      }

      // 1. Load the position — it must be OPEN to close (no re-close of a CLOSED position).
      const position = await getPosition(deps.db, input.positionId);
      if (position === null) {
        throw new PositionNotFoundError(input.positionId);
      }
      if (position.lifecycle !== 'OPEN') {
        throw new PositionLifecycleError(
          input.positionId,
          position.lifecycle,
          `Cannot close position '${input.positionId}' in lifecycle '${position.lifecycle}'.`,
        );
      }

      // 1a. §11.4 SOLVENCY GUARDRAIL (Story 8.6) — fail-closed BEFORE any burn is submitted. If the
      //     OPPOSITE leg of the same pair is held by ANOTHER user (the D1 topology), this is an
      //     INDEPENDENT single-side close: it must NOT force a whole-package burn of the other
      //     holder's leg, and the on-chain package burns ONLY when BOTH sides are released. The
      //     counterparty/inventory model (§8 Q8) is board-gated and unresolved, so the path is
      //     refused with a typed, rule-named refusal (UX-DR5). The same-user whole-package close
      //     (8.3) has no opposing different-owner leg and is NOT affected.
      const opposing = await findOpposingHolder(
        deps.db,
        position.coupledPairId,
        position.side,
        position.owner,
      );
      if (opposing !== null) {
        console.warn(
          '[position] close refused — §11.4 solvency guardrail (D1 independent single-side close); NO burn submitted',
          {
            positionId: input.positionId,
            coupledPairId: position.coupledPairId,
            side: position.side,
            owner: position.owner,
            counterpartyOwner: opposing.owner,
            counterpartyPositionId: opposing.id,
            rule: SOLVENCY_GUARDRAIL_RULE,
          },
        );
        throw new SolvencyGuardrailError({
          positionId: input.positionId,
          coupledPairId: position.coupledPairId,
          side: position.side,
          counterpartyOwner: opposing.owner,
          counterpartyPositionId: opposing.id,
        });
      }

      // 2. Load its pair — it must be ACTIVE to redeem/burn against.
      const pair = await getCoupledPair(deps.db, position.coupledPairId);
      if (pair === null) {
        throw new PositionPairNotFoundError(position.coupledPairId);
      }
      if (pair.state !== 'ACTIVE') {
        throw new PositionPairNotActiveError(pair.id, pair.state);
      }

      const ownerAddress = getAddress(position.owner) as Address;
      const amount = position.sizeUnits;

      // 3. Drive the paired-burn dual-write: authorize (pre-submit, fail-closed) → submit → SUBMITTED.
      //    NO burn entry here, position stays OPEN — the commit point is the confirmed PairBurned.
      //    (Close applies only the capital-flow chokepoint; FR-19 eligibility gates RECEIPT, not burn.)
      const result = await deps.burn.start({
        idempotencyKey: input.idempotencyKey,
        coupledPairId: position.coupledPairId,
        pairAddress: deps.pairAddress,
        lFrom: ownerAddress,
        sFrom: ownerAddress,
        amount,
        authorize: deps.authorize,
      });

      if (result.alreadyStarted) {
        const recorded = result.outbox.payload as Record<string, unknown>;
        if (
          recorded.coupledPairId !== position.coupledPairId ||
          recorded.lFrom !== ownerAddress ||
          recorded.amount !== amount.toString()
        ) {
          throw new PositionIdempotencyConflictError(input.idempotencyKey);
        }
      }

      console.info('[position] close paired burn submitted — pending until on-chain commit point', {
        positionId: input.positionId,
        coupledPairId: position.coupledPairId,
        owner: ownerAddress,
        idempotencyKey: input.idempotencyKey,
        txHash: result.txHash,
        alreadyStarted: result.alreadyStarted,
      });

      return {
        id: input.idempotencyKey,
        positionId: input.positionId,
        coupledPairId: position.coupledPairId,
        owner: ownerAddress,
        amount,
        paymentAsset: deps.paymentAsset,
        status: statusOf(result.outbox.status),
        txHash: result.outbox.txHash,
        journalEntryId: result.outbox.journalEntryId,
        position,
      };
    },

    async confirmClose(event: PairBurnedEvent): Promise<ClosePositionView | null> {
      // THE COMMIT POINT — never throws into the watcher (mirror 5.4/6.3). The composed effect posts
      // the balanced both-legs retirement entry AND flips the position OPEN→CLOSED, atomically.
      try {
        if (event.transactionHash === null) {
          return null;
        }
        const ownerAddress = getAddress(event.args.lFrom);
        const burnPlan = buildRedemptionBurnPlan({
          description: closeDescription,
          amount: event.args.amount,
          topology: deps.closeTopology,
        });
        const baseEffect = makeBurnPairLedgerEffect(event.args, burnPlan);
        const closeEffect: LedgerEffect = async (executor, effectCtx) => {
          const posted = await baseEffect(executor, effectCtx);
          const payload = effectCtx.payload as Record<string, unknown>;
          const coupledPairId = payload.coupledPairId;
          if (typeof coupledPairId !== 'string') {
            throw new Error('Close confirm: outbox payload has no coupledPairId.');
          }
          // Derive the OPEN position from persisted state (pair, owner=lFrom) — whole-package case.
          const found = await findOpenPosition(executor, coupledPairId, ownerAddress);
          if (found === null) {
            throw new Error(
              `Close confirm: no single OPEN position for pair '${coupledPairId}' owner '${ownerAddress}'.`,
            );
          }
          // Flip OPEN→CLOSED in the SAME confirm transaction (closePosition nests a savepoint).
          await closePosition(executor, found.id);
          return posted;
        };
        await deps.saga.confirmFromEvent(event, closeEffect);

        const row = await findByTxHash(deps.db, event.transactionHash);
        return row === null ? null : closeViewFromRow(row);
      } catch (error) {
        console.warn(
          '[position] close confirm anomaly — left for reconcile (5.6), nothing thrown',
          {
            txHash: event.transactionHash,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }
    },

    async getClosePosition(id: string): Promise<ClosePositionView | null> {
      const row = await findByIdempotencyKey(deps.db, id);
      return row === null ? null : closeViewFromRow(row);
    },
  });
}
