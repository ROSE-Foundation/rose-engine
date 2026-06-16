// Story 5.5 — the @rose/reconcile public surface resolves (no network, no DB).
import { describe, expect, it } from 'vitest';
import * as reconcile from './index.js';

describe('@rose/reconcile public surface', () => {
  it('re-exports the group-view builder, renderer, serialisers, and chain-supply seam', () => {
    expect(typeof reconcile.buildGroupView).toBe('function');
    expect(typeof reconcile.renderGroupViewText).toBe('function');
    expect(typeof reconcile.serializeGroupView).toBe('function');
    expect(typeof reconcile.groupViewToJson).toBe('function');
    expect(typeof reconcile.loadChainSupplySnapshot).toBe('function');
  });

  it('exposes the documented account NAV classification for all five fixed account types', () => {
    expect(Object.keys(reconcile.ACCOUNT_NAV_CLASSIFICATION).sort()).toEqual(
      [
        'BACKING_FLOAT',
        'CLIENT_COLLATERAL',
        'DEPLOYED_CAPITAL',
        'FEE_INCOME',
        'NOTE_LIABILITY',
      ].sort(),
    );
    expect(reconcile.ACCOUNT_NAV_CLASSIFICATION.BACKING_FLOAT).toEqual({
      normalSide: 'DEBIT',
      navRole: 'ASSET',
    });
    expect(reconcile.ENTITY_DISPLAY_ORDER).toEqual(['VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER']);
  });

  it('re-exports the Story-5.6 reconcile-and-correct surface and finality helpers', () => {
    expect(typeof reconcile.reconcileLedgerToChain).toBe('function');
    expect(typeof reconcile.reconciliationReportToJson).toBe('function');
    expect(typeof reconcile.serializeReconciliationReport).toBe('function');
    expect(typeof reconcile.renderReconciliationText).toBe('function');
    expect(typeof reconcile.isFinal).toBe('function');
    expect(typeof reconcile.classifyChainEventFinality).toBe('function');
    expect(typeof reconcile.shouldReconcileOnEvent).toBe('function');
    expect(typeof reconcile.InvalidCorrectionAccountsError).toBe('function');
    expect(typeof reconcile.UnreconciledDivergenceError).toBe('function');
    expect(typeof reconcile.InvalidConfirmationDepthError).toBe('function');
  });
});
