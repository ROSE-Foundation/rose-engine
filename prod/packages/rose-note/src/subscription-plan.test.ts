// Story 6.2 — the subscription → mint ledger plan. Pure unit: the value leg books cash DEBIT +
// NOTE_LIABILITY CREDIT for the exact amount (balanced), the quantity legs map the topology, and a
// bad amount is rejected (NFR-2).
import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionMintPlan,
  InvalidSubscriptionAmountError,
  type SubscriptionAccountTopology,
} from './subscription-plan.js';

const TOPOLOGY: SubscriptionAccountTopology = {
  longLegHolderAccountId: 'l-holder',
  longLegSupplyAccountId: 'l-supply',
  shortLegHolderAccountId: 's-holder',
  shortLegSupplyAccountId: 's-supply',
  cashAccountId: 'vcc-backing-float',
  noteLiabilityAccountId: 'vcc-note-liability',
};

describe('buildSubscriptionMintPlan', () => {
  it('maps the quantity legs and books the value leg (cash DEBIT, NOTE_LIABILITY CREDIT, equal amount)', () => {
    const plan = buildSubscriptionMintPlan({
      description: 'subscribe',
      amount: 10_000n,
      topology: TOPOLOGY,
    });
    expect(plan.longLeg).toEqual({ holderAccountId: 'l-holder', supplyAccountId: 'l-supply' });
    expect(plan.shortLeg).toEqual({ holderAccountId: 's-holder', supplyAccountId: 's-supply' });
    expect(plan.value?.postings).toEqual([
      { accountId: 'vcc-backing-float', direction: 'DEBIT', amount: 10_000n },
      { accountId: 'vcc-note-liability', direction: 'CREDIT', amount: 10_000n },
    ]);
    // The value leg balances within its asset: equal DEBIT and CREDIT, both bigint (NFR-2).
    const [debit, credit] = plan.value!.postings;
    expect(debit!.amount).toBe(credit!.amount);
    expect(typeof debit!.amount).toBe('bigint');
  });

  it('rejects a non-positive amount (NFR-2)', () => {
    expect(() =>
      buildSubscriptionMintPlan({ description: 's', amount: 0n, topology: TOPOLOGY }),
    ).toThrow(InvalidSubscriptionAmountError);
  });

  it('rejects a non-bigint amount (NFR-2)', () => {
    expect(() =>
      // @ts-expect-error — a JS number money value is never valid
      buildSubscriptionMintPlan({ description: 's', amount: 100, topology: TOPOLOGY }),
    ).toThrow(InvalidSubscriptionAmountError);
  });
});
