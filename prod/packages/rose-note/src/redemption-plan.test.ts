// Story 6.3 — the redemption → burn ledger plan. Pure unit: the value leg EXTINGUISHES the note
// (NOTE_LIABILITY DEBIT + cash CREDIT for the exact amount, balanced — the INVERSE of the 6.2
// subscription value leg), the quantity legs map the topology, and a bad amount is rejected (NFR-2).
import { describe, expect, it } from 'vitest';
import {
  buildRedemptionBurnPlan,
  InvalidRedemptionAmountError,
  type RedemptionAccountTopology,
} from './redemption-plan.js';

const TOPOLOGY: RedemptionAccountTopology = {
  longLegHolderAccountId: 'l-holder',
  longLegSupplyAccountId: 'l-supply',
  shortLegHolderAccountId: 's-holder',
  shortLegSupplyAccountId: 's-supply',
  cashAccountId: 'vcc-backing-float',
  noteLiabilityAccountId: 'vcc-note-liability',
};

describe('buildRedemptionBurnPlan', () => {
  it('maps the quantity legs and books the value leg (NOTE_LIABILITY DEBIT extinguished, cash CREDIT, equal amount)', () => {
    const plan = buildRedemptionBurnPlan({
      description: 'redeem',
      amount: 10_000n,
      topology: TOPOLOGY,
    });
    expect(plan.longLeg).toEqual({ holderAccountId: 'l-holder', supplyAccountId: 'l-supply' });
    expect(plan.shortLeg).toEqual({ holderAccountId: 's-holder', supplyAccountId: 's-supply' });
    // INVERSE of subscription: NOTE_LIABILITY is DEBITed (extinguished), cash is CREDITed (paid out).
    expect(plan.value?.postings).toEqual([
      { accountId: 'vcc-note-liability', direction: 'DEBIT', amount: 10_000n },
      { accountId: 'vcc-backing-float', direction: 'CREDIT', amount: 10_000n },
    ]);
    // The value leg balances within its asset: equal DEBIT and CREDIT, both bigint (NFR-2).
    const [debit, credit] = plan.value!.postings;
    expect(debit!.amount).toBe(credit!.amount);
    expect(typeof debit!.amount).toBe('bigint');
  });

  it('rejects a non-positive amount (NFR-2)', () => {
    expect(() =>
      buildRedemptionBurnPlan({ description: 'r', amount: 0n, topology: TOPOLOGY }),
    ).toThrow(InvalidRedemptionAmountError);
  });

  it('rejects a non-bigint amount (NFR-2)', () => {
    expect(() =>
      // @ts-expect-error — a JS number money value is never valid
      buildRedemptionBurnPlan({ description: 'r', amount: 100, topology: TOPOLOGY }),
    ).toThrow(InvalidRedemptionAmountError);
  });
});
