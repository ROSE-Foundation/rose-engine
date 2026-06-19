---
baseline_commit: 8beba739bd3b32f1dcedb36912718ad136904a58
---

# Story 8.5: Position ↔ pair reconciliation (per-pair, per-side residual-backing)

Status: done

## Story

As an internal operator / steward,
I want reconciliation to verify that off-chain position exposure never exceeds the residual backing of its pair/side and to correct toward the chain,
So that the synthetic layer can never over-claim against the real collateral, and any correction touching a user is auditable (FR-27, NFR-3, NFR-9).

## Acceptance Criteria

**Given** issued coupled pairs and their off-chain positions
**When** reconciliation runs (reusing the FR-10 reconcile-and-correct pattern)
**Then** it verifies, **per pair and per side (L/S)**, that aggregate off-chain position exposure **never exceeds the residual collateral backing** of that pair/side (the residual pool after any D1a reset/withdrawal — **not** gross issued notional netted across pairs or sides)

**Given** a deliberately introduced over-exposure on one pair/side
**When** reconciliation runs
**Then** it is **reported and not masked** by headroom on another pair or side

**Given** a deliberately introduced position↔pair mismatch
**When** reconciliation corrects toward the chain
**Then** the divergence is **reported and corrected**, and because a correction can reduce or void a user's recorded claim, any correction touching a user position is **journaled and surfaced** (auditable, NFR-3) — **never a silent liquidation**

## Tasks / Subtasks

- [x] **Task 1 (AC-1, AC-2): per-pair/per-side residual-backing solvency check.** Add `prod/packages/positions/src/reconcile.ts` exporting `reconcilePositionsToPairs(db, plan)`. Read OPEN positions and the coupled-pair leg values; compute, **per (pair, side) independently** (never netted across pairs or sides), `exposure = Σ position.collateral` of OPEN positions vs `backing` = that side's residual leg value (`long_leg_value`/`short_leg_value`; `0` for a chain-closed pair). Report `overExposed`, `headroom`, `overExposedBy` per row; collect `overExposedSides`. All amounts exact integer decimal strings (NFR-2).
- [x] **Task 2 (AC-2): over-exposure is not masked.** Structural: the math is per-(pair, side) with no cross-pair/cross-side summation, so headroom elsewhere can never offset an over-exposed side. Regression test with a multi-pair + both-sides fixture (one side over, the rest with headroom) asserting the over-exposed side is surfaced and `anyOverExposure === true`.
- [x] **Task 3 (AC-3): position↔pair mismatch, corrected toward the chain, journaled + surfaced.** A position OPEN against a pair the **chain** reports closed/gone (injected `chainClosedPairs` snapshot — the injected-port decoupling, no `@rose/chain` edge) is the divergence. Correct toward chain in ONE transaction: post a balanced, auditable journal entry (via `recordJournalEntry`) that voids the position's recorded collateral claim (naming the correction) AND flip the position `OPEN → CLOSED`. Surface every mismatch in the report (`corrected`/`correctable`/`journalEntryId`/`reason`); a mismatch with no correction-account mapping is reported `correctable:false` (never silently closed), and `strict` mode throws `UnreconciledPositionMismatchError` (whole pass rolls back). Reuse the 5.6 caller-supplied-account topology trust boundary; validate the supplied accounts (exist, share `(asset, scale)`).
- [x] **Task 4: wire + export.** Export the new surface from `prod/packages/positions/src/index.ts`. No new dependency, no new migration (reuses `@rose/ledger` `recordJournalEntry`, `coupledPairs`, the `positions` table, and `closePosition`).
- [x] **Task 5: tests.** Co-located `reconcile.test.ts` against the live Postgres (createPool/createDb, hardReset+migrateUp, TRUNCATE per test), covering: within-backing solvency, deliberate over-exposure not masked by cross-pair/cross-side headroom, both-sides, a pair post-D1a-reset (re-based residual), a chain-closed mismatch corrected with a journaled+surfaced entry, uncorrectable mismatch reported (and strict throw/rollback), idempotence (a second pass is a no-op).
- [x] **Task 6: full gate green** (typecheck, lint, test, format/format:check, check:regime, check:migrations, forge test).

## Dev Notes

### Scope
- **In scope:** the FR-27 position↔pair reconciliation — the per-pair/per-side residual-backing *invariant check* (report-only) and the chain-authoritative position↔pair *mismatch correction* (journaled, surfaced, never silent). Lives in `prod/packages/positions/src/reconcile.ts` per the architecture project structure [Source: architecture.md §Project Structure — `positions/src/reconcile.ts` "per-pair/per-side residual-backing invariant (reuses FR-10)"].
- **Out of scope (do NOT build):** Story 8.6 — the independent single-side-close solvency guardrail (§8 Q8 / §11.4). Over-exposure is **reported, not auto-corrected/liquidated**: correcting over-exposure = liquidation, which is the board-gated 8.6 territory. This story corrects ONLY the position↔pair mismatch.

### Architecture constraints
- **Reuse the FR-10 reconcile-and-correct pattern, do not fork a parallel engine.** The pattern (not the `reconcileLedgerToChain` token-quantity function, which solves a different concern): chain-authoritative; correction is ONE balanced double-entry via `@rose/ledger` `recordJournalEntry` (≥2 postings, per-(asset,scale) balance enforced by the Story-1.5 DB trigger backstop); APPEND-ONLY (no UPDATE/DELETE of journal rows); idempotent (a consistent state posts nothing); never silent (reported, with `strict` rollback); caller-supplied account topology is the trust boundary [Source: prod/packages/reconcile/src/reconcile.ts; architecture.md §Implementation Patterns]. The correction is NOT routed through `postTransfer` — it is the same recording pattern mint/burn commit-points use (`recordJournalEntry` directly) [Source: prod/packages/reconcile/src/reconcile.ts lines 9-15].
- **Residual-backing invariant — per pair AND per side (L/S).** Aggregate off-chain position exposure for each issued pair and side **never exceeds the residual collateral backing** of that pair/side — the residual pool after any D1a reset/withdrawal, **not** gross issued notional, and **NOT netted across pairs or sides**. Over-exposure on one pair/side is **not masked** by headroom on another [Source: architecture.md line 189 §Position ↔ pair reconciliation (FR-27); epics.md Story 8.5 BDD].
- **Residual pool semantics (D1/D1a).** At each reset the winner's gain is crystallised & withdrawn and both legs re-base to a fresh symmetric split of the **residual** pool (no carried P&L) [Source: architecture.md line 77 D1/D1a; line 182]. The coupled-pair row's `long_leg_value`/`short_leg_value` therefore carry the **current residual** per-side backing (re-based at reset, drifted within a cycle) — read them as-is. `collateral_pool` (K) and the leg values are integer-smallest-unit **NUMERIC** (NFR-2) [Source: prod/packages/ledger/src/schema/coupled-pairs.ts].
- **P0 INTERPRETATION (documented, not invented scope):** "aggregate off-chain position exposure" and "residual collateral backing" are both measured in **smallest-unit collateral value**. `exposure(pair, side) = Σ position.collateral` over OPEN positions of that pair & side; `backing(pair, side) =` that side's stored leg value (`long_leg_value`/`short_leg_value`), which is the residual pool after any D1a reset/withdrawal; `0` for a pair the chain reports closed/gone. In paper P0 `collateral == size_units` (1:1) and at entry leg value `= K/2`, so this is exact and consistent. Chosen over a token-quantity exposure measure because the invariant is explicitly about **collateral backing** [Source: architecture.md line 189; epics.md Story 8.2 model].
- **Chain authoritative for the underlying pairs (NFR-9).** The position↔pair mismatch "corrected toward the chain" is: a position is still OPEN while the **chain** reports its underlying pair's package closed/gone, but the off-chain ledger has not yet retired it. The chain-authoritative pair facts enter as an **injected snapshot** (`chainClosedPairs`) — the codebase's injected-port decoupling (mirrors `ChainSupplySnapshot`: no `@rose/chain` edge, no `viem`, no secret) [Source: prod/packages/reconcile/src/chain-supply.ts; architecture.md line 28, line 189]. NOTE: the ledger's own `0009` triggers already forbid an OPEN position coexisting with a **ledger**-CLOSED pair, so the genuine divergence is precisely the chain-says-closed/ledger-still-open case [Source: prod/packages/ledger/src/migrations/0009-positions.ts triggers].
- **Correction touching a user position is journaled and surfaced — never a silent liquidation (NFR-3).** Voiding a position's recorded claim posts a balanced auditable journal entry (description names the void; reuses the caller-supplied claim/contra account topology, same as 5.6) AND flips `OPEN → CLOSED` in the same transaction; every mismatch is surfaced in the structured report [Source: architecture.md line 189; NFR-3].
- **Position boundary preserved.** `positions` is a derived layer — it mints/transfers no single leg; the only writes are the balanced correcting journal entry (through `recordJournalEntry`) and the lifecycle flip [Source: architecture.md line 373 §Position boundary].
- **Money exact (NFR-2).** Smallest-units as `bigint` internally / `NUMERIC` in PG / exact integer decimal strings in the report; never a binary float.

### Prior-story learnings (8.1–8.4, 5.6)
- 8.2 `positions` schema: `coupled_pair_id` NOT NULL FK, `side` LONG/SHORT, `collateral`/`size_units` integer NUMERIC, `lifecycle` OPEN/CLOSED; `closePosition(executor, id)` flips OPEN→CLOSED in a row-locking tx that nests a savepoint when given an outer `tx` [Source: prod/packages/positions/src/repositories/positions.ts].
- 8.3 `position-service.ts` composes the atomic flow and treats confirm-time anomalies as "left for reconcile (5.6)" — this story is part of that reconcile backstop; it authors no mint/burn primitive [Source: prod/packages/positions/src/position-service.ts].
- 5.6 `reconcileLedgerToChain`: the canonical reconcile-and-correct shape (signed divergence, caller-supplied `TokenCorrectionAccounts`, `strict` rollback, idempotence, JSON-serialisable report, balanced `recordJournalEntry`) — mirror its idioms [Source: prod/packages/reconcile/src/reconcile.ts].

### Testing standards
- Vitest, co-located `reconcile.test.ts`; DB integration tests share one DB and run serially. `beforeAll`: `createPool`/`createDb`, `hardReset(pool)` + `migrateUp(pool)`; `afterAll`: `pool.end()`; `beforeEach`: `TRUNCATE positions, coupled_pairs, accounts, journal_entries, postings CASCADE`. Seed a coupled pair via `createCoupledPair`, OPEN positions via `createPosition`, and correction accounts via raw `INSERT INTO accounts` against a seeded entity (mirror 5.6's `mkAccount`). Test-first on the invariants (NFR-6).

### References
- epics.md Epic 8 overview + Story 8.5 BDD ACs.
- architecture.md §Secondary-Trading Position Layer (Option C); line 189 (FR-27 invariant); §Project Structure (`positions/src/reconcile.ts`); §Position boundary.
- prod/packages/reconcile/src/reconcile.ts (FR-10 pattern); prod/packages/positions/* (8.2/8.3); prod/packages/ledger/src/migrations/0009-positions.ts (triggers).

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log
- Confirmed the `0009` triggers forbid OPEN-position/ledger-CLOSED-pair coexistence → the chain-authoritative divergence is precisely chain-closed/ledger-still-open; modelled it as an injected `chainClosedPairs` snapshot (decoupled, mirrors `ChainSupplySnapshot`).
- `closePosition(tx, id)` nested inside the reconcile transaction (savepoint) commits the lifecycle flip atomically with the correcting journal entry.

### Completion Notes
- New module `prod/packages/positions/src/reconcile.ts`; `reconcilePositionsToPairs(db, plan)` returns a JSON-serialisable `PositionReconciliationReport` with `sideBacking` (per-(pair,side) backing/exposure/headroom/overExposed), `overExposedSides`, `mismatches`, and `anyOverExposure`/`anyMismatch`/`anyCorrected`/`corrections`.
- AC-1/AC-2: per-(pair,side) math, never netted; over-exposure reported and structurally un-maskable by cross-pair/cross-side headroom (regression test with a multi-pair, both-sides fixture).
- AC-3: chain-closed-pair mismatch reported and corrected toward the chain via a journaled, balanced, append-only `recordJournalEntry` that voids the position's collateral claim + flips OPEN→CLOSED; uncorrectable mismatch reported (`correctable:false`) and `strict` throws+rolls back; idempotent.
- No new migration, no new dependency. Over-exposure is report-only (no auto-liquidation — 8.6 stays out of scope).

### File List
- `prod/packages/positions/src/reconcile.ts` (new)
- `prod/packages/positions/src/reconcile.test.ts` (new)
- `prod/packages/positions/src/index.ts` (modified — export the reconcile surface)
- `_bmad-output/implementation-artifacts/8-5-position-pair-reconciliation-per-pair-per-side-residual-backing.md` (new)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — status transitions + last_updated)

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI agent, claude-opus-4-8[1m]) · **Date:** 2026-06-19 · **Outcome:** APPROVED

### Lenses
- **Correctness.** The residual-backing math is computed PER (pair, side) from a per-key BigInt aggregation (`exposureByKey`) compared against that side's stored leg value (`long_leg_value`/`short_leg_value`) — never a cross-pair or cross-side sum, so over-exposure cannot be netted away. Money stays exact (BigInt internally / NUMERIC / integer decimal strings; no float). The mismatch correction is a single balanced `recordJournalEntry` (claim DEBIT / contra CREDIT, equal amount — the Story-1.5 per-(asset,scale) DB trigger is the non-bypassable backstop), append-only, with the position flip `OPEN→CLOSED` in the SAME transaction; a `strict` failure throws after the loop and rolls the whole pass back. Idempotent: a corrected position is CLOSED, so the OPEN-only read finds no further mismatch and posts nothing. Verified the FR-10 pattern is REUSED (same `recordJournalEntry` primitive, caller-supplied account topology, `strict` rollback, JSON-serialisable report) and NOT forked.
- **Edge cases (probed on live Postgres :5544).** Multi-pair + both-sides masking (over on one side, headroom on another pair AND the other side) → the over-exposed side is still surfaced; mirror SHORT-over/LONG-headroom case; a pair post-D1a-reset (residual leg value < gross K/2) correctly flags over-exposure against the RESIDUAL, not the gross notional; a chain-closed-pair mismatch with the ledger pair still ACTIVE corrects cleanly (the `0009` trigger only blocks `NEW.lifecycle='OPEN'`, so the close passes); an uncorrectable mismatch (no mapping) leaves the position OPEN and posts nothing (never silent); `strict` rolls back a partially-corrected pass; structurally-invalid correction accounts (mismatched denomination) fail loud; a zero-claim stale position closes without a journal entry but is still surfaced; a report-only pass opens no transaction and writes nothing.
- **Acceptance.** AC-1/AC-2/AC-3 all met (see verdict below). NO scope creep: over-exposure on a chain-LIVE pair is REPORT-ONLY (regression test asserts no correction, no journal, position stays OPEN) — the independent single-side-close solvency guardrail (Story 8.6) is NOT built.

### Action Items
- None blocking. (Documented P0 interpretation — exposure & backing both measured in smallest-unit collateral value; `exposure = Σ position.collateral`, `backing` = the side's residual leg value — recorded in Dev Notes; `collateral == size_units` in paper P0 so it is exact.) Forward note for post-P0: when leverage unpins (>1x) or token:collateral stops being 1:1, revisit whether exposure should weight by `size_units × leverage` vs `collateral`.

### Regression tests added during review
- SHORT-over / LONG-headroom mirror (cross-side independence).
- Over-exposure WITHOUT a chain-closed pair is report-only — no correction, no journal, position stays OPEN (locks the Story-8.6 boundary).

## Change Log
- 2026-06-19 — Story drafted (ready-for-dev), implemented test-first (in-progress), gate green (review), adversarial review + 2 regression tests, gate re-run green (done). Agent: claude-opus-4-8[1m].
