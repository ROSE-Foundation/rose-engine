// Subscription → mint ledger plan (Story 6.2, AC-1). Derives the `@rose/chain` `MintLedgerPlan` for
// a subscription so the COMMIT-POINT journal entry (posted by the 5.3 `makeMintPairLedgerEffect`)
// captures BOTH the minted token quantity AND the subscription value, touching `NOTE_LIABILITY`.
//
// Account topology is CALLER-SUPPLIED (the established `MintLedgerPlan` trust boundary — the
// composition layer supplies the concrete accounts; it does not invent a persisted leg→account
// mapping, deferred from 5.3/5.5). Two binding rules make the position reconcile against the chain:
//   1. each token-quantity HOLDER leg is an ASSET-classified account, so the minted quantity counts
//      as ledger circulating quantity and reconciles to the on-chain `totalSupply` (NFR-9 / 5.5);
//   2. each token-quantity SUPPLY contra is a NON-ASSET account (LIABILITY/EQUITY), so it does NOT
//      subtract from the ASSET-side circulating sum.
// The VALUE leg books the subscriber's cash into the VCC: DEBIT a VCC ASSET cash account, CREDIT
// `NOTE_LIABILITY` (the issued-note obligation), EQUAL amount so the value leg balances per asset.
//
// PAPER 1:1 mapping (documented P0 interpretation): the minted token quantity per leg equals the
// subscription's cash smallest-units `amount`. All amounts are integer `bigint` (NFR-2).
import { assertNotFloat } from '@rose/shared';
import type { MintLedgerPlan } from '@rose/chain';

/**
 * Caller-supplied account topology for a subscription mint. The token-quantity holder accounts MUST
 * be ASSET-classified and the supply contras NON-ASSET (see module header); the cash account is a
 * VCC ASSET account in the payment asset and the note-liability account is `NOTE_LIABILITY` in the
 * SAME payment asset (so the value leg balances).
 */
export interface SubscriptionAccountTopology {
  /** ASSET account receiving the minted long-leg quantity (DEBIT). */
  readonly longLegHolderAccountId: string;
  /** NON-ASSET contra balancing the minted long-leg quantity (CREDIT). */
  readonly longLegSupplyAccountId: string;
  /** ASSET account receiving the minted short-leg quantity (DEBIT). */
  readonly shortLegHolderAccountId: string;
  /** NON-ASSET contra balancing the minted short-leg quantity (CREDIT). */
  readonly shortLegSupplyAccountId: string;
  /** VCC ASSET cash account in the payment asset — DEBITed by the inbound subscription cash. */
  readonly cashAccountId: string;
  /** VCC `NOTE_LIABILITY` account in the payment asset — CREDITed (the issued-note obligation). */
  readonly noteLiabilityAccountId: string;
}

/** Input to derive the subscription mint plan. */
export interface BuildSubscriptionMintPlanInput {
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  /** Subscription amount in smallest units — the minted token quantity AND the cash value (1:1 paper). */
  readonly amount: bigint;
  readonly topology: SubscriptionAccountTopology;
}

/** Thrown when the subscription amount is structurally invalid (NFR-2). */
export class InvalidSubscriptionAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSubscriptionAmountError';
  }
}

/**
 * Builds the `MintLedgerPlan` for a subscription: the two token-quantity legs (holder/supply) plus
 * the VALUE leg (cash DEBIT, `NOTE_LIABILITY` CREDIT) for the EXACT subscription amount. The 5.3
 * `makeMintPairLedgerEffect` posts ONE balanced entry from this plan at the commit point and runs its
 * own disjointness + per-(asset,scale) balance guards — the plan is built to satisfy them.
 */
export function buildSubscriptionMintPlan(input: BuildSubscriptionMintPlanInput): MintLedgerPlan {
  // NFR-2: a JS number/float is never a valid amount; a non-positive subscription is meaningless.
  try {
    assertNotFloat(input.amount);
  } catch {
    throw new InvalidSubscriptionAmountError(
      'Subscription amount must be a bigint in smallest units, never a binary float (NFR-2).',
    );
  }
  if (typeof input.amount !== 'bigint') {
    throw new InvalidSubscriptionAmountError(
      'Subscription amount must be a bigint in smallest units.',
    );
  }
  if (input.amount <= 0n) {
    throw new InvalidSubscriptionAmountError('Subscription amount must be a positive integer.');
  }

  const t = input.topology;
  return {
    description: input.description,
    longLeg: {
      holderAccountId: t.longLegHolderAccountId,
      supplyAccountId: t.longLegSupplyAccountId,
    },
    shortLeg: {
      holderAccountId: t.shortLegHolderAccountId,
      supplyAccountId: t.shortLegSupplyAccountId,
    },
    value: {
      // The subscription economics: inbound cash DEBITed to the VCC asset account, balanced by the
      // issued-note obligation CREDITed to NOTE_LIABILITY (same payment asset, equal amount).
      postings: [
        { accountId: t.cashAccountId, direction: 'DEBIT', amount: input.amount },
        { accountId: t.noteLiabilityAccountId, direction: 'CREDIT', amount: input.amount },
      ],
    },
  };
}
