// @rose/reconcile — reconciliation & group view (FR-9, FR-10). Story 5.5 delivers the READ-ONLY
// consolidated group view (per-entity, per-account-type balances + group NAV) as text AND JSON,
// plus a read-only ledger↔chain divergence signal. Story 5.6 adds the reconcile-and-CORRECT loop
// (FR-10): it corrects the ledger TOWARD the chain (D3) via a journaled, balanced double-entry, plus
// the finality/cadence decision helpers. This package opens NO chain connection — the on-chain
// supplies enter as an injected `ChainSupplySnapshot` (the codebase's injected-port decoupling: no
// `@rose/chain` edge, no `viem`); the only writes it makes are balanced correcting journal entries
// through `@rose/ledger` `recordJournalEntry`.
export {
  buildGroupView,
  groupViewToJson,
  serializeGroupView,
  ACCOUNT_NAV_CLASSIFICATION,
  ENTITY_DISPLAY_ORDER,
  type GroupView,
  type EntityView,
  type EntityAssetSubtotal,
  type AccountBalanceView,
  type ConsolidatedAssetView,
  type CoupledPairPositionView,
  type DivergenceView,
  type ChainComparisonView,
  type MoneyView,
  type NavRole,
  type ReconciliationStatus,
  type CovenantKind,
  type CovenantStatus,
  type CovenantView,
  type CovenantThresholds,
  type NetExposureView,
  type CoupledCoinMarketView,
  type BuildGroupViewOptions,
} from './group-view.js';

export { renderGroupViewText } from './group-view-text.js';

export {
  loadChainSupplySnapshot,
  type ChainSupplySnapshot,
  type ChainTokenSupply,
  type ChainTokenDescriptor,
  type ChainSupplyReader,
} from './chain-supply.js';

export {
  reconcileLedgerToChain,
  reconciliationReportToJson,
  serializeReconciliationReport,
  renderReconciliationText,
  InvalidCorrectionAccountsError,
  UnreconciledDivergenceError,
  type TokenCorrectionAccounts,
  type ReconcilePlan,
  type TokenReconciliation,
  type InternalConsistencyRow,
  type ReconciliationReport,
} from './reconcile.js';

export {
  isFinal,
  classifyChainEventFinality,
  shouldReconcileOnEvent,
  InvalidConfirmationDepthError,
  type ChainEventFinalityInput,
  type ChainEventFinality,
} from './finality.js';
