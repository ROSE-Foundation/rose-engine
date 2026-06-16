// Shared, asset-direction-agnostic primitives for the paired dual-write modules (Story 5.4, factored
// from the Story-5.3 mint pattern). Both the paired-MINT (5.3) and paired-BURN (5.4) dual-writes need
// the same amount / plan / authorization guards; this module is the canonical home so the burn module
// REUSES them rather than copy-pasting the mint internals.
//
// NOTE (deferred clean-up): the Story-5.3 mint module still carries its own copies of these helpers.
// Retrofitting `mint-pair.ts` onto this shared home is intentionally NOT done here — it would touch the
// already-`done` Story 5.3 and risk a regression for zero 5.4 benefit. Recorded in deferred-work.md.
//
// All amounts are integers (uint256 on-chain → `bigint` in TS → `NUMERIC` in the ledger); the outbox
// `payload` stores them as decimal-integer strings (NFR-2 — never a JS float).
import { z } from 'zod';
import type { RecordPostingInput } from '@rose/ledger';

/** uint256 upper bound — an amount above this is not a valid token quantity (rejected early). */
export const MAX_UINT256 = 2n ** 256n - 1n;
/** A 0x-prefixed hex tx-hash shape (defensive validation before a viem `Hex` cast). */
export const HEX_TX_HASH = /^0x[0-9a-fA-F]+$/;

// A 20-byte EVM address (loose check; the on-chain write + viem validate strictly). Amounts are
// decimal-INTEGER strings (NFR-2: token smallest units, no fraction, no float).
export const addressString = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte EVM address');
export const integerAmountString = z
  .string()
  .regex(/^\d+$/, 'amount must be a non-negative integer decimal string (smallest units, NFR-2)');

/** Thrown when a pair (mint/burn) amount is not a positive integer within uint256 range (NFR-2). */
export class InvalidPairAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPairAmountError';
  }
}

/**
 * Validates a pair (mint/burn) token amount BEFORE any on-chain write or ledger posting (NFR-2): a JS
 * number/float is never a valid uint256, a non-positive amount is meaningless, and an amount above
 * uint256 max cannot be minted/burned. `verb` only customizes the thrown message.
 */
export function assertPairAmount(amount: bigint, verb: 'Mint' | 'Burn'): void {
  if (typeof amount !== 'bigint') {
    throw new InvalidPairAmountError(
      `${verb} amount must be a bigint in token smallest units (NFR-2).`,
    );
  }
  if (amount <= 0n) {
    throw new InvalidPairAmountError(`${verb} amount must be a positive integer.`);
  }
  if (amount > MAX_UINT256) {
    throw new InvalidPairAmountError(`${verb} amount exceeds uint256 max.`);
  }
}

/** The terminal authorization decision (the SAME vocabulary the default-deny `postTransfer` uses). */
export interface PairAuthorizationDecision {
  readonly effect: 'ALLOW' | 'DENY' | 'REFUSE';
  readonly reason: string;
}

/**
 * The injected authorization gate for a paired dual-write — the SAME default-deny decision
 * `postTransfer` consults, bound (scenario + env + provider) by the caller into an opaque thunk.
 * Keeping it a thunk keeps `@rose/chain` decoupled from `@rose/authorization` (no new package edge, no
 * cycle) — the port pattern Story 5.2 established. CONSULTED PRE-SUBMIT: a non-`ALLOW` decision vetoes
 * the dual-write BEFORE the irreversible on-chain mint/burn (fail-closed, NFR-4); it is NEVER consulted
 * at the commit point — once the chain has acted, the ledger MUST record it (chain is authoritative).
 */
export type PairAuthorizationGate = () => PairAuthorizationDecision;

/** Token-quantity accounts for one pair leg — both MUST be the same token asset so the leg balances. */
export interface PairLegAccounts {
  readonly holderAccountId: string;
  readonly supplyAccountId: string;
}

/** The notional VALUE leg of a pair operation: balanced value postings recorded alongside quantity. */
export interface PairValuePlan {
  /** Value postings (balanced within their own asset); the notional recorded alongside the quantity. */
  readonly postings: ReadonlyArray<RecordPostingInput>;
}

/**
 * Caller-supplied ledger topology shared by mint/burn (the established `postTransfer`/
 * `issueCoupledPair` caller-supplied-facts trust boundary). The token-quantity legs (long/short) are
 * always BOTH posted from the single on-chain amount; the optional VALUE leg records the notional
 * alongside them in the same balanced entry. The quantity-posting DIRECTION (mint vs burn) is the
 * caller-effect's concern, not this shape's.
 */
export interface PairLedgerPlan {
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  readonly longLeg: PairLegAccounts;
  readonly shortLeg: PairLegAccounts;
  readonly value?: PairValuePlan;
}

/** Thrown when a plan's accounts overlap so the per-asset balance would silently net (NFR-9). */
export class PairPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairPlanError';
  }
}

// Guards a plan against account overlaps that recordJournalEntry's per-(asset,scale) netting would
// hide: the four quantity-leg accounts must be pairwise distinct, and no value posting may target a
// quantity-leg account (else a value posting could silently cancel a recorded quantity — the amount
// cross-check would still "pass" while the holder's net quantity is wrong). Same-asset/different-
// account leg collisions across legs are a residual caller-supplied-plan trust boundary (documented).
export function assertPairPlanAccountsDisjoint(plan: PairLedgerPlan): void {
  const quantityAccounts = [
    plan.longLeg.holderAccountId,
    plan.longLeg.supplyAccountId,
    plan.shortLeg.holderAccountId,
    plan.shortLeg.supplyAccountId,
  ];
  if (new Set(quantityAccounts).size !== quantityAccounts.length) {
    throw new PairPlanError('Pair quantity-leg accounts must be pairwise distinct.');
  }
  if (plan.value) {
    const quantitySet = new Set(quantityAccounts);
    for (const p of plan.value.postings) {
      if (quantitySet.has(p.accountId)) {
        throw new PairPlanError(
          `Value posting account '${p.accountId}' collides with a quantity-leg account (would net the recorded quantity).`,
        );
      }
    }
  }
}
