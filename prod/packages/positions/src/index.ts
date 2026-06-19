// @rose/positions — the off-chain per-user position layer (FR-23, secondary-trading Option C).
// Story 8.2: the persisted position entity + reversible migration (0009 in @rose/ledger) + the
// create/read/reset/close primitives, the leverage-pinned-1x guard, the D1/D1a reset
// (re-anchor/crystallise/re-base), and the "never outlives a CLOSED pair" invariant. A position is
// a DERIVED off-chain row — it never mints/holds a single on-chain leg and writes no postings.
//
// Story 8.3: `position-service.ts` — open/close a position over the REAL atomic subscribe/mint +
// redeem/burn flow, with the on-chain tx as the commit point (the position is created/closed AT the
// commit point, atomically with the balanced journal entry — no optimistic success). Composes the
// 5.2 outbox/saga, the 5.3/5.4 paired mint/burn, and the 6.2/6.3 ledger plans; authors no primitive.
export * from './schema/index.js';
export * from './repositories/positions.js';
export * from './position-service.js';
// Story 8.5 — position ↔ pair reconciliation (FR-27): the per-pair/per-side residual-backing
// invariant check (report-only) + the chain-authoritative position↔pair mismatch correction
// (journaled, surfaced, never silent), reusing the FR-10 reconcile-and-correct pattern.
export * from './reconcile.js';
