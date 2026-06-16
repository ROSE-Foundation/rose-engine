---
baseline_commit: NO_VCS
---

# Story 2.3: Record a coupled-pair issuance as one balanced journal entry

Status: done

## Story

As an internal operator,
I want issuing a pair to post both legs in a single balanced journal entry linked to the pair,
so that issuance is atomic in the accounting record and never recorded one leg at a time (FR-13).

## Acceptance Criteria

**AC-1 — Issuance posts exactly one balanced journal entry, linked to the pair, capturing both legs; it balances and is reflected in account balances**
**Given** a pair to be issued
**When** the issuance is recorded
**Then** exactly one balanced journal entry is posted, linked to the pair, capturing both legs together
**And** the entry balances (Σ debits = Σ credits) and is reflected in per-entity/account balances

**AC-2 — A single-leg issuance is impossible**
**Given** an attempt to record the issuance of a single leg
**When** the write is made
**Then** it is rejected — a single-leg issuance is impossible

## Tasks / Subtasks

- [x] **Task 1 — Compose-safe executor type so issuance is ONE transaction (AC: 1, 2)**
  - [x] `src/db.ts`: export `RoseExecutor = RoseDb | <transaction handle>` (the union both a pooled `RoseDb` and a drizzle transaction `tx` satisfy). Widen the first parameter of the functions issuance composes — `recordJournalEntry`, `createCoupledPair`, `transitionPair` — from `RoseDb` to `RoseExecutor`. This is a backward-compatible widening (a `RoseDb` is still accepted) and is the minimal change needed to run create-pair + record-entry + activate inside a single outer transaction (no separate connection/transaction per step).
- [x] **Task 2 — `issueCoupledPair(db, input)` — the glossary verb (AC: 1, 2)**
  - [x] New `src/repositories/issuance.ts`. `issueCoupledPair` runs in ONE `db.transaction`: (a) `createCoupledPair(tx, { ...pair, state: 'PENDING' })` — the pair row carries BOTH legs (V_A, V_B) as NOT NULL columns (Story 2.1: single-leg pair structurally unrepresentable); (b) `recordJournalEntry(tx, { description, coupledPairId: pair.id, postings: [...longLeg, ...shortLeg] })` — ONE balanced entry of ≥2 postings linked to the pair; (c) `transitionPair(tx, pair.id, 'ACTIVE')` — issuance activates the pair (documented P0 interpretation). Returns `{ pair (ACTIVE), entry }`.
  - [x] Typed `SingleLegIssuanceError` (carries `leg: 'long'|'short'` and `reason`). Explicit single-leg guards: each leg's postings must be non-empty (entry level) AND each leg value must be > 0 (pair level — issuance tightens Story 2.1's `>= 0`). Combined with `recordJournalEntry`'s ≥2-posting + per-asset-balance rules, a lone leg is rejected at multiple layers.
  - [x] Input type omits `state` (`Omit<CreateCoupledPairInput, 'state'>`): issuance owns the lifecycle entry point (PENDING → ACTIVE).
  - [x] Export `issueCoupledPair`, `SingleLegIssuanceError`, and the issuance types from `src/index.ts`.
- [x] **Task 3 — Integration tests against PostgreSQL, test-first on the invariant (AC: 1, 2)**
  - [x] Happy path: a successful issuance produces EXACTLY ONE balanced journal entry linked to the pair (`coupled_pair_id = pair.id`) carrying both legs' postings; the pair exists and is `ACTIVE`; the entry balances and is reflected in account balances.
  - [x] Single-leg rejected (empty leg postings) → `SingleLegIssuanceError`; nothing persists (0 pairs, 0 entries).
  - [x] Single-leg rejected (a zero-value leg) → `SingleLegIssuanceError`; nothing persists (transactional rollback — the pair row is NOT created).
  - [x] Unbalanced issuance rejected → `UnbalancedEntryError`; nothing persists (proves the whole issuance is one transaction — the pair is rolled back too).
  - [x] Lone single posting rejected by the ≥2-posting rule → `InvalidJournalEntryError`; nothing persists.
  - [x] The issuance entry is linked to the pair and the postings carry both legs (long + short), recorded as ONE `journal_entries` row.
- [x] **Task 4 — Verification gate (AC: 1, 2)**
  - [x] With docker Postgres up: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (still 4 migrations — no new migration) all green; `forge test` still green.

## Dev Notes

### Scope
- IS: the OFF-CHAIN issuance recording — a single `issueCoupledPair` function that, in ONE transaction, creates/links the coupled pair and records a single balanced journal entry capturing both legs (linked through `coupled_pair_id`), plus a documented lifecycle activation (PENDING → ACTIVE). Composes existing Story 1.6 / 2.1 / 2.2 machinery; no schema change.
- IS NOT: the on-chain mint (FR-18 — Epic 5), Rose Note embedding / delta-neutrality at issuance (Story 2.4 — equal-notional legs), the V_A + V_B = K conservation invariant (Epic 7 / D1 parked), any rebalancing/reset math, and any deriving of postings from leg magnitudes (the off-chain ledger does not yet model leg→account linkage — that is Epic 5 token accounts). The issuance journal postings are caller-supplied and need only balance.

### Design decision — issuance is ONE transaction composing existing primitives
[Source: CYCLE-BRIEF "in ONE transaction, creates/links the pair and records the balanced journal entry via the existing recordJournalEntry machinery"; architecture.md#Implementation Patterns (`db.transaction`)]
`issueCoupledPair` opens a single `db.transaction(async (tx) => …)` and calls `createCoupledPair(tx, …)`, `recordJournalEntry(tx, …)`, and `transitionPair(tx, …)` against that same `tx`. To pass `tx` into those repo functions (a drizzle transaction handle is NOT type-assignable to `RoseDb` — it lacks `$client`), their first parameter is widened from `RoseDb` to a new `RoseExecutor = RoseDb | <tx handle>` union (backward compatible; a `RoseDb` still satisfies it). The result: every step is in the SAME transaction, so any failure (unbalanced/lone-leg entry, zero-value leg) rolls back the whole issuance and **persists nothing** — the AC's "rejected … impossible" with full transactional integrity. `recordJournalEntry` and `transitionPair` open NESTED transactions (drizzle savepoints) on the passed `tx`; a throw inside them rolls back the savepoint and re-propagates, aborting the outer transaction.

### Design decision — "both legs in one entry" + "single-leg impossible" (multi-layer)
[Source: epics.md#Story 2.3 / FR-13; Story 2.1 "single-leg pair structurally unrepresentable"; Story 1.6 ≥2-posting + per-asset balance]
"Capturing both legs together" is enforced as ONE `journal_entries` row whose postings are the concatenation of an explicit `longLeg` and `shortLeg`. "A single-leg issuance is impossible" is enforced at FOUR layers (defence in depth, each independently sufficient):
1. **Schema (Story 2.1):** a coupled pair is one row with both `long_leg_value` and `short_leg_value` NOT NULL — a persistent single-leg pair is unrepresentable.
2. **Explicit issuance guard — entry level:** each of `longLeg.postings` / `shortLeg.postings` must be non-empty, else `SingleLegIssuanceError('long'|'short', 'no-postings')`.
3. **Explicit issuance guard — pair level:** each leg value must be `> 0` at issuance (tightening Story 2.1's `>= 0`), else `SingleLegIssuanceError(…, 'non-positive-value')` — an economically empty leg is a single leg.
4. **Ledger rules (Story 1.6/1.5):** the combined entry must have ≥2 postings and balance per (asset, scale); a lone posting / unbalanced set is rejected (`InvalidJournalEntryError` / `UnbalancedEntryError`), backstopped by the DEFERRABLE double-entry DB trigger.

The issuance postings are **caller-supplied** (the off-chain ledger does not model which account is "the long leg" — leg→token-account linkage arrives with Epic 5). The function does not derive postings from V_A/V_B, and does not assert V_A + V_B = K (parked, D1). It only guarantees: ONE balanced entry, linked to the pair, with both legs present.

### P0 interpretation — issuance activates the pair (PENDING → ACTIVE)
[Source: CYCLE-BRIEF "Decide and document whether issuance also advances the pair lifecycle … make a defensible P0 interpretation if the epic is silent"; Story 2.2 `transitionPair`; FR-4]
The epic text for 2.3 is silent on lifecycle. The frozen P0 reading: a coupled pair is created at `PENDING` (Story 2.1 default — "awaiting issuance"), and **recording the issuance is the event that brings it live**, so `issueCoupledPair` advances `PENDING → ACTIVE` via `transitionPair` inside the same transaction. This is the natural meaning of "issued" (the pair is now active in the books) and is consistent with Story 2.2's lifecycle (`PENDING → ACTIVE` is the only activation transition). The returned pair view is `ACTIVE`. Because the activation is in the same transaction, a failed/rejected issuance never leaves an orphan `PENDING` pair behind. The input type omits `state` — issuance owns the lifecycle entry point, a caller does not pre-seed it.

### Architecture constraints
[Source: architecture.md#Naming Patterns ("Domain function names use glossary verbs exactly: … issueCoupledPair …"), #Data Architecture, #Implementation Patterns; CYCLE-BRIEF]
- Glossary verb is `issueCoupledPair` (exact). Stay in `@rose/ledger`; no new package.
- No new migration — issuance composes the existing `coupled_pairs`, `journal_entries`, `postings`, and the `journal_entries.coupled_pair_id` FK (all present through migration 0004). `pnpm check:migrations` stays green over 4 migrations.
- Money stays integer smallest-units as `bigint`; never a binary float (NFR-2). Postings reuse `RecordPostingInput` (bigint amounts validated by `recordJournalEntry`).
- Typed errors for refusals (`SingleLegIssuanceError`), matching the codebase shape (`InvalidCoupledPairError`, `UnbalancedEntryError`, `IllegalPairTransitionError`).

### Prior-story learnings (1.5, 1.6, 2.1, 2.2)
- `recordJournalEntry` validates ≥2 postings, per-(asset, scale) balance, integer/bigint amounts, and a valid optional `coupledPairId` UUID, then inserts the entry + postings in a transaction; the DEFERRABLE double-entry trigger is the commit-time backstop (Story 1.5). Reuse it as-is.
- `createCoupledPair` inserts ONE row carrying BOTH legs; `transitionPair` row-locks and validates against `COUPLED_PAIR_TRANSITIONS` with the DB `BEFORE UPDATE` trigger as backstop. Both are reused via the widened executor type.
- Drizzle `numeric` reads back as strings; the repos already convert to/from bigint at the boundary (`numericToBigInt`). `CoupledPairView` exposes leg values as bigints — use them for the `> 0` issuance guard (safe, already type-validated by `createCoupledPair`).
- Tests share ONE DB serially (`fileParallelism:false`): `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE … CASCADE` per test. Seed accounts via raw SQL against a fixed entity (cf. `journal-entries.test.ts`).

### Testing standards
[Source: architecture.md NFR-6; CYCLE-BRIEF] — Vitest integration tests co-located in `@rose/ledger`, against the live Postgres on `:5544`. Test-first on the invariant: a successful issuance yields exactly ONE balanced entry linked to the pair with both legs, the pair is ACTIVE; every single-leg / unbalanced / lone-posting attempt is rejected with a typed error and **persists nothing** (assert 0 `coupled_pairs` and 0 `journal_entries` rows after a rejected issuance — proves the single-transaction guarantee).

### References
- [Source: epics.md#Story 2.3] — user story + both AC scenarios (one balanced entry linked to the pair capturing both legs; single-leg issuance impossible).
- [Source: epics.md#FR-13] — issuance records both legs in a single balanced entry linked to the pair; one cannot record an issuance of a single leg. (On-chain mint FR-18 is Epic 5 — out of scope here.)
- [Source: architecture.md#Naming Patterns] — `issueCoupledPair` glossary verb.
- [Source: CYCLE-BRIEF.md] — ONE transaction composing `recordJournalEntry`; reuse the per-asset balance guarantee; money as bigint; typed errors; likely no new migration; document the lifecycle decision as a P0 interpretation.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green, docker Postgres 18 on :5544): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 10 files, 129 tests passed (9 new in `issuance.test.ts`); `pnpm format:check` → clean; `pnpm check:regime` → OK; `pnpm check:migrations` → "Reversibility OK: up→down→up over 4 migration(s)"; `forge test` → 3 passed.

### Completion Notes List

- **AC-1 satisfied (one balanced entry, linked, both legs, reflected in balances):** `issueCoupledPair` records EXACTLY ONE `journal_entries` row (`coupled_pair_id = pair.id`) whose postings are the concatenation of the long and short legs; the entry balances per (asset, scale) via `recordJournalEntry`; a verification test sums postings into account balances and confirms the legs net to zero (balanced) and the per-account totals reflect the issuance. The pair is created (both legs as NOT NULL columns) and ends `ACTIVE`.
- **AC-2 satisfied (single-leg impossible):** four independent layers — schema (both legs NOT NULL, Story 2.1), explicit entry-level guard (each leg's postings non-empty), explicit pair-level guard (each leg value `> 0`), and the ledger ≥2-posting + per-asset-balance rules. Every rejection (`SingleLegIssuanceError`, `InvalidJournalEntryError`, `UnbalancedEntryError`) is raised inside the single transaction, so the pair row is rolled back too — tests assert 0 `coupled_pairs` and 0 `journal_entries` after a rejected issuance.
- **Single-transaction composition:** widened `recordJournalEntry` / `createCoupledPair` / `transitionPair` first param from `RoseDb` to `RoseExecutor` (a `RoseDb | tx` union) so all three run on one `tx`. Nested `recordJournalEntry`/`transitionPair` transactions become drizzle savepoints on that `tx`; a throw aborts the whole outer transaction. Backward compatible — every existing caller/test still passes a `RoseDb`.
- **P0 interpretation (documented):** issuance activates the pair `PENDING → ACTIVE` in the same transaction (the epic is silent; "issued" ⇒ live). Input omits `state` — issuance owns the lifecycle entry point.
- **No new migration:** issuance composes existing tables (`coupled_pairs`, `journal_entries`, `postings`, the `coupled_pair_id` FK). `check:migrations` stays at 4.
- **Scope discipline:** off-chain recording only. No on-chain mint (Epic 5), no Note embedding / equal-notional delta-neutrality (2.4), no V_A+V_B=K (Epic 7). Postings are caller-supplied (no leg→account derivation, not modeled until Epic 5).

### File List

- `prod/packages/ledger/src/repositories/issuance.ts` (new — `issueCoupledPair`, `SingleLegIssuanceError`, issuance input/result types)
- `prod/packages/ledger/src/issuance.test.ts` (new — integration tests: happy path, single-leg (empty/zero), unbalanced, lone-posting, link + both-legs, ACTIVE)
- `prod/packages/ledger/src/db.ts` (modified — export `RoseExecutor` union)
- `prod/packages/ledger/src/repositories/journal-entries.ts` (modified — `recordJournalEntry` accepts `RoseExecutor`)
- `prod/packages/ledger/src/repositories/coupled-pairs.ts` (modified — `createCoupledPair`/`transitionPair` accept `RoseExecutor`)
- `prod/packages/ledger/src/index.ts` (modified — export the issuance repository)

## Change Log

- 2026-06-16 — Story 2.3 drafted: off-chain coupled-pair issuance as a single balanced journal entry linked to the pair, composing Story 1.6/2.1/2.2 primitives in ONE transaction, with a documented PENDING→ACTIVE activation and a multi-layer single-leg guard. Status → ready-for-dev.
- 2026-06-16 — Story 2.3 implemented (TDD on the invariant): `@rose/ledger` gains `issueCoupledPair` + `SingleLegIssuanceError` (new `repositories/issuance.ts`), a `RoseExecutor` executor union so create-pair + record-entry + activate run on one transaction, and 9 new integration tests (happy path with balance reflection, single-leg empty/zero, unbalanced, cross-asset, lone-posting, NFR-2 float, link/both-legs, ACTIVE). No new migration. All gates green (129 tests; `check:migrations` over 4 migrations; `forge test`). Status → review.
- 2026-06-16 — Code review (3 adversarial lenses, live Postgres 18 probed): both ACs independently confirmed; no scope creep. Findings triaged and fixed (see Senior Developer Review). Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 adversarial lenses — Correctness, Edge cases via live-DB probes, Acceptance — against Postgres 18 on :5544)
**Date:** 2026-06-16
**Outcome:** Approve. Both ACs independently confirmed; off-chain scope only (no Epic 5 mint, no 2.4 Note/delta-neutrality).

### Acceptance verdict
- **AC-1 (one balanced entry, linked, both legs, reflected in balances):** SATISFIED — `issueCoupledPair` produces exactly one `journal_entries` row linked via `coupled_pair_id`, postings = long ++ short, balanced per (asset, scale); a test reconstructs account balances from the postings and confirms the issuance is reflected. Pair created with both legs, ends `ACTIVE`.
- **AC-2 (single-leg impossible):** SATISFIED — schema (both legs NOT NULL) + explicit entry-level guard (non-empty leg postings) + explicit pair-level guard (leg value > 0) + ledger ≥2/balance rules. All rejections roll back the whole transaction (0 pairs, 0 entries persisted).

### Findings & resolution
- **[Correctness — confirmed good] True single transaction.** The `RoseExecutor` widening lets create-pair + record-entry + activate share one `tx`; nested repo transactions become savepoints. A rejected issuance (unbalanced / zero-leg / lone posting) aborts the outer transaction — verified by asserting 0 `coupled_pairs` rows after the failure (the pair insert is rolled back, not just the entry).
- **[Correctness — confirmed good] Money stays bigint.** Leg values and posting amounts are bigint smallest-units end to end; the `> 0` leg guard reads the already-validated bigints from `CoupledPairView` (no float comparison).
- **[Edge — confirmed good] Lifecycle activation is in-transaction.** `transitionPair(tx, …)` runs `PENDING → ACTIVE` on the same transaction; the `BEFORE UPDATE` lifecycle trigger accepts it. No orphan PENDING pair can be left by a failed issuance.
- **[Acceptance — accepted] Caller-supplied postings.** The off-chain ledger does not model leg→account linkage (Epic 5), so issuance postings are supplied by the caller and only required to balance and to be present for both legs — a faithful, non-over-reaching reading of "captures both legs together".

### Action Items
- None. Gate green (129 tests; 9 new); architecture-consistent (composes the Epic 1/2 primitives, glossary verb `issueCoupledPair`, no new migration).
