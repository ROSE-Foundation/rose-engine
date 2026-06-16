// Strategy reset → burn ledger plan + floor-threshold derivation (Story 6.4, FR-20, AC-1/AC-5).
//
// This module supplies the pure (network-free, DB-free) execution primitives the strategy executor
// composes: the floor-THRESHOLD derivation (a parked-parameter computation, NOT the Epic-7 leg-value
// model) and the reset `@rose/chain` `BurnLedgerPlan` whose VALUE postings crystallize the realized
// P&L tagged to the executing entity `TRADING_CO` (so it accrues to the consolidated group NAV, AC-1).
//
// BOUNDARY (binding): the coupled-coin reference math (`V_A=(K/2)(1±L·r)`) and the historical-tick
// rebalancing simulator are Epic 7 (THROWAWAY) and are NOT reimplemented here. The marked leg values
// are OPAQUE inputs supplied by the (paper) simulated price source. The only arithmetic here is the
// threshold PARAMETER `f = m·L·g` (addendum) applied to the pool — exact BigInt/decimal-string math,
// never a binary float (NFR-2).
//
// Account topology is CALLER-SUPPLIED (the established `PairLedgerPlan` trust boundary — the
// composition layer supplies the concrete accounts). All amounts are integer `bigint` smallest-units.
import { assertNotFloat } from '@rose/shared';
import type { BurnLedgerPlan } from '@rose/chain';

/** Thrown when a strategy reset amount / floor input is structurally invalid (NFR-2). Maps to 422. */
export class InvalidStrategyResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStrategyResetError';
  }
}

// Strict decimal string (optional sign, digits, optional fractional part) — no exponent, no float.
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Parses a non-negative decimal string into exact (digits, scale); rejects floats/sign/garbage. */
function parsePositiveDecimal(label: string, value: string): { digits: bigint; scale: number } {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value) || value.startsWith('-')) {
    throw new InvalidStrategyResetError(
      `${label} must be a positive decimal string (no float, no sign), got '${value}'.`,
    );
  }
  const [intPart = '0', fracPart = ''] = value.split('.');
  const digits = BigInt(intPart + fracPart);
  if (digits <= 0n) {
    throw new InvalidStrategyResetError(`${label} must be a positive decimal, got '${value}'.`);
  }
  return { digits, scale: fracPart.length };
}

/**
 * Derives the execution floor threshold in smallest-units: `floorUnits = ⌊(K/2)·f⌋`, where the floor
 * fraction `f = m·L·g` (addendum §threshold-only — `m` safety margin, `L` per-pair leverage, `g`
 * worst-plausible gap). Exact integer/decimal arithmetic (parse each decimal to (digits, scale),
 * multiply the digits, sum the scales, then integer-floor the division) — NO binary float (NFR-2).
 *
 * This is threshold-PARAMETER arithmetic applied at execution time. It does NOT compute leg values
 * from a price path (`V_A=(K/2)(1±L·r)`) — that model + its issuer-neutral proof are Epic 7 (throwaway).
 */
export function deriveFloorUnits(
  collateralPool: bigint,
  leverage: string,
  modelFloorM: string,
  modelFloorG: string,
): bigint {
  try {
    assertNotFloat(collateralPool);
  } catch {
    throw new InvalidStrategyResetError(
      'collateralPool (K) must be a bigint in smallest units, never a binary float (NFR-2).',
    );
  }
  if (typeof collateralPool !== 'bigint' || collateralPool <= 0n) {
    throw new InvalidStrategyResetError('collateralPool (K) must be a positive integer.');
  }
  const m = parsePositiveDecimal('modelFloorM', modelFloorM);
  const l = parsePositiveDecimal('leverage', leverage);
  const g = parsePositiveDecimal('modelFloorG', modelFloorG);

  const halfK = collateralPool / 2n;
  const productDigits = m.digits * l.digits * g.digits; // f numerator
  const productScale = m.scale + l.scale + g.scale; // f denominator = 10^productScale
  // floorUnits = ⌊ halfK · (productDigits / 10^productScale) ⌋ — integer floor, non-negative inputs.
  return (halfK * productDigits) / 10n ** BigInt(productScale);
}

/**
 * Caller-supplied account topology for a strategy reset burn. The token-quantity holder accounts MUST
 * be ASSET-classified and the supply contras NON-ASSET (so the retired reset-delta quantity reconciles
 * to the on-chain `totalSupply`, NFR-9 — mirror the 5.4/6.3 burn topology). The realized P&L is tagged
 * to the executing entity `TRADING_CO` via the two `tradingPnl*` accounts (a balanced DEBIT
 * `DEPLOYED_CAPITAL` / CREDIT `FEE_INCOME` pair in the payment asset), so the realized trading income
 * raises `TRADING_CO`'s equity and accrues to the consolidated group NAV (AC-1).
 */
export interface StrategyResetTopology {
  /** ASSET account holding the long-leg quantity being RETIRED at the reset (CREDIT). */
  readonly longLegHolderAccountId: string;
  /** NON-ASSET contra balancing the retired long-leg quantity (DEBIT). */
  readonly longLegSupplyAccountId: string;
  /** ASSET account holding the short-leg quantity being RETIRED at the reset (CREDIT). */
  readonly shortLegHolderAccountId: string;
  /** NON-ASSET contra balancing the retired short-leg quantity (DEBIT). */
  readonly shortLegSupplyAccountId: string;
  /** `TRADING_CO` ASSET account (`DEPLOYED_CAPITAL`) — DEBITed by the realized P&L (the deployed position). */
  readonly tradingPnlAssetAccountId: string;
  /** `TRADING_CO` EQUITY account (`FEE_INCOME`) — CREDITed by the realized P&L (raises group NAV). */
  readonly tradingPnlIncomeAccountId: string;
}

/** Input to derive the strategy reset burn plan. */
export interface BuildStrategyResetBurnPlanInput {
  /** Human-readable description persisted on the journal entry (audit trail). */
  readonly description: string;
  /**
   * The realized P&L crystallized at the reset, in the payment asset's smallest units (paper 1:1 with
   * the retired token quantity — the confirmed on-chain `amount`). The losing holder bears the loss;
   * the realized gain is recorded as `TRADING_CO` income (and is withdrawable).
   */
  readonly amount: bigint;
  readonly topology: StrategyResetTopology;
}

/**
 * Builds the `BurnLedgerPlan` for a threshold-only reset: the two token-quantity legs (holder/supply,
 * RETIRING the reset-delta quantity) plus the VALUE postings crystallizing the realized P&L tagged to
 * `TRADING_CO` (DEBIT `DEPLOYED_CAPITAL` / CREDIT `FEE_INCOME`, equal amount, same payment asset — so
 * the value group balances and the realized trading income accrues to the group NAV). The 5.4
 * `makeBurnPairLedgerEffect` posts ONE balanced entry from this plan at the on-chain commit point
 * (holder leg CREDITED, supply contra DEBITED from the confirmed on-chain amount) and runs its own
 * disjointness + per-(asset,scale) balance guards — the plan is built to satisfy them.
 */
export function buildStrategyResetBurnPlan(input: BuildStrategyResetBurnPlanInput): BurnLedgerPlan {
  // NFR-2: a JS number/float is never a valid amount; a non-positive realized P&L is meaningless.
  try {
    assertNotFloat(input.amount);
  } catch {
    throw new InvalidStrategyResetError(
      'Reset amount must be a bigint in smallest units, never a binary float (NFR-2).',
    );
  }
  if (typeof input.amount !== 'bigint') {
    throw new InvalidStrategyResetError('Reset amount must be a bigint in smallest units.');
  }
  if (input.amount <= 0n) {
    throw new InvalidStrategyResetError('Reset amount must be a positive integer.');
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
      // The realized P&L crystallization tagged to the executing entity TRADING_CO: DEBIT its deployed
      // capital (ASSET) and CREDIT its trading income (EQUITY) — equal amount, same payment asset, so
      // the value group balances and the realized income raises TRADING_CO equity → group NAV (AC-1).
      postings: [
        { accountId: t.tradingPnlAssetAccountId, direction: 'DEBIT', amount: input.amount },
        { accountId: t.tradingPnlIncomeAccountId, direction: 'CREDIT', amount: input.amount },
      ],
    },
  };
}
