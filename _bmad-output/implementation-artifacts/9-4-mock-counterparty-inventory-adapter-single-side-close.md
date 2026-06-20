---
baseline_commit: 9dbdb36385307c785f9f0a9118f6b6e2851c0bc3
---

# Story 9.4: Mock counterparty/inventory adapter — independent single-side close (§8 Q8)

Status: done

## Story

As a risk owner / steward,
I want a **mocked** matched-book/house counterparty adapter satisfying the §11.4 guardrail contract,
So that the independent single-side close (D1 topology) completes via re-assignment in the demo — while the real board-gated §8 Q8 model stays deferred (FR-31, FR-25 remainder, §11.4).

## Acceptance Criteria

**Given** `faithful` mode with the mock counterparty adapter composed, and a position whose opposite leg is held by another user (the D1 topology)
**When** the holder performs an independent single-side close
**Then** it **completes** via the mock counterparty (re-assignment / house inventory) — the on-chain package is burned only when both sides are released, and the action is journaled (auditable) — instead of the §11.4 fail-closed refusal

**Given** the mock adapter is clearly labelled as a demo stand-in
**When** the adapter is absent (e.g. default `paper` mode, or `faithful` without it)
**Then** the single-side close remains **fail-closed** under the §11.4 guardrail (Story 8.6) — the real model is still board-gated; the mock never leaks into a real-capital path

**Given** a single-side close via the mock
**When** it settles
**Then** solvency is preserved — aggregate per-pair/per-side exposure still never exceeds residual backing (the Epic-8.5 reconciliation passes after the re-assignment)

## Tasks / Subtasks

- [x] Define an OPTIONAL `counterparty?` port on `PositionServiceDeps` (`CounterpartyAdapter`, NFR-8) — `resolveSingleSideClose({ executor, position, opposingHolder })` returning a `CounterpartyCloseResult`. Backward-compatible: absent ⇒ nothing changes.
- [x] Wire the port at the §11.4 guardrail point in `closePosition`: D1 topology detected ⇒ adapter present → resolve via re-assignment (atomic transaction); adapter absent → `throw SolvencyGuardrailError` exactly as Story 8.6.
- [x] Build the MOCK house-inventory adapter in `@rose/api` faithful (`counterparty-mock.ts`): flips closer CLOSED, house TAKES OVER the same side carrying the same collateral (conserves per-side exposure), journals the claim transfer (balanced), never burns. Header states simplifications + deferred §8 Q8.
- [x] Compose the mock ONLY in `makeFaithfulPositionService` (faithful); paper stays without it. Export from `@rose/api` index. Extend the faithful banner's MOCKED list for honesty.
- [x] Tests — faithful (re-assignment completes; opposite leg untouched; no burn; journaled; 8.5 solvency conserved), paper (same close still 409 / `SolvencyGuardrailError`), whole-package close unaffected, adapter unit (conserves per-side claim, never burns).
- [x] Full gate green.

## Dev Notes

### Scope

ONLY the counterparty port (`@rose/positions`) + the mock house adapter (`@rose/api` faithful) + the `closePosition` branch + the faithful composition. NOT the operator panel (9.5) nor the banner/deploy (9.6). Paper / Story-8.6 behaviour is UNCHANGED when no adapter is injected.

### Architecture constraints

- The §8 Q8 counterparty/inventory model is **board-gated and NOT resolved** — this story builds a clearly-labelled MOCK satisfying the §11.4 guardrail's resolution contract, never the real model, never a real-capital path. [Source: architecture.md line 186–187 "Open sub-decision (§8 Q8 / §11.4)" + "Production-faithful mock (Epic 9, §4.9)"; addendum §J FR-31.]
- The mock is a **substitutable adapter behind the existing port** (NFR-8): present only in faithful mode; absent in paper. [Source: epics.md §1056 Epic 9 regime note.]
- Money stays exact (NFR-2); the re-assignment is one **balanced, append-only, auditable** `recordJournalEntry` (NFR-3), with the `@rose/ledger` per-(asset, scale) trigger as the non-bypassable backstop. [Source: CYCLE-BRIEF double-entry invariant.]
- Solvency conservation reuses the Story-8.5 `reconcilePositionsToPairs` per-(pair, side) residual-backing invariant: the house OPEN position carries the closer's exact collateral on the same side, so aggregate per-side exposure is identical before and after — `anyOverExposure` stays `false`. [Source: reconcile.ts §RESIDUAL-BACKING INVARIANT.]

### Implementation guidance

- `closePosition` branch (position-service.ts ~617): after `findOpposingHolder` detects the D1 leg, `deps.counterparty !== undefined` ⇒ run the adapter inside `deps.db.transaction` (atomic: closer flip + house position + journal commit together) and return a `confirmed` view with a **null txHash** (no on-chain burn) + the claim-transfer `journalEntryId`; else `throw SolvencyGuardrailError` (8.6, unchanged).
- The faithful close wrapper's `pending && txHash` scheduling guard naturally skips the `confirmed`/null-txHash re-assignment view, so nothing is scheduled on the confirmation transport.
- Mock journal accounts: the seeded EUR (scale 2) `NOTE_LIABILITY` → `cash` demo accounts (one (asset, scale) ⇒ the entry balances). Supplied via `paperConfig.redemptionTopology`.

### P0 interpretations (documented, not invented scope)

- **Re-assignment model is a MOCK.** It assumes an infinite, always-willing house at the closer's exact entry — no pricing, matching, inventory limit, or house P&L. The real §8 Q8 model (matched-book re-assignment vs a funded house book, capital adequacy, fees) stays DEFERRED until the board resolves it and it is shown solvency-preserving.
- **The "claim transfer" entry** is a representative balanced move between two demo accounts in one (asset, scale); auditable, but not the full settlement the real model would post.
- **House identity** is a clearly-labelled non-user owner (`MOCK-HOUSE-INVENTORY`); it never appears under a user's `GET /positions`.

### Testing standards

Vitest, co-located `*.test.ts`, DB integration serial (shared DB). The `@rose/positions` wiring test uses an inline faithful adapter (mirrors the real mock); the `@rose/api` test exercises the real `makeMockCounterpartyAdapter` + `makeFaithfulPositionService` + the paper fail-closed regression.

### References

- epics.md §Story 9.4 (lines 1119–1137); §1056 Epic 9 regime note.
- architecture.md lines 186–187 (§8 Q8 / §11.4 + production-faithful mock).
- addendum §J FR-31 (line 105).
- position-service.ts (`SolvencyGuardrailError`, `findOpposingHolder`, `closePosition`); reconcile.ts (Story 8.5 invariant); faithful-mode.ts (`makeFaithfulPositionService`); paper-position-service.ts (no adapter); seed-demo.ts (D1 topology seed).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log

- `pnpm --filter @rose/positions test`, `pnpm --filter @rose/api test`, then full `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm check:regime && pnpm check:migrations` + `forge test`.

### Completion Notes

- Added `CounterpartyAdapter` / `CounterpartySingleSideCloseInput` / `CounterpartyCloseResult` + optional `PositionServiceDeps.counterparty` (`@rose/positions`); backward-compatible.
- `closePosition` resolves the D1 topology via the adapter (atomic re-assignment, journaled, no burn, `confirmed`/null-txHash view) when present; fail-closed `SolvencyGuardrailError` when absent (8.6 preserved).
- Mock house adapter (`@rose/api` faithful/counterparty-mock.ts) composed ONLY in `makeFaithfulPositionService`. Paper unchanged.

### File List

- `prod/packages/positions/src/position-service.ts` (port + closePosition branch)
- `prod/packages/positions/src/position-service.test.ts` (faithful re-assignment + whole-package tests)
- `prod/packages/api/src/faithful/counterparty-mock.ts` (NEW — mock house adapter)
- `prod/packages/api/src/faithful/counterparty-mock.test.ts` (NEW — unit + faithful/paper)
- `prod/packages/api/src/faithful/faithful-mode.ts` (compose mock; banner/doc)
- `prod/packages/api/src/index.ts` (export mock)

## Senior Developer Review (AI)

Adversarial review across correctness / edge cases / acceptance. Gate fully green
(typecheck, lint, 1092 tests, prettier, regime, migrations up→down→up, 171 forge tests).

**Correctness**

- Atomicity: the re-assignment runs inside `deps.db.transaction` — closer flip + house position + balanced journal commit or roll back together. An unbalanced/invalid journal would abort the whole move (no half-state). The `@rose/ledger` per-(asset, scale) trigger is the non-bypassable backstop.
- Money exact (NFR-2): the house position carries the closer's exact `bigint` collateral/size; the journal amount is that same `bigint`. No float.
- The returned view is `confirmed` with a NULL txHash (no on-chain burn) — the faithful wrapper's `pending && txHash` scheduling guard correctly skips it, so nothing is scheduled on the confirmation transport.

**Edge cases**

- Re-invocation with the same key: the first call flips the closer CLOSED; a retry re-loads it, sees `lifecycle !== 'OPEN'`, and throws `PositionLifecycleError` (409) BEFORE consulting the adapter — no double re-assignment / no duplicate house position. Acceptable & safe (fail-closed).
- The re-assignment posts NO outbox row (it is synchronous, not an async on-chain flow), so there is no pending handle to poll — consistent with "the re-assignment IS the commit point". Documented simplification.
- Non-positive collateral ⇒ the mock throws a clear precondition error (positions in this flow always carry positive collateral).

**Acceptance** — all ACs met (see final report). Whole-package / same-user closes are unaffected in both modes (the adapter is consulted only when `findOpposingHolder` detects a live different-owner opposite leg).

**Action items**: none blocking. The real §8 Q8 model + an idempotent re-assignment handle are deferred (board-gated / post-P0), as documented.

## Change Log

- 2026-06-20: Story 9.4 implemented — optional counterparty port + mock house-inventory adapter resolving the D1 independent single-side close via re-assignment (faithful), fail-closed preserved (paper), per-side solvency conserved.
