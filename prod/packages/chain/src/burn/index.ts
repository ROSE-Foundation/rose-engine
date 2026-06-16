// Paired-burn dual-write public surface (Story 5.4, FR-21). The burn twin of the Story-5.3 paired-mint
// orchestration + its concrete ports (the `burnPair` write seam and the commit-point balanced
// `LedgerEffect` that RETIRES the package) built on the 5.2 saga.
export {
  BurnPairDualWrite,
  submitBurnPair,
  encodeBurnPairCall,
  makeBurnPairLedgerEffect,
  burnPairIntentSchema,
  InvalidPairAmountError,
  PairPlanError,
  BurnQuantityDivergenceError,
  BurnAuthorizationError,
  type BurnPairOnChainParams,
  type BurnPairIntent,
  type BurnPairRequest,
  type BurnPairDualWriteDeps,
  type BurnStartResult,
  type BurnConfirmOutcome,
  type BurnLedgerPlan,
  type BurnLegAccounts,
  type BurnValuePlan,
  type BurnAuthorizationGate,
  type BurnAuthorizationDecision,
} from './burn-pair.js';
