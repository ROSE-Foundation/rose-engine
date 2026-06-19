---
baseline_commit: 8beba739bd3b32f1dcedb36912718ad136904a58
---

# Story 8.3: Open and close a position over the atomic subscribe/redeem package flow

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Subscriber (Rose Member),
I want to open and close a directional position that is backed by the real coupled package,
So that my exposure is acquired/released through the proven atomic subscribe/mint and redeem/burn flow with the coupling invariant intact (FR-25).

## Acceptance Criteria

**Given** an eligible Subscriber and an issued (or to-be-issued) coupled pair
**When** they open a position
**Then** opening acquires/assigns exposure against an **atomically issued coupled package** via the real FR-11/FR-18 subscribe + mint path, recording the position (Story 8.2); the action drives a **paired (both-or-neither) on-chain mint** — a single-leg mint is impossible

**Given** a Subscriber closing a position whose opposite side they also control (or the standard whole-package case)
**When** they close
**Then** it routes the real FR-21 redeem/burn path, driving a **paired (both-or-neither) on-chain burn** and updating the position lifecycle to `CLOSED` with balanced journal entries — no single-leg burn occurs
**And** the open/close composes the existing outbox/saga with the on-chain tx as the commit point (no optimistic success)

> **Out of scope for this story:** an **independent** single-side close when the opposite leg is held by **another** user (the D1 topology) is handled by Story 8.6 under the §8 Q8 counterparty/inventory model.

### Scope boundary (P0, this story only)

- **IN:** a new `position-service.ts` in `@rose/positions` (architecture L345 places it there exactly: "open/close composing the atomic subscribe/redeem flow"). It **composes** the proven seams — it authors no new mint/burn/ledger primitive:
  - **open** drives the real FR-11/FR-18 **subscribe + paired mint** path (`@rose/chain` `MintPairDualWrite` + `makeMintPairLedgerEffect`, plus the `@rose/rose-note` `buildSubscriptionMintPlan` + eligibility), submits the PENDING/SUBMITTED intent, then — **at the on-chain commit point only** — posts ONE balanced journal entry (incl. `NOTE_LIABILITY`) AND **records the position** (`@rose/positions` `createPosition`) **atomically in the same confirm transaction**;
  - **close** drives the real FR-21 **redeem + paired burn** path (`BurnPairDualWrite` + `makeBurnPairLedgerEffect` + `buildRedemptionBurnPlan`), submits PENDING/SUBMITTED, then at the commit point posts ONE balanced burn entry AND flips the position `OPEN → CLOSED` (`@rose/positions` `closePosition`) atomically.
  - `@rose/positions` gains a `@rose/chain` + `@rose/rose-note` dependency (no cycle — neither depends on positions); wire tsconfig references + `pnpm install`.
- **OUT (later stories, do NOT pull forward):** the position P&L API endpoints + Exchange-terminal wiring (8.4), position↔pair reconciliation / residual-backing invariant (8.5), the **independent single-side close (D1 topology, opposite leg held by ANOTHER user)** + its §11.4 solvency guardrail (8.6). This story does the standard **whole-package / same-user** open & close only.
- **OUT:** any change to the deployed coupling contracts (no re-audit), to `postTransfer`, to the 5.2 outbox/saga, the 5.3/5.4 mint/burn, the 6.2/6.3 subscribe/redeem, or the 8.2 `positions` schema/repository core. Those are **reused unchanged**.

## Tasks / Subtasks

- [x] Task 1 — Wire `@rose/chain` + `@rose/rose-note` into `@rose/positions` (AC: #1, #2)
  - [x] Add `@rose/chain` + `@rose/rose-note` (`workspace:*`) to `prod/packages/positions/package.json`; add `{ "path": "../chain" }` + `{ "path": "../rose-note" }` to the package tsconfig `references`. Run `pnpm install`. (No cycle: rose-note/chain do not depend on positions.)
- [x] Task 2 — `position-service.ts` — open (subscribe+mint) composition (AC: #1)
  - [x] `makePositionService(deps)`: deps `{ db, saga, mint, burn, pairAddress, eligibility, authorize, openTopology, closeTopology, paymentAsset }`.
  - [x] `openPosition(input: { coupledPairId, owner, side, amount, paymentAsset, idempotencyKey })`: validate paymentAsset; resolve the pair (must exist + be `ACTIVE`); **eligibility (FR-19) pre-write** (fail-closed, the subscribe gate); drive `mint.start` (authorize pre-submit → submit paired `mintPair(owner, owner, amount)` → SUBMITTED) — **NO ledger entry, NO position row yet** (no optimistic success); idempotency-conflict guard (reused-key mismatch ⇒ fail-closed). Returns an `OpenPositionView` (status derived from the outbox row: `pending`).
  - [x] `confirmOpen(event: PairMintedEvent, ctx: { side })`: THE COMMIT POINT. Build the subscription mint plan, compose a `LedgerEffect` = `makeMintPairLedgerEffect` (posts the balanced both-legs entry) **then** `createPosition` (entry = pair anchor P₀, `sizeUnits` = on-chain amount, `side`, leverage `'1'`) — all in ONE confirm transaction via `saga.confirmFromEvent`. Never throws into the watcher (catches → null). Idempotent (re-delivery ⇒ no-op ⇒ no duplicate entry/position).
- [x] Task 3 — `position-service.ts` — close (redeem+burn) composition (AC: #2)
  - [x] `closePosition(input: { positionId, paymentAsset, idempotencyKey })`: load the position (must be `OPEN`), load its pair (must be `ACTIVE`); drive `burn.start` (authorize → submit paired `burnPair(owner, owner, sizeUnits)` → SUBMITTED) — **NO burn entry yet, position stays OPEN** (no optimistic success); idempotency-conflict guard. Returns a `ClosePositionView` (status `pending`).
  - [x] `confirmClose(event: PairBurnedEvent)`: THE COMMIT POINT. Build the redemption burn plan, compose a `LedgerEffect` = `makeBurnPairLedgerEffect` (posts the balanced both-legs retirement entry) **then** find the OPEN position for `(coupledPairId, owner=lFrom)` and `closePosition` it `OPEN → CLOSED` — all in ONE confirm transaction. Never throws into the watcher; idempotent.
- [x] Task 4 — Tests (test-first on the invariants) (AC: #1, #2)
  - [x] Open: `openPosition` ⇒ `pending`, tx hash set, **0 journal entries / 0 positions** (no optimistic success); `confirmOpen` ⇒ ONE balanced entry (4 quantity postings = both legs + 2 value incl. `NOTE_LIABILITY`), position created `OPEN` with `entry = anchor P₀`, side recorded, leverage `'1'`; the mint intent is `lTo == sTo == owner` (paired — single-leg impossible).
  - [x] Close: from an OPEN position, `closePosition` ⇒ `pending`, position **still OPEN**, no burn entry; `confirmClose` ⇒ ONE balanced burn entry (both legs retired), position `CLOSED`.
  - [x] Commit-point / saga: re-delivering the same confirmed event is a no-op (no duplicate entry/position/close); a vetoed authorization (DENY) opens/closes nothing; eligibility refusal opens nothing.
  - [x] Both-or-neither: assert the mint/burn ledger effect always posts BOTH leg-quantity postings from the single on-chain amount (no single-leg path).
- [x] Task 5 — Wire into the gate & validate (AC: #1, #2)
  - [x] Export the service from `@rose/positions` `src/index.ts`. Full gate green: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` + `format:check`, `pnpm check:regime`, `pnpm check:migrations`, `(cd prod/contracts && forge test)`.

## Dev Notes

### Scope & interpretation (P0)

- **The position is created/closed AT THE COMMIT POINT, inside the confirm transaction — never optimistically.** The 8.2 `positions` lifecycle is `OPEN | CLOSED` only (no `PENDING` state). The faithful reading of "no optimistic success — position is not OPEN/CLOSED until the chain tx commits" is therefore: **no position row exists until the confirmed on-chain `PairMinted`**, and the `OPEN → CLOSED` flip happens only at the confirmed `PairBurned`. Before confirmation the "pending" state is observable purely via the 5.2 outbox row (exactly as the 6.2/6.3 `SubscriptionView`/`RedemptionView` derive `pending → confirmed` from the outbox), so a crash between the off-chain submit and the on-chain commit leaves NO OPEN position and a `SUBMITTED` outbox row that `resumePending` (5.6 seam) re-drives. **[P0 interpretation, documented]**
- **Atomicity (the central correctness property).** Open composes a single `LedgerEffect` = `makeMintPairLedgerEffect` **then** `createPosition`, run by `saga.confirmFromEvent` inside ONE `db.transaction`. So the balanced journal entry, the `SUBMITTED → CONFIRMED` flip, the `journal_entries.tx_hash` stamp, and the position row are all-or-nothing. If `createPosition` throws (e.g. the pair went CLOSED) the whole confirm rolls back → the row stays `SUBMITTED` → surfaced as an anomaly for reconcile (5.6); nothing partial commits. Close is the mirror: `makeBurnPairLedgerEffect` **then** `closePosition` (the 8.2 lifecycle flip, which row-locks `FOR UPDATE`) in the same confirm transaction.
- **Both-or-neither, single-leg impossible.** On-chain, `mintPair`/`burnPair` are atomic by the epic-4 coupling contract (unchanged, not re-audited). Off-chain, `makeMintPairLedgerEffect`/`makeBurnPairLedgerEffect` ALWAYS post BOTH leg-quantity postings from the single confirmed on-chain amount — there is no code path that posts one leg. The position records both legs' package backing held by the same user (`lTo == sTo == owner`); the directional `side` is the off-chain synthetic view (Option C). [Source: architecture.md L177–L178, L185, L373]
- **In 8.3 the same user controls BOTH legs (whole-package case).** Opening mints the paired package to one owner (`lTo == sTo`); closing burns that same owner's package. The `side` (`LONG | SHORT`) is the recorded directional view layered over the package — NOT a single on-chain leg. The **independent single-side close where the opposite leg is held by ANOTHER user (the D1 topology)** is **explicitly Story 8.6** (§8 Q8 counterparty/inventory model + §11.4 solvency guardrail) and is NOT built here. [Source: epics.md Story 8.3 "Out of scope"; architecture.md L186]
- **`confirmOpen` carries `side`; `confirmClose` derives the position from persisted state.** The mint intent payload (`coupledPairId, lTo, sTo, amount`) is the fixed 5.3 schema and cannot carry the off-chain `side`, so `confirmOpen` receives `side` from the composition layer that drives confirmation (exactly how 6.x `confirm` is driven by the layer holding the request context; the real watcher-recovery of `side` rides with the deferred live-Sepolia wiring). `confirmClose` needs no extra context: it derives the OPEN position from `(coupledPairId from payload, owner = lFrom)` — fully state-recoverable. 8.3 assumes **one OPEN position per (owner, pair)** (the whole-package case); a 0/≠1 match is treated as a non-applied anomaly (logged, left for reconcile), never a wrong close. **[P0 interpretation, documented]**
- **`openPosition` takes a `coupledPairId` (not a `roseNoteId`).** A position references a coupled pair (8.2 FK), which may or may not have an embedding note; the position layer composes against the pair directly. The pair must already be issued + `ACTIVE` ("to-be-issued" = the caller issues it first via Epic-2 `issueCoupledPair`, not re-implemented here). **[P0 interpretation, documented]**
- **PAPER/LOCAL only, no secret.** Like 6.2/6.3, all deps are injected, no connection/key is held; tests use the local Postgres (5544) + a mock EIP-1193 transport + a SYNTHETIC confirmed `PairMinted`/`PairBurned`. Real Sepolia broadcast/confirmation + the live watcher wiring (incl. `side` recovery) ride with the existing 5.x/6.x ops-deferred items. [Source: 6-2/6-3 stories; `paper-chain.ts`]

### Architecture & convention constraints (cite)

- **Position service (FR-25):** `openPosition`/`closePosition` compose the **existing atomic pair flow** — open drives the real FR-11/FR-18 subscribe+mint path, close drives the real FR-21 redeem/burn path. Every open/close ⇒ a **paired (both-or-neither)** on-chain action; a single-leg path is impossible; capital moves only through `postTransfer`. The independent single-side close (D1) is the §8 Q8 / §11.4 sub-decision (Story 8.6). [Source: architecture.md L185–L186, `positions/src/position-service.ts` L345]
- **On-chain tx is the commit point (NFR-9 / NFR-3):** intent → submit (SUBMITTED) → confirm (CONFIRMED, the ONLY point a ledger effect — here also the position write — is applied). Reuse the 5.2 `OutboxSaga` (`recordIntent`/`submit`/`confirm`/`resumePending`), the 5.3/5.4 dual-writes, and the idempotency (idempotency key + tx-hash unique + already-CONFIRMED no-op). [Source: architecture.md L164, L243–L244; 5-2 story]
- **Money exactness (NFR-2):** token quantity / cash are integer smallest-units as `bigint`; the position `entry` is `decimal(18,8)` = the pair anchor; `sizeUnits`/`collateral` = the on-chain amount (1:1 paper). No binary float anywhere. [Source: CYCLE-BRIEF "Money"; 8-2 story]
- **Position boundary:** `positions` is a derived layer — it never mints/transfers a single leg and writes postings only through the atomic pair flow / `postTransfer`; the chain stays authoritative for the underlying pairs (FR-27). The balanced journal entries here come from the 5.3/5.4 effects (chain = source of truth for quantity, D3). [Source: architecture.md L373]
- **Regime / wiring:** PROD, TypeScript; `/prod` never imports `/throwaway`; `pnpm check:regime` stays green. New package edges `positions → chain`, `positions → rose-note` (no cycle). ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`; files `kebab-case.ts`. [Source: CYCLE-BRIEF; architecture.md L373–L374]

### Prior-story learnings reused

- **6.2/6.3 subscribe/redeem (`@rose/rose-note`)** are the exact composition template: resolve pair → eligibility/authorize pre-write → `mint.start`/`burn.start` (PENDING/SUBMITTED, NO entry) → `confirm` posts ONE balanced entry at the commit point; status derived from the outbox row; idempotency-conflict fail-closed. 8.3 adds the position write to the confirm effect. [Source: `subscribe.ts`, `redeem.ts`]
- **5.3/5.4 effects** (`makeMintPairLedgerEffect`/`makeBurnPairLedgerEffect`) already post BOTH legs from the single confirmed amount + cross-check intent vs on-chain (divergence ⇒ post nothing) + guard plan account overlaps — reused verbatim; 8.3 wraps them. [Source: `mint-pair.ts`, `burn-pair.ts`]
- **8.2 repository** (`createPosition`/`getPosition`/`closePosition`) all take a `RoseExecutor` and compose inside an outer transaction (`createPosition` runs no own tx; `closePosition` row-locks `FOR UPDATE` — nests as a savepoint under the confirm tx). Reused unchanged; leverage pinned `'1'`. [Source: `repositories/positions.ts`]

### Testing standards

- Vitest, co-located `*.test.ts`. DB integration tests share ONE database, run **serially** (`fileParallelism:false`): `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `TRUNCATE positions, coupled_pairs, journal_entries, outbox_events CASCADE` per test. Mock EIP-1193 transport + synthetic confirmed events (NO Sepolia, NO key). Test-first on: no-optimistic-success (0 entries/positions at submit), commit-point balanced entry + position OPEN, paired both-legs (single-leg impossible), close ⇒ CLOSED, idempotent re-confirm, authorization/eligibility veto opens/closes nothing. [Source: `subscribe.test.ts`; CYCLE-BRIEF "Tests"]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Full gate (Node 20 local; engine warns, non-fatal): `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm test` → 871 passed / 103 files (12 new in `positions/position-service.test.ts`), `pnpm format` + `format:check` ✓, `pnpm check:regime` ✓ (`/prod` ↮ `/throwaway`), `pnpm check:migrations` ✓ (up→down→up over 9 migrations — NO new migration; 8.3 adds no schema), `forge test` → 171 passed (no Solidity touched).
- `@rose/positions` gained `@rose/chain`, `@rose/rose-note`, `viem` deps (+ tsconfig refs); `pnpm install` to link. No import cycle (chain/rose-note do not depend on positions).
- `closeViewFromRow` cannot read a `positionId` from the burn payload (the 5.4 `burnPairIntentSchema` is `{coupledPairId, lFrom, sFrom, amount}` — fixed shape, no positionId); reworked to derive the position from persisted state `(coupledPairId, owner=lFrom)` (most-recently-updated), consistent with `confirmClose` deriving the OPEN position the same way.

### Completion Notes

- New `position-service.ts` in `@rose/positions` (architecture L345). `makePositionService` COMPOSES the proven seams — authors no new mint/burn/ledger primitive:
  - **open** drives the REAL FR-11/FR-18 subscribe+mint path: `MintPairDualWrite.start` submits a PAIRED `mintPair(owner, owner, amount)` (PENDING/SUBMITTED, NO ledger entry, NO position row — no optimistic success). At the confirmed `PairMinted` **commit point**, a single composed `LedgerEffect` (`makeMintPairLedgerEffect` + the 6.2 `buildSubscriptionMintPlan`, THEN `createPosition`) posts ONE balanced both-legs entry (incl. `NOTE_LIABILITY`) AND records the position **atomically in the same `saga.confirmFromEvent` transaction** — entry = pair anchor P₀, size = the confirmed on-chain amount, leverage pinned `'1'`.
  - **close** drives the REAL FR-21 redeem/burn path: `BurnPairDualWrite.start` submits a PAIRED `burnPair(owner, owner, sizeUnits)` (PENDING/SUBMITTED, NO burn entry, position stays OPEN). At the confirmed `PairBurned` commit point, a composed `LedgerEffect` (`makeBurnPairLedgerEffect` + the 6.3 `buildRedemptionBurnPlan`, THEN `closePosition`) posts ONE balanced both-legs retirement entry AND flips the position `OPEN → CLOSED` atomically.
- **Both-or-neither / single-leg impossible:** the 5.3/5.4 effects ALWAYS post BOTH leg-quantity postings from the single confirmed on-chain amount (tested: 4 quantity postings per entry); the on-chain `mintPair`/`burnPair` are atomic by the unchanged epic-4 coupling contract (not re-audited). The user holds the WHOLE package (`lTo == sTo == owner`); the `side` is the off-chain Option-C view.
- **On-chain tx is the commit point (no optimistic success):** before confirmation NO position row exists (open) / the lifecycle stays OPEN (close); the pending state is observable from the 5.2 outbox row (mirrors 6.2/6.3). Idempotent under re-delivery (re-confirm ⇒ saga no-op ⇒ no duplicate entry/position/close — tested). A vetoed authorization (DENY ⇒ `MintAuthorizationError`) or eligibility refusal (FR-19) opens/closes nothing (tested).
- **Atomicity:** the position write runs inside the same `db.transaction` as the balanced entry + `SUBMITTED→CONFIRMED` flip + `journal_entries.tx_hash` stamp; if the position write throws, the whole confirm rolls back (the row stays SUBMITTED for reconcile 5.6) — nothing partial commits. `closePosition` (8.2) row-locks `FOR UPDATE` and nests as a savepoint under the confirm tx.
- **Scope held:** standard whole-package / same-user open & close only. The independent single-side close (D1 topology, opposite leg held by ANOTHER user) + its §11.4 solvency guardrail is Story 8.6 — NOT built. No API/web (8.4), no reconciliation (8.5). 8.2 schema/repository core unchanged; 5.2/5.3/5.4/6.2/6.3 reused unchanged; no contract change.
- **PAPER/LOCAL only:** tests use the local Postgres (5544) + a mock EIP-1193 transport + SYNTHETIC confirmed `PairMinted`/`PairBurned`. NO Sepolia, NO key, NO secret. Real live-watcher wiring (incl. the `side` recovery threaded through `confirmOpen`) rides with the existing 5.x/6.x ops-deferred items.

### File List

- `prod/packages/positions/src/position-service.ts` (new — the open/close composition service)
- `prod/packages/positions/src/position-service.test.ts` (new — 12 tests, local Postgres + mock transport + synthetic events)
- `prod/packages/positions/src/index.ts` (edit — re-export `position-service`)
- `prod/packages/positions/package.json` (edit — add `@rose/chain`, `@rose/rose-note`, `viem` deps)
- `prod/packages/positions/tsconfig.json` (edit — add `../chain`, `../rose-note` references)
- `pnpm-lock.yaml` (edit — link new workspace deps)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (edit — 8-3 backlog → … → review)

## Change Log

| Date       | Version | Description                                                       | Author |
| ---------- | ------- | ----------------------------------------------------------------- | ------ |
| 2026-06-19 | 0.1     | Story drafted (create-story), ready-for-dev                       | Amelia |
| 2026-06-19 | 0.2     | Implemented `position-service.ts` (open over subscribe/mint, close over redeem/burn; position created/closed AT the on-chain commit point, atomically with the balanced entry; both-or-neither; idempotent; no optimistic success). Gate green (test 859→871, forge 171, migrations 9). Status review | Amelia |
| 2026-06-19 | 0.3     | Adversarial review (3 lenses) + live-Postgres DB probes. No High/Med findings; 3 commit-point regression tests added (crash-resume leaves NO half-open position; close-DENY veto leaves position OPEN; divergent confirm = atomic rollback, row stays SUBMITTED). Gate green (test 871→874, forge 171, migrations 9). DB left migrated+seeded. Status done | Amelia (review) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (adversarial, fresh-context). **Date:** 2026-06-19. **Outcome:** APPROVE — merge-ready.

### Scope & method

Reviewed across three lenses — Correctness (the both-or-neither atomicity, the commit-point semantics, saga compensation/idempotency, balanced journal entries), Edge-cases (probed via the live Postgres on :5544 through the integration tests — postings counts, `positions.lifecycle`, `outbox_events.status`, `journal_entries.tx_hash`), Acceptance (every AC element; no scope creep into 8.4/8.5/8.6). Full gate re-run green; DB left migrated+seeded.

### Correctness

- **Both-or-neither / single-leg impossible (AC #1/#2):** the composed `LedgerEffect` reuses the unchanged 5.3/5.4 `makeMintPairLedgerEffect`/`makeBurnPairLedgerEffect`, which ALWAYS post BOTH leg-quantity postings from the single confirmed on-chain amount (verified: 4 quantity postings + 2 value postings per entry). The on-chain `mintPair`/`burnPair` are atomic by the unchanged epic-4 coupling contract (not re-audited). There is no code path that posts one leg or mints/burns a single side.
- **On-chain tx is the commit point, NO optimistic success:** `openPosition`/`closePosition` only submit (PENDING/SUBMITTED) — verified 0 journal entries / 0 positions at open-submit, and the position stays OPEN at close-submit. The position is created (open) / flipped to CLOSED (close) ONLY inside the `saga.confirmFromEvent` transaction, atomically with the balanced entry + the `SUBMITTED→CONFIRMED` flip + the `journal_entries.tx_hash` stamp. A new regression confirms a crash between submit and commit leaves a `SUBMITTED` outbox row (5.6-re-drivable) and NO half-open position.
- **Atomic rollback on anomaly:** a new regression drives a divergent confirm (on-chain amount ≠ recorded intent); the 5.3 effect throws, the whole confirm transaction rolls back — NOTHING commits (0 entries, 0 positions) and the row stays `SUBMITTED` (a reconcile-5.6 signal), never CONFIRMED. `confirmOpen`/`confirmClose` never throw into the (fire-and-forget) watcher.
- **Idempotency (NFR-9):** reused across the 5.2 saga (idempotency key + tx-hash unique + already-CONFIRMED no-op). Re-delivering the same confirmed `PairMinted`/`PairBurned` is a no-op — verified no duplicate entry/position (open) and no duplicate burn entry / re-close (close).
- **Balanced journal entries:** open posts cash DEBIT / `NOTE_LIABILITY` CREDIT (issued-note obligation); close posts `NOTE_LIABILITY` DEBIT / cash CREDIT — verified the `NOTE_LIABILITY` net is `-AMOUNT` after open and `0` after the round-trip. Money exact (bigint quantities; `entry` = anchor P₀ `decimal(18,8)`; leverage pinned `'1'`).

### Edge-cases & fail-closed

- **Eligibility (FR-19)** refusal on open ⇒ `IneligibleSubscriberError`, nothing written (0 outbox rows). **Authorization veto (DENY)** ⇒ `MintAuthorizationError` (open) / `BurnAuthorizationError` (close) BEFORE submit — verified no entry and the position untouched (still OPEN on a vetoed close).
- **Lifecycle guard:** closing a missing/already-CLOSED position fails closed (`PositionNotFoundError`/`PositionLifecycleError`) before any submit. Pair-not-ACTIVE fails closed (`PositionPairNotActiveError`).
- **`closeViewFromRow`/`confirmClose` derive the position from persisted state** `(coupledPairId, owner=lFrom)` (the 5.4 burn payload carries no `positionId`); the 8.3 whole-package case is one OPEN position per (owner, pair) — a 0/≠1 match is a non-applied anomaly (logged, nothing closed), never a wrong close. Documented P0.
- **Checksum consistency:** owner addresses are EIP-55 normalized via `getAddress` on every write/read path, so the `(coupledPairId, owner)` derivation matches the stored owner exactly.

### Acceptance

- **AC #1 (open acquires exposure via the real FR-11/FR-18 subscribe+mint path; records the position; paired both-or-neither mint; single-leg impossible):** MET.
- **AC #2 (close routes the real FR-21 redeem/burn path; paired both-or-neither burn; lifecycle → CLOSED with balanced journal entries; no single-leg burn) + the open/close composes the existing outbox/saga with the on-chain tx as the commit point (no optimistic success):** MET.
- **No scope creep:** standard whole-package / same-user open & close only. The **independent single-side close where the opposite leg is held by ANOTHER user (the D1 topology)** is held OUT — explicitly Story 8.6 (§8 Q8 + §11.4 guardrail); no API/web (8.4), no reconciliation (8.5). 8.2 schema/repository core, 5.2/5.3/5.4, 6.2/6.3, and the contracts are reused UNCHANGED.

### Findings & Action Items

- **No High/Med findings.** 3 commit-point regression tests added during review (crash-resume, close-DENY veto, divergent-confirm atomic rollback).
- **[Low — documented, no fix]** `confirmOpen` carries `side` from the composition layer (the fixed 5.3 mint intent payload cannot persist the off-chain `side`); a bare watcher re-deriving `side` rides with the deferred live-Sepolia wiring (consistent with how 6.x `confirm` is driven by the layer holding the request context). Documented as a P0 interpretation.
- **[Low — documented, no fix]** `getOpenPosition` on a still-pending flow has no persisted `side` source and reflects `LONG` as a placeholder until the position is created at confirmation (the authoritative `side` is on the persisted position; the API in 8.4 reads the confirmed position). Out of 8.3 scope.
