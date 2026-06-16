// Paired-mint dual-write orchestration (Story 5.3, FR-18, NFR-9 / NFR-3). Wires the concrete
// `mintPair` on-chain write + the balanced-ledger recording onto the Story-5.2 `OutboxSaga`, so the
// on-chain `PairMinted` confirmation is the COMMIT POINT: the matching balanced journal entry is
// posted ONLY at confirmation, never at intent or submission.
//
// This module supplies the two ports the 5.2 saga was built to receive:
//   - `submitMintPair` — the saga `submit` for `PAIR_MINT`: calls the epic-4
//     `CoupledPair.mintPair(lTo, sTo, amount)` via the 5.1 `getWalletClient` seam (no key held here;
//     real broadcast is ops-deferred). `encodeMintPairCall` is the network-free calldata seam.
//   - `makeMintPairLedgerEffect` — the concrete `LedgerEffect`: at the commit point it posts ONE
//     balanced journal entry linked to the coupled pair (FR-13 `recordJournalEntry`), capturing the
//     minted token QUANTITY (taken from the CONFIRMED on-chain `PairMinted` args — chain = source of
//     truth, D3 / NFR-9) AND the notional VALUE.
//
// AUTHORIZATION ORDERING (code-review fix): a non-`ALLOW` authorization decision must veto the
// dual-write BEFORE the irreversible on-chain mint — refusing AFTER the chain has minted would strand
// real tokens with no recordable ledger entry (an unrecoverable NFR-9 divergence). So the fail-closed
// gate (the SAME default-deny decision `postTransfer` consults) runs in `start`, pre-submit; the
// commit-point effect records the confirmed on-chain quantity UNCONDITIONALLY (chain is authoritative).
//
// All amounts are integers (uint256 on-chain → `bigint` in TS → `NUMERIC` in the ledger); the outbox
// `payload` stores them as decimal-integer strings (NFR-2 — never a JS float).
import { encodeFunctionData, getAddress, type Account, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { z } from 'zod';
import type { OutboxEventRow, RecordPostingInput, RoseExecutor } from '@rose/ledger';
import { recordJournalEntry } from '@rose/ledger';
import { coupledPairAbi } from '../abis/coupled-pair-abi.js';
import type { RoseChainClients } from '../viem-clients.js';
import type { LedgerEffect } from '../outbox/outbox-saga.js';
import { OutboxSaga } from '../outbox/outbox-saga.js';
import type { PairMintedArgs, PairMintedEvent } from '../watchers.js';

/** uint256 upper bound — an amount above this is not a valid token quantity (rejected early). */
const MAX_UINT256 = 2n ** 256n - 1n;
const HEX_TX_HASH = /^0x[0-9a-fA-F]+$/;

// ---- On-chain write (the saga `submit` for PAIR_MINT) ----------------------------------------

/** The on-chain `mintPair` call coordinates: which pair, who receives each leg, and how much. */
export interface MintPairOnChainParams {
  readonly pairAddress: Address;
  readonly lTo: Address;
  readonly sTo: Address;
  /** Token quantity to mint on BOTH legs (uint256, NFR-2: bigint — never a JS number/float). */
  readonly amount: bigint;
}

/** Thrown when a mint amount is not a positive integer within uint256 range (NFR-2). */
export class InvalidMintAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMintAmountError';
  }
}

function assertMintAmount(amount: bigint): void {
  // A JS number/float is never a valid uint256 amount (NFR-2), a non-positive mint is meaningless,
  // and an amount above uint256 max cannot be minted — reject all three BEFORE any write.
  if (typeof amount !== 'bigint') {
    throw new InvalidMintAmountError(
      'Mint amount must be a bigint in token smallest units (NFR-2).',
    );
  }
  if (amount <= 0n) {
    throw new InvalidMintAmountError('Mint amount must be a positive integer.');
  }
  if (amount > MAX_UINT256) {
    throw new InvalidMintAmountError('Mint amount exceeds uint256 max.');
  }
}

/**
 * Encodes the `mintPair(lTo, sTo, amount)` calldata for the deployed `CoupledPair`. Pure + network-
 * free (deterministic) — the unit-test seam that proves the on-chain call shape without a wallet or
 * an RPC. Validates the amount (NFR-2) before encoding.
 */
export function encodeMintPairCall(params: MintPairOnChainParams): {
  readonly address: Address;
  readonly data: Hex;
} {
  assertMintAmount(params.amount);
  const data = encodeFunctionData({
    abi: coupledPairAbi,
    functionName: 'mintPair',
    args: [params.lTo, params.sTo, params.amount],
  });
  return { address: params.pairAddress, data };
}

/**
 * Submits the on-chain paired mint: `CoupledPair.mintPair(lTo, sTo, amount)` via the 5.1
 * `getWalletClient(account)` seam. Returns the broadcast tx hash (viem's `writeContract` resolves it
 * pre-mining). This package never holds or derives a private key — the caller supplies the `Account`;
 * the REAL Sepolia broadcast (funded RPC + out-of-band signer) is ops-deferred (see deferred-work.md
 * story-5.3). The saga records this hash (`PENDING -> SUBMITTED`); the commit point is the later
 * `PairMinted` confirmation, NOT this submission.
 */
export async function submitMintPair(
  clients: RoseChainClients,
  account: Account,
  params: MintPairOnChainParams,
): Promise<{ readonly txHash: Hex }> {
  assertMintAmount(params.amount);
  const walletClient = clients.getWalletClient(account);
  const txHash = await walletClient.writeContract({
    address: params.pairAddress,
    abi: coupledPairAbi,
    functionName: 'mintPair',
    args: [params.lTo, params.sTo, params.amount],
    account,
    chain: sepolia,
  });
  return { txHash };
}

// ---- The PAIR_MINT intent payload (persisted in the outbox) -----------------------------------

// A 20-byte EVM address (loose check; the on-chain write + viem validate strictly). Amounts are
// decimal-INTEGER strings (NFR-2: token smallest units, no fraction, no float).
const addressString = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte EVM address');
const integerAmountString = z
  .string()
  .regex(/^\d+$/, 'amount must be a non-negative integer decimal string (smallest units, NFR-2)');

/** The intent recorded in `outbox_events.payload` for a `PAIR_MINT`. Amounts are decimal strings. */
export const mintPairIntentSchema = z.object({
  coupledPairId: z.string().uuid(),
  lTo: addressString,
  sTo: addressString,
  amount: integerAmountString,
});
export type MintPairIntent = z.infer<typeof mintPairIntentSchema>;

// ---- Authorization gate (the postTransfer decision seam, consulted PRE-submit) ----------------

/** The terminal authorization decision (the SAME vocabulary the default-deny `postTransfer` uses). */
export interface MintAuthorizationDecision {
  readonly effect: 'ALLOW' | 'DENY' | 'REFUSE';
  readonly reason: string;
}

/**
 * The injected authorization gate for the dual-write — the SAME default-deny decision `postTransfer`
 * consults, bound (scenario + env + provider) by the caller into an opaque thunk. Keeping it a thunk
 * keeps `@rose/chain` decoupled from `@rose/authorization` (no new package edge, no cycle) — the port
 * pattern Story 5.2 established for `LedgerEffect`/`OutboxStore`. A future composition layer (Epic 6)
 * injects the real provider; tests inject a constant-effect gate.
 *
 * CONSULTED PRE-SUBMIT (in `start`): a non-`ALLOW` decision vetoes the dual-write BEFORE the on-chain
 * mint, so no tokens are minted and no ledger entry is needed (fail-closed, NFR-4). It is NOT consulted
 * at the commit point — once the chain has minted, the ledger MUST record it (chain is authoritative).
 */
export type MintAuthorizationGate = () => MintAuthorizationDecision;

/** Thrown when the injected authorization gate does not return `ALLOW` (fail-closed, NFR-4). */
export class MintAuthorizationError extends Error {
  readonly effect: 'DENY' | 'REFUSE';
  readonly reason: string;
  constructor(effect: 'DENY' | 'REFUSE', reason: string) {
    super(`Mint not authorized (${effect}): ${reason}`);
    this.name = 'MintAuthorizationError';
    this.effect = effect;
    this.reason = reason;
  }
}

// ---- The concrete LedgerEffect (the commit-point balanced entry) ------------------------------

/** Token-quantity accounts for one minted leg — both MUST be the same token asset so the leg balances. */
export interface MintLegAccounts {
  /** Receives the minted quantity (DEBIT). */
  readonly holderAccountId: string;
  /** Token supply contra (CREDIT) — the minted quantity is balanced against the supply account. */
  readonly supplyAccountId: string;
}

/** The notional VALUE leg of a mint: balanced value postings recorded alongside the quantity. */
export interface MintValuePlan {
  /** Value postings (balanced within their own asset); the notional recorded alongside the quantity. */
  readonly postings: ReadonlyArray<RecordPostingInput>;
}

/**
 * Caller-supplied ledger topology for a mint (the established `postTransfer`/`issueCoupledPair`
 * caller-supplied-facts trust boundary — 5.3 does NOT invent which concrete accounts hold the legs).
 * The token-quantity legs (long/short) are always BOTH posted from the single on-chain amount; the
 * optional VALUE leg records the notional alongside them in the same balanced entry.
 */
export interface MintLedgerPlan {
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  readonly longLeg: MintLegAccounts;
  readonly shortLeg: MintLegAccounts;
  readonly value?: MintValuePlan;
}

/** Thrown when the confirmed on-chain mint diverges from the recorded intent (amount or recipient, NFR-9). */
export class MintQuantityDivergenceError extends Error {
  readonly field: 'amount' | 'lTo' | 'sTo';
  readonly onChain: string;
  readonly intended: string;
  constructor(field: 'amount' | 'lTo' | 'sTo', onChain: string, intended: string) {
    super(
      `Mint ${field} divergence: confirmed on-chain ${field} ${onChain} != recorded intent ${intended}. ` +
        `Chain is the source of truth (D3); leaving for reconcile (5.6).`,
    );
    this.name = 'MintQuantityDivergenceError';
    this.field = field;
    this.onChain = onChain;
    this.intended = intended;
  }
}

/** Thrown when a mint plan's accounts overlap so the per-asset balance would silently net (NFR-9). */
export class MintPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintPlanError';
  }
}

// Guards a plan against account overlaps that recordJournalEntry's per-(asset,scale) netting would
// hide: the four quantity-leg accounts must be pairwise distinct, and no value posting may target a
// quantity-leg account (else a value posting could silently cancel a recorded mint quantity — the
// amount cross-check would still "pass" while the holder's net quantity is wrong). Same-asset/different-
// account leg collisions across legs are a residual caller-supplied-plan trust boundary (documented).
function assertPlanAccountsDisjoint(plan: MintLedgerPlan): void {
  const quantityAccounts = [
    plan.longLeg.holderAccountId,
    plan.longLeg.supplyAccountId,
    plan.shortLeg.holderAccountId,
    plan.shortLeg.supplyAccountId,
  ];
  if (new Set(quantityAccounts).size !== quantityAccounts.length) {
    throw new MintPlanError('Mint quantity-leg accounts must be pairwise distinct.');
  }
  if (plan.value) {
    const quantitySet = new Set(quantityAccounts);
    for (const p of plan.value.postings) {
      if (quantitySet.has(p.accountId)) {
        throw new MintPlanError(
          `Value posting account '${p.accountId}' collides with a quantity-leg account (would net the recorded quantity).`,
        );
      }
    }
  }
}

/**
 * Builds the concrete mint `LedgerEffect` for a CONFIRMED `PairMinted`. Invoked by the 5.2 saga ONLY
 * at the commit point, inside the confirm transaction (atomic with the `SUBMITTED -> CONFIRMED` flip
 * and the `journal_entries.tx_hash` stamp). It:
 *   1. binds NFR-9 — the recorded token quantity IS the confirmed on-chain `amount` (D3), and the
 *      confirmed `lTo`/`sTo`/`amount` are cross-checked against the recorded intent, throwing
 *      `MintQuantityDivergenceError` on any mismatch (nothing posted — a reconcile-5.6 signal);
 *   2. guards the plan against account overlaps that would silently net the quantity (`MintPlanError`);
 *   3. posts ONE balanced journal entry (FR-13) linked to the coupled pair: BOTH leg-quantity
 *      postings (from `onChainArgs.amount`) + the optional value postings. Both legs are ALWAYS posted
 *      from the single amount — there is no path to a single-leg ledger record (mirrors the atomic
 *      on-chain `mintPair`; the contract + 4.3 coupling guard are the source-of-truth backstop).
 *
 * Authorization is NOT consulted here — it is enforced pre-submit (see `MintAuthorizationGate`). The
 * effect throws on divergence/plan/amount errors; the watcher-facing `confirmFromMintedEvent` CATCHES
 * those so a malformed confirm never escapes into the (fire-and-forget) watcher.
 */
export function makeMintPairLedgerEffect(
  onChainArgs: PairMintedArgs,
  plan: MintLedgerPlan,
): LedgerEffect {
  return async (executor: RoseExecutor, ctx): Promise<{ journalEntryId: string }> => {
    assertMintAmount(onChainArgs.amount);

    // The payload is the recorded intent (decimal-string amounts, NFR-2). Validate + cross-check
    // EVERY load-bearing field against the confirmed on-chain event (chain = source of truth, D3).
    const intent = mintPairIntentSchema.parse(ctx.payload);
    const intendedAmount = BigInt(intent.amount);
    if (intendedAmount !== onChainArgs.amount) {
      console.warn('[mint] quantity divergence — posting nothing (reconcile 5.6)', {
        coupledPairId: intent.coupledPairId,
        onChainAmount: onChainArgs.amount.toString(),
        intendedAmount: intendedAmount.toString(),
        txHash: ctx.txHash,
      });
      throw new MintQuantityDivergenceError(
        'amount',
        onChainArgs.amount.toString(),
        intendedAmount.toString(),
      );
    }
    if (getAddress(intent.lTo) !== getAddress(onChainArgs.lTo)) {
      throw new MintQuantityDivergenceError(
        'lTo',
        getAddress(onChainArgs.lTo),
        getAddress(intent.lTo),
      );
    }
    if (getAddress(intent.sTo) !== getAddress(onChainArgs.sTo)) {
      throw new MintQuantityDivergenceError(
        'sTo',
        getAddress(onChainArgs.sTo),
        getAddress(intent.sTo),
      );
    }

    assertPlanAccountsDisjoint(plan);

    // ONE balanced entry: both leg quantities (from the on-chain amount, NFR-9) + value postings.
    // recordJournalEntry enforces per-(asset, scale) balance + the DB double-entry trigger backstop,
    // so a mis-asseted leg is rejected and nothing persists (fail-safe).
    const postings: RecordPostingInput[] = [
      { accountId: plan.longLeg.holderAccountId, direction: 'DEBIT', amount: onChainArgs.amount },
      { accountId: plan.longLeg.supplyAccountId, direction: 'CREDIT', amount: onChainArgs.amount },
      { accountId: plan.shortLeg.holderAccountId, direction: 'DEBIT', amount: onChainArgs.amount },
      { accountId: plan.shortLeg.supplyAccountId, direction: 'CREDIT', amount: onChainArgs.amount },
      ...(plan.value?.postings ?? []),
    ];

    const entry = await recordJournalEntry(executor, {
      description: plan.description,
      coupledPairId: intent.coupledPairId,
      postings,
    });
    console.info('[mint] recorded balanced mint entry at commit point', {
      coupledPairId: intent.coupledPairId,
      journalEntryId: entry.entry.id,
      quantity: onChainArgs.amount.toString(),
      txHash: ctx.txHash,
    });
    return { journalEntryId: entry.entry.id };
  };
}

// ---- The mint orchestration (intent -> submit -> confirm-from-event) --------------------------

/** A request to mint a coupled pair on-chain and record it in the ledger. */
export interface MintPairRequest {
  /** Idempotency key for the dual-write (exactly-once intent — NFR-9). */
  readonly idempotencyKey: string;
  readonly coupledPairId: string;
  readonly pairAddress: Address;
  readonly lTo: Address;
  readonly sTo: Address;
  /** Token quantity to mint on BOTH legs (uint256, NFR-2: bigint). */
  readonly amount: bigint;
  /**
   * Fail-closed authorization gate (the `postTransfer` decision seam), consulted PRE-submit. If
   * supplied and it does not return `ALLOW`, the dual-write is vetoed before any on-chain mint
   * (`MintAuthorizationError`, nothing recorded). Production MUST inject the default-deny provider.
   */
  readonly authorize?: MintAuthorizationGate;
}

export interface MintPairDualWriteDeps {
  readonly saga: OutboxSaga;
  readonly clients: RoseChainClients;
  /** The signing account for the `mintPair` write (out-of-band; never derived here). */
  readonly account: Account;
}

/** The result of `start`: the outbox row, its recorded tx hash (null only for a non-submitted row). */
export interface MintStartResult {
  readonly outbox: OutboxEventRow;
  readonly txHash: Hex | null;
  /** True when an existing (already-submitted) intent was returned without re-broadcasting. */
  readonly alreadyStarted: boolean;
}

/** The outcome of a commit-point confirmation — never throws into the (fire-and-forget) watcher. */
export type MintConfirmOutcome =
  | { readonly status: 'applied'; readonly row: OutboxEventRow }
  | { readonly status: 'noop'; readonly row: OutboxEventRow }
  | { readonly status: 'no-row' }
  | { readonly status: 'anomaly'; readonly error: Error };

/**
 * The paired-mint dual-write orchestrator. `start` authorizes (pre-submit, fail-closed), records the
 * `PAIR_MINT` intent (PENDING) and submits the on-chain `mintPair` tx (SUBMITTED) — NO ledger effect
 * yet (submission is not the commit point). `confirmFromMintedEvent` is the COMMIT POINT wiring: on a
 * confirmed `PairMinted` `ChainEvent`, it posts the balanced entry exactly once (idempotent under
 * re-delivery via the 5.2 saga) and NEVER throws into the watcher. Intended live wiring:
 *
 *   watchPairEvents(clients, { pairAddress, onPairMinted: (e) => void mint.confirmFromMintedEvent(e, planFor(e)) })
 */
export class MintPairDualWrite {
  private readonly saga: OutboxSaga;
  private readonly clients: RoseChainClients;
  private readonly account: Account;

  constructor(deps: MintPairDualWriteDeps) {
    this.saga = deps.saga;
    this.clients = deps.clients;
    this.account = deps.account;
  }

  /**
   * Authorizes (pre-submit, fail-closed), records the intent (PENDING) then submits the on-chain
   * `mintPair` (SUBMITTED, tx hash recorded). Idempotent on `idempotencyKey`: if the intent already
   * exists and is NOT `PENDING`, the existing row is returned WITHOUT re-broadcasting (so a retry /
   * key-reuse can never mint a duplicate pair on-chain). Throws `MintAuthorizationError` for a
   * non-`ALLOW` gate decision and `InvalidMintAmountError` for a bad amount — BEFORE any on-chain write.
   */
  async start(request: MintPairRequest): Promise<MintStartResult> {
    assertMintAmount(request.amount);

    // Fail-closed authorization BEFORE any on-chain mint (refusing after the chain mints would strand
    // tokens with no recordable ledger entry — an unrecoverable NFR-9 divergence).
    if (request.authorize) {
      const decision = request.authorize();
      if (decision.effect !== 'ALLOW') {
        console.warn('[mint] dual-write not authorized — no on-chain mint (fail-closed)', {
          coupledPairId: request.coupledPairId,
          effect: decision.effect,
          reason: decision.reason,
        });
        throw new MintAuthorizationError(decision.effect, decision.reason);
      }
    }

    const payload: MintPairIntent = {
      coupledPairId: request.coupledPairId,
      lTo: request.lTo,
      sTo: request.sTo,
      amount: request.amount.toString(), // decimal-integer string (NFR-2 — no float in jsonb)
    };
    mintPairIntentSchema.parse(payload); // fail fast on a malformed intent

    const intent = await this.saga.recordIntent({
      idempotencyKey: request.idempotencyKey,
      operationKind: 'PAIR_MINT',
      payload,
    });
    // Idempotent guard: a non-PENDING row means this dual-write was already started. Do NOT
    // re-broadcast (that would mint a duplicate pair on-chain and lose the new hash).
    if (intent.status !== 'PENDING') {
      return {
        outbox: intent,
        txHash:
          intent.txHash != null && HEX_TX_HASH.test(intent.txHash) ? (intent.txHash as Hex) : null,
        alreadyStarted: true,
      };
    }

    const submitted = await this.saga.submit(intent.id, () =>
      submitMintPair(this.clients, this.account, {
        pairAddress: request.pairAddress,
        lTo: request.lTo,
        sTo: request.sTo,
        amount: request.amount,
      }),
    );
    if (submitted.txHash == null || !HEX_TX_HASH.test(submitted.txHash)) {
      throw new Error('Outbox submission did not record a valid tx hash.');
    }
    return { outbox: submitted, txHash: submitted.txHash as Hex, alreadyStarted: false };
  }

  /**
   * THE COMMIT POINT: confirm a `PairMinted` event and post the balanced entry exactly once. The
   * recorded quantity is taken from `event.args` (the confirmed on-chain values — D3 / NFR-9).
   * NEVER throws into the watcher: a malformed confirm (divergence / bad plan / unbalanced) is caught,
   * logged, and surfaced as a `{ status: 'anomaly' }` outcome (the row stays SUBMITTED for reconcile
   * 5.6). Replaying the same confirmed event is a no-op (`{ status: 'noop' }`), via the 5.2 idempotent
   * `confirm`; an event with no matching outbox row yields `{ status: 'no-row' }`.
   */
  async confirmFromMintedEvent(
    event: PairMintedEvent,
    plan: MintLedgerPlan,
  ): Promise<MintConfirmOutcome> {
    try {
      const result = await this.saga.confirmFromEvent(
        event,
        makeMintPairLedgerEffect(event.args, plan),
      );
      if (result === null) {
        return { status: 'no-row' };
      }
      return result.applied
        ? { status: 'applied', row: result.row }
        : { status: 'noop', row: result.row };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn('[mint] confirm anomaly — left for reconcile (5.6), nothing posted', {
        txHash: event.transactionHash,
        error: err.message,
      });
      return { status: 'anomaly', error: err };
    }
  }
}
