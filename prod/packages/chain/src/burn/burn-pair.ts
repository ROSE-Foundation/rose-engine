// Paired-burn dual-write orchestration (Story 5.4, FR-21, NFR-9 / NFR-3). The burn twin of the
// Story-5.3 paired-mint dual-write: wires the concrete `burnPair` on-chain write + the balanced-ledger
// recording onto the Story-5.2 `OutboxSaga`, so the on-chain `PairBurned` confirmation is the COMMIT
// POINT — the matching balanced journal entry (the package RETIREMENT) is posted ONLY at confirmation,
// never at intent or submission.
//
// This module supplies the two ports the 5.2 saga was built to receive:
//   - `submitBurnPair` — the saga `submit` for `PAIR_BURN`: calls the epic-4
//     `CoupledPair.burnPair(lFrom, sFrom, amount)` via the 5.1 `getWalletClient` seam (no key held
//     here; real broadcast is ops-deferred). `encodeBurnPairCall` is the network-free calldata seam.
//   - `makeBurnPairLedgerEffect` — the concrete `LedgerEffect`: at the commit point it posts ONE
//     balanced journal entry linked to the coupled pair (FR-13 `recordJournalEntry`), capturing the
//     burned token QUANTITY (taken from the CONFIRMED on-chain `PairBurned` args — chain = source of
//     truth, D3 / NFR-9) AND the redemption VALUE notional. The quantity direction is the INVERSE of a
//     mint: a burn RETIRES supply, so the holder leg is CREDITED and the supply contra DEBITED.
//
// AUTHORIZATION ORDERING (Story-5.3 review lesson, followed here): a non-`ALLOW` authorization decision
// must veto the dual-write BEFORE the irreversible on-chain burn — refusing AFTER the chain has burned
// would strand a real on-chain retirement with no recordable ledger entry (an unrecoverable NFR-9
// divergence). So the fail-closed gate (the SAME default-deny decision `postTransfer` consults) runs in
// `start`, pre-submit; the commit-point effect records the confirmed on-chain quantity UNCONDITIONALLY.
//
// Shared, asset-direction-agnostic guards/types are imported from `../pair-shared.js` (factored from
// the 5.3 mint pattern); only the burn-specific orchestration, intent shape, and posting direction live
// here. All amounts are integers (uint256 → `bigint` → `NUMERIC`); the outbox `payload` stores them as
// decimal-integer strings (NFR-2 — never a JS float).
import { encodeFunctionData, getAddress, type Account, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { z } from 'zod';
import type { OutboxEventRow, RecordPostingInput, RoseExecutor } from '@rose/ledger';
import { recordJournalEntry } from '@rose/ledger';
import { coupledPairAbi } from '../abis/coupled-pair-abi.js';
import type { RoseChainClients } from '../viem-clients.js';
import type { LedgerEffect } from '../outbox/outbox-saga.js';
import { OutboxSaga } from '../outbox/outbox-saga.js';
import type { PairBurnedArgs, PairBurnedEvent } from '../watchers.js';
import {
  HEX_TX_HASH,
  addressString,
  assertPairAmount,
  assertPairPlanAccountsDisjoint,
  integerAmountString,
  type PairAuthorizationGate,
  type PairLedgerPlan as BurnLedgerPlanT,
} from '../pair-shared.js';

// Re-export the shared primitives the burn surface advertises (canonical home is `pair-shared.ts`).
export {
  InvalidPairAmountError,
  PairPlanError,
  type PairAuthorizationGate as BurnAuthorizationGate,
  type PairAuthorizationDecision as BurnAuthorizationDecision,
  type PairLedgerPlan as BurnLedgerPlan,
  type PairLegAccounts as BurnLegAccounts,
  type PairValuePlan as BurnValuePlan,
} from '../pair-shared.js';

// ---- On-chain write (the saga `submit` for PAIR_BURN) -----------------------------------------

/** The on-chain `burnPair` call coordinates: which pair, whose legs are burned, and how much. */
export interface BurnPairOnChainParams {
  readonly pairAddress: Address;
  readonly lFrom: Address;
  readonly sFrom: Address;
  /** Token quantity to burn on BOTH legs (uint256, NFR-2: bigint — never a JS number/float). */
  readonly amount: bigint;
}

/**
 * Encodes the `burnPair(lFrom, sFrom, amount)` calldata for the deployed `CoupledPair`. Pure + network-
 * free (deterministic) — the unit-test seam that proves the on-chain call shape without a wallet or an
 * RPC. Validates the amount (NFR-2) before encoding.
 */
export function encodeBurnPairCall(params: BurnPairOnChainParams): {
  readonly address: Address;
  readonly data: Hex;
} {
  assertPairAmount(params.amount, 'Burn');
  const data = encodeFunctionData({
    abi: coupledPairAbi,
    functionName: 'burnPair',
    args: [params.lFrom, params.sFrom, params.amount],
  });
  return { address: params.pairAddress, data };
}

/**
 * Submits the on-chain paired burn: `CoupledPair.burnPair(lFrom, sFrom, amount)` via the 5.1
 * `getWalletClient(account)` seam. Returns the broadcast tx hash (viem's `writeContract` resolves it
 * pre-mining). This package never holds or derives a private key — the caller supplies the `Account`;
 * the REAL Sepolia broadcast (funded RPC + out-of-band signer) is ops-deferred (see deferred-work.md
 * story-5.4). The saga records this hash (`PENDING -> SUBMITTED`); the commit point is the later
 * `PairBurned` confirmation, NOT this submission.
 */
export async function submitBurnPair(
  clients: RoseChainClients,
  account: Account,
  params: BurnPairOnChainParams,
): Promise<{ readonly txHash: Hex }> {
  assertPairAmount(params.amount, 'Burn');
  const walletClient = clients.getWalletClient(account);
  const txHash = await walletClient.writeContract({
    address: params.pairAddress,
    abi: coupledPairAbi,
    functionName: 'burnPair',
    args: [params.lFrom, params.sFrom, params.amount],
    account,
    chain: sepolia,
  });
  return { txHash };
}

// ---- The PAIR_BURN intent payload (persisted in the outbox) -----------------------------------

/** The intent recorded in `outbox_events.payload` for a `PAIR_BURN`. Amounts are decimal strings. */
export const burnPairIntentSchema = z.object({
  coupledPairId: z.string().uuid(),
  lFrom: addressString,
  sFrom: addressString,
  amount: integerAmountString,
});
export type BurnPairIntent = z.infer<typeof burnPairIntentSchema>;

// ---- Authorization (fail-closed, consulted PRE-submit) ----------------------------------------

/** Thrown when the injected authorization gate does not return `ALLOW` (fail-closed, NFR-4). */
export class BurnAuthorizationError extends Error {
  readonly effect: 'DENY' | 'REFUSE';
  readonly reason: string;
  constructor(effect: 'DENY' | 'REFUSE', reason: string) {
    super(`Burn not authorized (${effect}): ${reason}`);
    this.name = 'BurnAuthorizationError';
    this.effect = effect;
    this.reason = reason;
  }
}

// ---- The concrete LedgerEffect (the commit-point balanced entry) ------------------------------

/** Thrown when the confirmed on-chain burn diverges from the recorded intent (amount or sender, NFR-9). */
export class BurnQuantityDivergenceError extends Error {
  readonly field: 'amount' | 'lFrom' | 'sFrom';
  readonly onChain: string;
  readonly intended: string;
  constructor(field: 'amount' | 'lFrom' | 'sFrom', onChain: string, intended: string) {
    super(
      `Burn ${field} divergence: confirmed on-chain ${field} ${onChain} != recorded intent ${intended}. ` +
        `Chain is the source of truth (D3); leaving for reconcile (5.6).`,
    );
    this.name = 'BurnQuantityDivergenceError';
    this.field = field;
    this.onChain = onChain;
    this.intended = intended;
  }
}

/**
 * Builds the concrete burn `LedgerEffect` for a CONFIRMED `PairBurned`. Invoked by the 5.2 saga ONLY at
 * the commit point, inside the confirm transaction (atomic with the `SUBMITTED -> CONFIRMED` flip and
 * the `journal_entries.tx_hash` stamp). It:
 *   1. binds NFR-9 — the retired token quantity IS the confirmed on-chain `amount` (D3), and the
 *      confirmed `lFrom`/`sFrom`/`amount` are cross-checked against the recorded intent, throwing
 *      `BurnQuantityDivergenceError` on any mismatch (nothing posted — a reconcile-5.6 signal);
 *   2. guards the plan against account overlaps that would silently net the quantity (`PairPlanError`);
 *   3. posts ONE balanced journal entry (FR-13) linked to the coupled pair: BOTH leg-quantity postings
 *      (from `onChainArgs.amount`) RETIRING supply — the holder leg is CREDITED and the supply contra
 *      DEBITED (the INVERSE of a mint) — + the optional value postings. Both legs are ALWAYS posted from
 *      the single amount — there is no path to a single-leg ledger record (mirrors the atomic on-chain
 *      `burnPair`; the contract + 4.3 coupling guard are the source-of-truth backstop).
 *
 * Authorization is NOT consulted here — it is enforced pre-submit (see `start`). The effect throws on
 * divergence/plan/amount errors; the watcher-facing `confirmFromBurnedEvent` CATCHES those so a
 * malformed confirm never escapes into the (fire-and-forget) watcher.
 */
export function makeBurnPairLedgerEffect(
  onChainArgs: PairBurnedArgs,
  plan: BurnLedgerPlanT,
): LedgerEffect {
  return async (executor: RoseExecutor, ctx): Promise<{ journalEntryId: string }> => {
    assertPairAmount(onChainArgs.amount, 'Burn');

    // The payload is the recorded intent (decimal-string amounts, NFR-2). Validate + cross-check EVERY
    // load-bearing field against the confirmed on-chain event (chain = source of truth, D3).
    const intent = burnPairIntentSchema.parse(ctx.payload);
    const intendedAmount = BigInt(intent.amount);
    if (intendedAmount !== onChainArgs.amount) {
      console.warn('[burn] quantity divergence — posting nothing (reconcile 5.6)', {
        coupledPairId: intent.coupledPairId,
        onChainAmount: onChainArgs.amount.toString(),
        intendedAmount: intendedAmount.toString(),
        txHash: ctx.txHash,
      });
      throw new BurnQuantityDivergenceError(
        'amount',
        onChainArgs.amount.toString(),
        intendedAmount.toString(),
      );
    }
    if (getAddress(intent.lFrom) !== getAddress(onChainArgs.lFrom)) {
      throw new BurnQuantityDivergenceError(
        'lFrom',
        getAddress(onChainArgs.lFrom),
        getAddress(intent.lFrom),
      );
    }
    if (getAddress(intent.sFrom) !== getAddress(onChainArgs.sFrom)) {
      throw new BurnQuantityDivergenceError(
        'sFrom',
        getAddress(onChainArgs.sFrom),
        getAddress(intent.sFrom),
      );
    }

    assertPairPlanAccountsDisjoint(plan);

    // ONE balanced entry: both leg quantities RETIRED (from the on-chain amount, NFR-9) + value
    // postings. A burn RETIRES supply: the holder leg is CREDITED (its balance drops) and the supply
    // contra is DEBITED — the exact INVERSE of a mint. recordJournalEntry enforces per-(asset, scale)
    // balance + the DB double-entry trigger backstop, so a mis-asseted leg is rejected and nothing
    // persists (fail-safe).
    const postings: RecordPostingInput[] = [
      { accountId: plan.longLeg.holderAccountId, direction: 'CREDIT', amount: onChainArgs.amount },
      { accountId: plan.longLeg.supplyAccountId, direction: 'DEBIT', amount: onChainArgs.amount },
      { accountId: plan.shortLeg.holderAccountId, direction: 'CREDIT', amount: onChainArgs.amount },
      { accountId: plan.shortLeg.supplyAccountId, direction: 'DEBIT', amount: onChainArgs.amount },
      ...(plan.value?.postings ?? []),
    ];

    const entry = await recordJournalEntry(executor, {
      description: plan.description,
      coupledPairId: intent.coupledPairId,
      postings,
    });
    console.info('[burn] recorded balanced burn entry at commit point', {
      coupledPairId: intent.coupledPairId,
      journalEntryId: entry.entry.id,
      quantity: onChainArgs.amount.toString(),
      txHash: ctx.txHash,
    });
    return { journalEntryId: entry.entry.id };
  };
}

// ---- The burn orchestration (intent -> submit -> confirm-from-event) --------------------------

/** A request to burn (retire) a coupled pair package on-chain and record it in the ledger. */
export interface BurnPairRequest {
  /** Idempotency key for the dual-write (exactly-once intent — NFR-9). */
  readonly idempotencyKey: string;
  readonly coupledPairId: string;
  readonly pairAddress: Address;
  readonly lFrom: Address;
  readonly sFrom: Address;
  /** Token quantity to burn on BOTH legs (uint256, NFR-2: bigint). */
  readonly amount: bigint;
  /**
   * Fail-closed authorization gate (the `postTransfer` decision seam), consulted PRE-submit. If
   * supplied and it does not return `ALLOW`, the dual-write is vetoed before any on-chain burn
   * (`BurnAuthorizationError`, nothing recorded). Production MUST inject the default-deny provider.
   */
  readonly authorize?: PairAuthorizationGate;
}

export interface BurnPairDualWriteDeps {
  readonly saga: OutboxSaga;
  readonly clients: RoseChainClients;
  /** The signing account for the `burnPair` write (out-of-band; never derived here). */
  readonly account: Account;
}

/** The result of `start`: the outbox row, its recorded tx hash (null only for a non-submitted row). */
export interface BurnStartResult {
  readonly outbox: OutboxEventRow;
  readonly txHash: Hex | null;
  /** True when an existing (already-submitted) intent was returned without re-broadcasting. */
  readonly alreadyStarted: boolean;
}

/** The outcome of a commit-point confirmation — never throws into the (fire-and-forget) watcher. */
export type BurnConfirmOutcome =
  | { readonly status: 'applied'; readonly row: OutboxEventRow }
  | { readonly status: 'noop'; readonly row: OutboxEventRow }
  | { readonly status: 'no-row' }
  | { readonly status: 'anomaly'; readonly error: Error };

/**
 * The paired-burn dual-write orchestrator (the burn twin of `MintPairDualWrite`). `start` authorizes
 * (pre-submit, fail-closed), records the `PAIR_BURN` intent (PENDING) and submits the on-chain
 * `burnPair` tx (SUBMITTED) — NO ledger effect yet (submission is not the commit point).
 * `confirmFromBurnedEvent` is the COMMIT POINT wiring: on a confirmed `PairBurned` `ChainEvent`, it
 * posts the balanced retirement entry exactly once (idempotent under re-delivery via the 5.2 saga) and
 * NEVER throws into the watcher. Intended live wiring:
 *
 *   watchPairEvents(clients, { pairAddress, onPairBurned: (e) => void burn.confirmFromBurnedEvent(e, planFor(e)) })
 */
export class BurnPairDualWrite {
  private readonly saga: OutboxSaga;
  private readonly clients: RoseChainClients;
  private readonly account: Account;

  constructor(deps: BurnPairDualWriteDeps) {
    this.saga = deps.saga;
    this.clients = deps.clients;
    this.account = deps.account;
  }

  /**
   * Authorizes (pre-submit, fail-closed), records the intent (PENDING) then submits the on-chain
   * `burnPair` (SUBMITTED, tx hash recorded). Idempotent on `idempotencyKey`: if the intent already
   * exists and is NOT `PENDING`, the existing row is returned WITHOUT re-broadcasting (so a retry /
   * key-reuse can never burn a duplicate package on-chain). Throws `BurnAuthorizationError` for a
   * non-`ALLOW` gate decision and `InvalidPairAmountError` for a bad amount — BEFORE any on-chain write.
   */
  async start(request: BurnPairRequest): Promise<BurnStartResult> {
    assertPairAmount(request.amount, 'Burn');

    // Fail-closed authorization BEFORE any on-chain burn (refusing after the chain burns would strand a
    // real retirement with no recordable ledger entry — an unrecoverable NFR-9 divergence).
    if (request.authorize) {
      const decision = request.authorize();
      if (decision.effect !== 'ALLOW') {
        console.warn('[burn] dual-write not authorized — no on-chain burn (fail-closed)', {
          coupledPairId: request.coupledPairId,
          effect: decision.effect,
          reason: decision.reason,
        });
        throw new BurnAuthorizationError(decision.effect, decision.reason);
      }
    }

    const payload: BurnPairIntent = {
      coupledPairId: request.coupledPairId,
      lFrom: request.lFrom,
      sFrom: request.sFrom,
      amount: request.amount.toString(), // decimal-integer string (NFR-2 — no float in jsonb)
    };
    burnPairIntentSchema.parse(payload); // fail fast on a malformed intent

    const intent = await this.saga.recordIntent({
      idempotencyKey: request.idempotencyKey,
      operationKind: 'PAIR_BURN',
      payload,
    });
    // Idempotent guard: a non-PENDING row means this dual-write was already started. Do NOT
    // re-broadcast (that would burn a duplicate package on-chain and lose the new hash).
    if (intent.status !== 'PENDING') {
      return {
        outbox: intent,
        txHash:
          intent.txHash != null && HEX_TX_HASH.test(intent.txHash) ? (intent.txHash as Hex) : null,
        alreadyStarted: true,
      };
    }

    const submitted = await this.saga.submit(intent.id, () =>
      submitBurnPair(this.clients, this.account, {
        pairAddress: request.pairAddress,
        lFrom: request.lFrom,
        sFrom: request.sFrom,
        amount: request.amount,
      }),
    );
    if (submitted.txHash == null || !HEX_TX_HASH.test(submitted.txHash)) {
      throw new Error('Outbox submission did not record a valid tx hash.');
    }
    return { outbox: submitted, txHash: submitted.txHash as Hex, alreadyStarted: false };
  }

  /**
   * THE COMMIT POINT: confirm a `PairBurned` event and post the balanced retirement entry exactly once.
   * The retired quantity is taken from `event.args` (the confirmed on-chain values — D3 / NFR-9). NEVER
   * throws into the watcher: a malformed confirm (divergence / bad plan / unbalanced) is caught, logged,
   * and surfaced as a `{ status: 'anomaly' }` outcome (the row stays SUBMITTED for reconcile 5.6).
   * Replaying the same confirmed event is a no-op (`{ status: 'noop' }`), via the 5.2 idempotent
   * `confirm`; an event with no matching outbox row yields `{ status: 'no-row' }`.
   */
  async confirmFromBurnedEvent(
    event: PairBurnedEvent,
    plan: BurnLedgerPlanT,
  ): Promise<BurnConfirmOutcome> {
    try {
      const result = await this.saga.confirmFromEvent(
        event,
        makeBurnPairLedgerEffect(event.args, plan),
      );
      if (result === null) {
        return { status: 'no-row' };
      }
      return result.applied
        ? { status: 'applied', row: result.row }
        : { status: 'noop', row: result.row };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn('[burn] confirm anomaly — left for reconcile (5.6), nothing posted', {
        txHash: event.transactionHash,
        error: err.message,
      });
      return { status: 'anomaly', error: err };
    }
  }
}
