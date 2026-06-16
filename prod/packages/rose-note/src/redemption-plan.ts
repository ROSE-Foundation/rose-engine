// Redemption → burn ledger plan (Story 6.3, AC-1). The INVERSE mirror of the 6.2
// `buildSubscriptionMintPlan`: derives the `@rose/chain` `BurnLedgerPlan` for a redemption so the
// COMMIT-POINT journal entry (posted by the 5.4 `makeBurnPairLedgerEffect`) captures BOTH the RETIRED
// token quantity AND the redemption value, EXTINGUISHING `NOTE_LIABILITY`.
//
// Account topology is CALLER-SUPPLIED (the established `BurnLedgerPlan` trust boundary — the
// composition layer supplies the concrete accounts; it does not invent a persisted leg→account
// mapping, deferred from 5.4/5.5). Two binding rules make the position reconcile against the chain:
//   1. each token-quantity HOLDER leg is an ASSET-classified account, so the RETIRED quantity reduces
//      ledger circulating quantity and reconciles to the on-chain `totalSupply` (NFR-9 / 5.5 — the
//      5.4 burn effect CREDITs the holder leg and DEBITs the supply contra, the inverse of a mint);
//   2. each token-quantity SUPPLY contra is a NON-ASSET account (LIABILITY/EQUITY), so it does NOT
//      affect the ASSET-side circulating sum.
// The VALUE leg books the redemption cash OUT of the VCC: DEBIT `NOTE_LIABILITY` (extinguish the
// issued-note obligation as the note is bought back), CREDIT a VCC ASSET cash account (the cash paid
// to the redeemer), EQUAL amount so the value leg balances per asset. This is the exact INVERSE of the
// 6.2 subscription value leg (which DEBITed cash, CREDITed `NOTE_LIABILITY`).
//
// PAPER 1:1 mapping (documented P0 interpretation): the RETIRED token quantity per leg equals the
// redemption's cash smallest-units `amount`. All amounts are integer `bigint` (NFR-2).
import { assertNotFloat } from '@rose/shared';
import type { BurnLedgerPlan } from '@rose/chain';

/**
 * Caller-supplied account topology for a redemption burn. The token-quantity holder accounts MUST be
 * ASSET-classified and the supply contras NON-ASSET (see module header); the cash account is a VCC
 * ASSET account in the payment asset and the note-liability account is `NOTE_LIABILITY` in the SAME
 * payment asset (so the value leg balances). The redemption mirror of `SubscriptionAccountTopology`.
 */
export interface RedemptionAccountTopology {
  /** ASSET account holding the long-leg quantity being RETIRED (CREDIT). */
  readonly longLegHolderAccountId: string;
  /** NON-ASSET contra balancing the retired long-leg quantity (DEBIT). */
  readonly longLegSupplyAccountId: string;
  /** ASSET account holding the short-leg quantity being RETIRED (CREDIT). */
  readonly shortLegHolderAccountId: string;
  /** NON-ASSET contra balancing the retired short-leg quantity (DEBIT). */
  readonly shortLegSupplyAccountId: string;
  /** VCC ASSET cash account in the payment asset — CREDITed by the outbound redemption cash. */
  readonly cashAccountId: string;
  /** VCC `NOTE_LIABILITY` account in the payment asset — DEBITed (the issued-note obligation extinguished). */
  readonly noteLiabilityAccountId: string;
}

/** Input to derive the redemption burn plan. */
export interface BuildRedemptionBurnPlanInput {
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  /** Redemption amount in smallest units — the retired token quantity AND the cash value (1:1 paper). */
  readonly amount: bigint;
  readonly topology: RedemptionAccountTopology;
}

/** Thrown when the redemption amount is structurally invalid (NFR-2). Maps to 422. */
export class InvalidRedemptionAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRedemptionAmountError';
  }
}

/**
 * Builds the `BurnLedgerPlan` for a redemption: the two token-quantity legs (holder/supply) plus the
 * VALUE leg (`NOTE_LIABILITY` DEBIT extinguished, cash CREDIT paid out) for the EXACT redemption
 * amount. The 5.4 `makeBurnPairLedgerEffect` posts ONE balanced entry from this plan at the commit
 * point (holder leg CREDITED, supply contra DEBITED from the on-chain amount) and runs its own
 * disjointness + per-(asset,scale) balance guards — the plan is built to satisfy them.
 */
export function buildRedemptionBurnPlan(input: BuildRedemptionBurnPlanInput): BurnLedgerPlan {
  // NFR-2: a JS number/float is never a valid amount; a non-positive redemption is meaningless.
  try {
    assertNotFloat(input.amount);
  } catch {
    throw new InvalidRedemptionAmountError(
      'Redemption amount must be a bigint in smallest units, never a binary float (NFR-2).',
    );
  }
  if (typeof input.amount !== 'bigint') {
    throw new InvalidRedemptionAmountError('Redemption amount must be a bigint in smallest units.');
  }
  if (input.amount <= 0n) {
    throw new InvalidRedemptionAmountError('Redemption amount must be a positive integer.');
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
      // The redemption economics: the issued-note obligation EXTINGUISHED (DEBIT NOTE_LIABILITY,
      // reducing the credit-normal balance) balanced by the outbound cash CREDITed from the VCC asset
      // account (same payment asset, equal amount). The INVERSE of the subscription value leg.
      postings: [
        { accountId: t.noteLiabilityAccountId, direction: 'DEBIT', amount: input.amount },
        { accountId: t.cashAccountId, direction: 'CREDIT', amount: input.amount },
      ],
    },
  };
}
