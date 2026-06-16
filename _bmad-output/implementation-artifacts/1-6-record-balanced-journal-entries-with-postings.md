---
baseline_commit: NO_VCS
---

# Story 1.6: Record balanced journal entries with postings

Status: done

## Story

As an internal operator,
I want to record an economic event as a balanced journal entry of two or more postings,
so that every movement is captured in the accounting system of record with an audit trail (FR-2, NFR-3).

## Acceptance Criteria

**AC-1 — Record a balanced, ≥2-posting entry; integer amounts only**
**Given** the ledger recording path
**When** I record a journal entry of two or more postings (debits/credits) against accounts
**Then** the entry persists only if balanced, carries a non-empty human-readable `description`, and may optionally link to a coupled pair
**And** every posting amount is an integer in smallest units (no binary-float amount can be stored)

**AC-2 — Recorded entries are attributable and append-oriented**
**Given** a recorded journal entry
**When** I query the ledger
**Then** the entry is attributable and append-oriented, supporting the audit trail (NFR-3)

## Tasks / Subtasks

- [x] **Task 1 — `recordJournalEntry` recording API (AC: 1)**
  - [x] `prod/packages/ledger/src/repositories/journal-entries.ts`: `recordJournalEntry(db, input)` where `input = { description, coupledPairId?, postings: Array<{ accountId, direction: 'DEBIT'|'CREDIT', amount: bigint }> }`.
  - [x] Validate (typed errors, before touching the DB): `description` non-empty after trim; **≥ 2 postings**; each `amount` is a **bigint** (reject JS `number`/float via `@rose/shared`'s `assertNotFloat`) and `> 0`; **Σ debits = Σ credits** (BigInt) — else throw `UnbalancedEntryError` naming the difference. (The DB trigger from Story 1.5 is the backstop; this gives a friendly domain error.)
  - [x] Insert the `journal_entries` row + all `postings` in a **single transaction** (`db.transaction`). Store `amount` as the canonical integer (NUMERIC string). Return the created entry with its postings.
  - [x] Typed errors: `UnbalancedEntryError`, `InvalidJournalEntryError` (too few postings / empty description / non-positive or float amount).
- [x] **Task 2 — Query / audit read path (AC: 2)**
  - [x] `getJournalEntry(db, id)` returns the entry plus its postings (deterministic order), so an entry is attributable end-to-end. Amounts returned as integer smallest-units (bigint) — convert from the NUMERIC string.
  - [x] Append-oriented: the repository exposes record + read only — **no update/delete** of entries/postings in the API surface (NFR-3 audit trail).
- [x] **Task 3 — Tests (AC: 1, 2)**
  - [x] `journal-entries.test.ts` (Vitest, against Postgres): records a balanced 2-posting entry and reads it back (attributable, postings present); optional `coupledPairId` stored; an unbalanced input throws `UnbalancedEntryError` and **persists nothing**; `< 2` postings and empty description throw `InvalidJournalEntryError`; a float `amount` is rejected (no float stored — NFR-2); large 18-decimal token magnitudes (bigint beyond `Number.MAX_SAFE_INTEGER`) round-trip exactly through NUMERIC.
  - [x] Confirm the DB trigger still backstops: a balanced app-level record commits; an attempt that the app would reject is also rejected by the DB (already covered in Story 1.5).
- [x] **Task 4 — Verification gate (AC: 1, 2)**
  - [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` green; `forge test` green.

## Dev Notes

### Scope
- IS: the application **recording primitive** for journal entries (FR-2) + an attributable read path (NFR-3), on top of Story 1.5's schema and DB-enforced invariant. IS NOT: the `postTransfer` chokepoint (Epic 3 — the only writer of *transfer* postings), coupled-pair issuance (Epic 2), or surfaces (Epic 6). `recordJournalEntry` is the general recording primitive those build on.

### Architecture constraints (authoritative)
[Source: architecture.md#Data Architecture, #Naming Patterns, NFR-2, NFR-3]
- A journal entry has **two or more postings**; persists **only if balanced** (DB-enforced, Story 1.5); a **non-empty `description`**; an **optional** link to a coupled pair.
- Amounts are **integers in smallest units** (`BigInt` in TS, `NUMERIC` in PG); **binary float prohibited** (NFR-2). Reject any float at the boundary.
- **Auditability (NFR-3):** every movement attributable to a journal entry (with `description`); ledger is **append-oriented**. (On-chain tx-hash attribution comes later, Epic 5.)
- Domain function name uses the glossary; this is the off-chain ledger recording path. Money math via `@rose/shared` (BigInt, no float).

### Prior-story learnings (1.2, 1.4, 1.5)
- `@rose/shared` provides `assertNotFloat` and exact-money helpers — reuse for amount validation (no float). Amounts are bigint smallest-units; `NUMERIC` column returns a string (parse to bigint on read).
- `@rose/ledger` schema (`journal_entries`, `postings`, `posting_direction`) and the DEFERRABLE balance trigger exist (Story 1.5). Use Drizzle `db.transaction(...)` for the multi-row insert; the trigger checks at COMMIT.
- Integration tests share one DB and run serially (`vitest.config.ts fileParallelism:false`); reuse `hardReset` + `migrateUp` in `beforeAll`, `TRUNCATE ... CASCADE` for per-test isolation, `pool.end()` in `afterAll`. Postgres `:5544` local / `:5432` CI.
- Typed error classes for refusals (cf. `AccountPlacementError`, `ConfigRefusalError`).

### Implementation guidance
- Pre-validate balance in BigInt and throw `UnbalancedEntryError` with the debit/credit totals — do not rely solely on the DB exception for a clean caller-facing error (the DB trigger remains the non-bypassable backstop).
- Use `db.transaction` so a rejected entry leaves **no partial state** (consistent with the DB guarantee).
- Convert `amount: bigint` → string for the NUMERIC column; on read, `BigInt(row.amount)` (the value is an integer string).
- **Cross-asset balancing:** this story's balance check follows the invariant established in Story 1.5 (Σ debits = Σ credits per entry). If Story 1.5's review tightened the invariant to per-asset, mirror that here (group debit/credit sums by the posting account's asset). Keep this one decision consistent across the trigger and the app check.
- Keep the API append-oriented: expose `recordJournalEntry` + `getJournalEntry` only; no entry/posting mutation.

### Testing standards
[Source: architecture.md NFR-2/NFR-3/NFR-6] — Vitest integration tests; cover balanced record + read-back, unbalanced/too-few/empty-description/float rejections (no partial state), and big-magnitude bigint round-trip.

### References
- [Source: epics.md#Story 1.6] — user story + both AC scenarios.
- [Source: epics.md#Functional Requirements FR-2; NonFunctional NFR-3] — record balanced journal entries with postings; auditability/append-oriented.
- [Source: architecture.md#Data Architecture] — integer amounts (BigInt/NUMERIC), description, optional coupled-pair link.
- [Source: 1-5-...md] — the DB-enforced double-entry invariant this builds on.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green, docker PG18): typecheck 0; lint 0; test → 7 files, 87 tests; format 0; regime 0; `check:migrations` → "Reversibility OK over 2 migration(s)"; `forge test` → 3 passed.

### Completion Notes List

- **AC-1 satisfied:** `recordJournalEntry` records a balanced ≥2-posting entry in one `db.transaction`, with a non-empty `description` and an optional `coupledPairId`. Amounts are **bigint** smallest-units; JS floats are rejected (`assertNotFloat` from `@rose/shared`) and non-positive amounts refused — no float can be stored (NFR-2). Balance is validated **per (asset, scale)** at the app layer (clean `UnbalancedEntryError`) with the Story 1.5 DB trigger as the non-bypassable backstop.
- **AC-2 satisfied:** `getJournalEntry` returns the entry + its postings (deterministic order) as an attributable audit view with amounts as bigint. The repository is **append-oriented** — only `recordJournalEntry` + `getJournalEntry` are exposed (no update/delete), and the ≥2-postings rule also closes Story 1.5's deferred zero-postings concern at the application boundary.
- `@rose/ledger` now depends on `@rose/shared` (workspace) for `assertNotFloat`; added a project reference so `tsc -b` resolves it.
- Tests cover: balanced record + read-back, optional pair link, **18-decimal token magnitudes round-tripping through NUMERIC** (bigint beyond MAX_SAFE_INTEGER), unbalanced/cross-asset/too-few-postings/empty-description/float rejections (persisting nothing), and unknown-id read.
- Scope discipline: the general recording primitive only — no `postTransfer` chokepoint (Epic 3), no coupled-pair issuance (Epic 2), no surfaces (Epic 6).

### File List

- `prod/packages/ledger/src/repositories/journal-entries.ts` (new — `recordJournalEntry`, `getJournalEntry`, typed errors)
- `prod/packages/ledger/src/journal-entries.test.ts` (new)
- `prod/packages/ledger/src/index.ts` (modified — export the journal-entries repository)
- `prod/packages/ledger/package.json` (modified — add `@rose/shared` workspace dep)
- `prod/packages/ledger/tsconfig.json` (modified — reference `../shared`)
- `pnpm-lock.yaml` (modified — workspace link)

## Change Log

- 2026-06-16 — Story 1.6 implemented: `recordJournalEntry` / `getJournalEntry` recording primitive on `@rose/ledger` — balanced (per-asset) ≥2-posting entries with non-empty description and optional coupled-pair link, bigint integer amounts (no float, NFR-2), transactional insert with the DB double-entry trigger as backstop, and an append-oriented attributable read path (NFR-3). TDD; 87 tests total. All gates green. Status → review.
- 2026-06-16 — Code review (3 adversarial layers, live DB) + remediation: defensive `numeric→bigint` in the read path (tolerates a scale-bearing-but-integer `100.000` from a non-app writer); validate `direction ∈ {DEBIT,CREDIT}` and `coupledPairId` is a UUID (typed errors); float now throws `InvalidJournalEntryError` (consistent typed API); collision-safe per-asset group key; trimmed description on store. +3 tests (90 total). All gates green. Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 parallel adversarial layers, run against the live Postgres 18)
**Date:** 2026-06-16
**Outcome:** Approve (after remediation). Both ACs independently confirmed met; all three reviewers found no path that persists an unbalanced/corrupt entry; no scope creep.

### Acceptance verdict
- **AC-1 (balanced ≥2-posting entry; integer amounts only):** SATISFIED — per-asset balance check + ≥2 + non-empty description + optional pair link; floats rejected; transactional insert with DB trigger backstop; big-magnitude bigint round-trip exact.
- **AC-2 (attributable, append-oriented):** SATISFIED — `getJournalEntry` returns entry + postings (bigint amounts); only record + read exposed.

### Action Items
- [x] [Review][Patch][Med] The audit read path `BigInt(row.amount)` assumed scale-0 NUMERIC; a non-app writer could store `100.000` (the DB CHECK enforces integer *value*, not scale 0) and break the reader. Fixed: `numericToBigInt` tolerates an all-zero fraction, rejects a real one. Test reads back a `100.000` row as `100n`. [repositories/journal-entries.ts]
- [x] [Review][Patch][Low/Med] A malformed `direction` was silently bucketed as CREDIT in the app balance check (DB enum backstopped persistence). Fixed: validate `direction ∈ {DEBIT,CREDIT}`. [repositories/journal-entries.ts]
- [x] [Review][Patch][Low] Non-UUID `coupledPairId` surfaced a raw pg error; float threw `TypeError` not the typed error; per-asset group key could collide on a space-bearing asset; description stored un-trimmed. Fixed: UUID validation, float → `InvalidJournalEntryError`, JSON-tuple group key, trimmed description. [repositories/journal-entries.ts]
- [x] [Review][Dismiss][Low] No cross-entity check — a journal entry spanning multiple entities is **legitimate** (the ledger is consolidated across the four entities by design). TOCTOU (accounts read before the tx) is non-material — the DEFERRABLE COMMIT-time trigger is the authoritative arbiter. No action.
