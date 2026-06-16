// Outbox/saga public surface (Story 5.2). The dual-write orchestrator + its ports; 5.3/5.4 supply
// the concrete `submit` (mintPair/burnPair) and `LedgerEffect` (postTransfer journal entry).
export {
  OutboxSaga,
  ledgerOutboxStore,
  type OutboxStore,
  type OutboxSagaDeps,
  type LedgerEffect,
  type LedgerEffectContext,
} from './outbox-saga.js';
