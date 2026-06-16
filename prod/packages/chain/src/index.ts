// @rose/chain — the single PROD module that talks to the chain (Sepolia) via typed viem clients
// and event watchers (Story 5.1, NFR-9 foundation). Reads on-chain token state and observes the
// epic-4 contract events; the outbox/saga (5.2), mint/burn (5.3/5.4), group view (5.5), and
// reconcile-and-correct (5.6) build on the seams exported here.
export {
  loadChainConfig,
  ChainConfigRefusalError,
  CHAIN_CONFIG_KEYS,
  type ChainConfig,
  type ChainConfigKey,
} from './chain-config.js';

export {
  createRoseChainClients,
  readTokenBalance,
  readTotalSupply,
  type RoseChainClients,
  type RoseChainClientOptions,
} from './viem-clients.js';

export {
  watchPairEvents,
  watchTokenTransfers,
  getPastPairEvents,
  type ChainEvent,
  type PairMintedEvent,
  type PairBurnedEvent,
  type TransferEvent,
  type PairMintedArgs,
  type PairBurnedArgs,
  type TransferArgs,
  type Unwatch,
  type WatchPairEventsParams,
  type WatchTokenTransfersParams,
  type GetPastPairEventsParams,
} from './watchers.js';

export { roseTokenAbi, coupledPairAbi } from './abis/index.js';

export {
  OutboxSaga,
  ledgerOutboxStore,
  type OutboxStore,
  type OutboxSagaDeps,
  type LedgerEffect,
  type LedgerEffectContext,
} from './outbox/index.js';

export {
  MintPairDualWrite,
  submitMintPair,
  encodeMintPairCall,
  makeMintPairLedgerEffect,
  mintPairIntentSchema,
  InvalidMintAmountError,
  MintQuantityDivergenceError,
  MintAuthorizationError,
  MintPlanError,
  type MintPairOnChainParams,
  type MintPairIntent,
  type MintPairRequest,
  type MintPairDualWriteDeps,
  type MintStartResult,
  type MintConfirmOutcome,
  type MintLedgerPlan,
  type MintLegAccounts,
  type MintValuePlan,
  type MintAuthorizationGate,
  type MintAuthorizationDecision,
} from './mint/index.js';

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
} from './burn/index.js';
