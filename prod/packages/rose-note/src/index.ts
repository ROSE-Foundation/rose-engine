// @rose/rose-note — the FR-11 Rose Note lifecycle composition layer (Story 6.2: live subscription,
// paper/testnet). The architecture-mandated `api → rose-note → chain → ledger → reconcile` flow
// (architecture §Data Flow line 365; §Project Structure line 319): an eligible Subscriber subscribes
// to a pre-existing Rose Note, the paired ERC-3643 mint (5.3) is driven with the on-chain tx as the
// commit point, and ONE balanced journal entry (incl. `NOTE_LIABILITY`) is posted at confirmation.
// Composes the existing Epic 3–5 seams; authors no new ledger/chain/authorization primitive. PAPER/
// LOCAL only — all dependencies injected, no connection opened here, no secret.
export {
  makeAllowlistEligibilityProvider,
  IneligibleSubscriberError,
  type EligibilityDecision,
  type EligibilityProvider,
} from './eligibility.js';

export {
  buildSubscriptionMintPlan,
  InvalidSubscriptionAmountError,
  type BuildSubscriptionMintPlanInput,
  type SubscriptionAccountTopology,
} from './subscription-plan.js';

export { makeProviderAuthorizeGate } from './authorize-gate.js';

export {
  makeSubscriptionService,
  RoseNoteNotFoundError,
  SubscriptionIdempotencyConflictError,
  SubscriptionPairNotActiveError,
  UnsupportedPaymentAssetError,
  type SubscribeInput,
  type SubscriptionService,
  type SubscriptionServiceDeps,
  type SubscriptionStatus,
  type SubscriptionView,
} from './subscribe.js';

// Story 6.3 — live redemption (the INVERSE mirror of the subscription, against the 5.4 paired burn).
export {
  buildRedemptionBurnPlan,
  InvalidRedemptionAmountError,
  type BuildRedemptionBurnPlanInput,
  type RedemptionAccountTopology,
} from './redemption-plan.js';

export {
  makeRedemptionService,
  RedemptionIdempotencyConflictError,
  RedemptionPairNotActiveError,
  type RedeemInput,
  type RedemptionService,
  type RedemptionServiceDeps,
  type RedemptionStatus,
  type RedemptionView,
} from './redeem.js';

// Story 6.4 — paper/testnet coupled-pair strategy execution (threshold-only reset, FR-20, NFR-7).
export {
  buildStrategyResetBurnPlan,
  deriveFloorUnits,
  InvalidStrategyResetError,
  type BuildStrategyResetBurnPlanInput,
  type StrategyResetTopology,
} from './strategy-plan.js';

export {
  makeStrategyExecutor,
  StrategyResetIdempotencyConflictError,
  type LegSide,
  type StrategyExecutor,
  type StrategyExecutorDeps,
  type StrategyResetStatus,
  type StrategyResetView,
  type StrategyTick,
  type StrategyTickOutcome,
} from './strategy.js';
