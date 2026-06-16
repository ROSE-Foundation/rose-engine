// Story 6.4 — the pure (network-free, DB-free) strategy-plan primitives: the floor-THRESHOLD
// derivation and the reset `BurnLedgerPlan` with the TRADING_CO P&L crystallization. Test-first on
// the exact-arithmetic (NFR-2) and the balanced/tagged value postings (AC-1).
import { describe, expect, it } from 'vitest';
import {
  buildStrategyResetBurnPlan,
  deriveFloorUnits,
  InvalidStrategyResetError,
  type StrategyResetTopology,
} from './strategy-plan.js';

const TOPOLOGY: StrategyResetTopology = {
  longLegHolderAccountId: 'l-holder',
  longLegSupplyAccountId: 'l-supply',
  shortLegHolderAccountId: 's-holder',
  shortLegSupplyAccountId: 's-supply',
  tradingPnlAssetAccountId: 'tco-deployed-capital',
  tradingPnlIncomeAccountId: 'tco-fee-income',
};

describe('deriveFloorUnits — f = m·L·g applied to K/2 (exact, NFR-2)', () => {
  it('computes ⌊(K/2)·(m·L·g)⌋ with exact decimal arithmetic', () => {
    // K=20000 ⇒ K/2=10000; f = 0.5 · 3 · 0.4 = 0.6 ⇒ floorUnits = 6000.
    expect(deriveFloorUnits(20_000n, '3', '0.5', '0.4')).toBe(6000n);
  });

  it('floors a fractional result (no float, no rounding up)', () => {
    // K=10001 ⇒ K/2=5000 (integer); f = 0.1·1·0.1 = 0.01 ⇒ 5000·0.01 = 50.0 ⇒ 50.
    expect(deriveFloorUnits(10_001n, '1', '0.1', '0.1')).toBe(50n);
    // A genuinely fractional product floors down: K/2=5000, f=0.333 ⇒ 1665.0 → 1665.
    expect(deriveFloorUnits(10_000n, '1', '0.333', '1')).toBe(1665n);
  });

  it('refuses non-positive / float / malformed inputs (parked params never default, NFR-2/NFR-4)', () => {
    expect(() => deriveFloorUnits(0n, '3', '0.5', '0.4')).toThrow(InvalidStrategyResetError);
    expect(() => deriveFloorUnits(20_000n, '0', '0.5', '0.4')).toThrow(InvalidStrategyResetError);
    expect(() => deriveFloorUnits(20_000n, '3', '-0.5', '0.4')).toThrow(InvalidStrategyResetError);
    expect(() => deriveFloorUnits(20_000n, '3', 'abc', '0.4')).toThrow(InvalidStrategyResetError);
    // @ts-expect-error — a JS number K is never a valid smallest-units amount (NFR-2).
    expect(() => deriveFloorUnits(20000, '3', '0.5', '0.4')).toThrow(InvalidStrategyResetError);
  });
});

describe('buildStrategyResetBurnPlan — token legs + TRADING_CO P&L value postings (AC-1)', () => {
  it('builds the two token-quantity legs and a balanced TRADING_CO tag pair for the realized P&L', () => {
    const plan = buildStrategyResetBurnPlan({
      description: 'reset',
      amount: 5000n,
      topology: TOPOLOGY,
    });
    expect(plan.longLeg).toEqual({ holderAccountId: 'l-holder', supplyAccountId: 'l-supply' });
    expect(plan.shortLeg).toEqual({ holderAccountId: 's-holder', supplyAccountId: 's-supply' });
    // The realized P&L is tagged to TRADING_CO: DEBIT deployed capital, CREDIT fee income (equal).
    expect(plan.value!.postings).toEqual([
      { accountId: 'tco-deployed-capital', direction: 'DEBIT', amount: 5000n },
      { accountId: 'tco-fee-income', direction: 'CREDIT', amount: 5000n },
    ]);
    // The value postings balance (equal DEBIT/CREDIT amounts).
    const debit = plan
      .value!.postings.filter((p) => p.direction === 'DEBIT')
      .reduce((s, p) => s + p.amount, 0n);
    const credit = plan
      .value!.postings.filter((p) => p.direction === 'CREDIT')
      .reduce((s, p) => s + p.amount, 0n);
    expect(debit).toBe(credit);
  });

  it('rejects a non-positive / float reset amount (NFR-2)', () => {
    expect(() =>
      buildStrategyResetBurnPlan({ description: 'x', amount: 0n, topology: TOPOLOGY }),
    ).toThrow(InvalidStrategyResetError);
    expect(() =>
      buildStrategyResetBurnPlan({ description: 'x', amount: -1n, topology: TOPOLOGY }),
    ).toThrow(InvalidStrategyResetError);
    expect(() =>
      // @ts-expect-error — a JS number amount is never valid (NFR-2).
      buildStrategyResetBurnPlan({ description: 'x', amount: 5000, topology: TOPOLOGY }),
    ).toThrow(InvalidStrategyResetError);
  });
});
