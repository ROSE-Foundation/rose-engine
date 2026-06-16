---
baseline_commit: NO_VCS
---

# Story 1.5: Enforce the double-entry invariant in the database (test-first)

Status: done

## Story

As a build engineer,
I want the double-entry balance invariant enforced by a database constraint trigger, with its tests written first,
so that an unbalanced journal entry can never persist regardless of application path (FR-3, NFR-1, NFR-6).

## Acceptance Criteria

**AC-1 — Test-first: an unbalanced entry fails the transaction with no partial state**
**Given** the `journal_entries` and `postings` tables and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger shipped as a raw-SQL migration
**When** the invariant tests are written and run before any application recording logic exists
**Then** the tests assert that committing a journal entry where Σ debits ≠ Σ credits fails the transaction with no partial state

**AC-2 — The guarantee cannot be bypassed; balanced commits succeed**
**Given** an attempt to write postings directly (bypassing application code)
**When** the transaction commits
**Then** the database still rejects the unbalanced set — the guarantee cannot be bypassed
**And** a balanced set of postings commits successfully

## Tasks / Subtasks

- [x] **Task 1 — Write the invariant tests FIRST (AC: 1, 2; NFR-6)**
  - [x] Before adding any recording API, write `prod/packages/ledger/src/double-entry.test.ts` (Vitest, against Postgres) that drives the DB with **raw SQL only** (no application helper), proving:
    - a balanced set of postings (Σ debits = Σ credits) commits;
    - an unbalanced set fails **at COMMIT** and leaves **no partial state** (the `journal_entries` row is gone too, since it shares the transaction);
    - direct raw `INSERT`s into `postings` cannot bypass the guarantee;
    - the trigger is genuinely **DEFERRED**: inserting postings one-by-one such that an intermediate state is unbalanced but the final state balances → commits successfully.
  - [x] Confirm the tests FAIL before the migration exists (red), then pass after (green).
- [x] **Task 2 — Schema for journal entries and postings (AC: 1, 2)**
  - [x] Drizzle schema `src/schema/journal-entries.ts`: `journal_entries` — `id uuid pk`, `description text not null` (CHECK non-empty), `coupled_pair_id uuid` **nullable, no FK yet** (the `coupled_pairs` table is Epic 2 — column reserved per FR-2's "optional link to a coupled pair"; documented), `created_at timestamptz`.
  - [x] `src/schema/postings.ts`: `postings` — `id uuid pk`, `journal_entry_id uuid not null references journal_entries(id) on delete cascade`, `account_id uuid not null references accounts(id)`, `direction` enum `posting_direction` (`DEBIT|CREDIT`), `amount numeric not null` (CHECK `> 0`; integer smallest-units stored as `NUMERIC` for 18-decimal tokens — NFR-2), `created_at timestamptz`. Index `idx_postings_journal_entry_id`.
  - [x] Export inferred types; barrel from `schema/index.ts`. snake_case plural tables; FK `<singular>_id`; enum uppercase codes.
- [x] **Task 3 — Raw-SQL migration 0002 with the DEFERRABLE trigger (AC: 1, 2)**
  - [x] `src/migrations/0002-double-entry-invariant.{up}`: create `posting_direction` enum, `journal_entries`, `postings`, the index; create a plpgsql function `check_double_entry_balance()` that, for the affected `journal_entry_id`, asserts Σ(DEBIT amount) = Σ(CREDIT amount) and `RAISE EXCEPTION` otherwise; create a **`CONSTRAINT TRIGGER ... AFTER INSERT OR UPDATE OR DELETE ON postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`** calling it.
  - [x] `down`: drop the trigger, function, `postings`, `journal_entries`, `posting_direction` (reverse dependency order). Register `migration0002` in `migrations/index.ts` (append-only).
  - [x] Migration is raw SQL embedded in the typed module (consistent with 0001).
- [x] **Task 4 — Verify reversibility + no scope creep (AC: 1, 2; NFR-5)**
  - [x] `pnpm check:migrations` (`verify`: up→down→up over BOTH migrations) stays green.
  - [x] Do NOT add a recording API here (that is Story 1.6) — this story enforces the invariant and proves it with raw-SQL tests, test-first.
- [x] **Task 5 — Verification gate (AC: 1, 2)**
  - [x] With docker Postgres up: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` green; `forge test` green.

## Dev Notes

### Scope
- IS: the `journal_entries` + `postings` tables and the **database-enforced** double-entry invariant (DEFERRABLE constraint trigger), proven test-first with raw SQL. IS NOT: the recording API (`recordJournalEntry`) — that is Story 1.6, which builds on this. Keep the application path out of these tests deliberately (the whole point of AC-2 is that the DB guarantee holds even when application code is bypassed).

### Architecture constraints (authoritative)
[Source: architecture.md#Data Architecture, NFR-1, NFR-6, FR-3]
- Double-entry invariant enforced **IN the database**: a **`DEFERRABLE INITIALLY DEFERRED` constraint trigger on `postings`** (checked at transaction commit) asserting **Σ debits = Σ credits per `journal_entry`**. An unbalanced entry **fails the transaction**; no partial state. The guarantee holds regardless of application path and **cannot be bypassed** by writing postings directly. (This guarantees accounting balance only — agreement with the chain is FR-10, later.)
- The trigger ships as a **raw-SQL migration**. Migrations are **reversible** (NFR-5) — add a `down` that drops the trigger/function/tables/enum.
- **Test-first on invariants (NFR-6):** the §4.1 invariant is covered by tests **before** application logic.
- Amounts are **integers in smallest units**, stored as **`NUMERIC`** (arbitrary precision) for 18-decimal tokens; **no binary float** (NFR-2).

### Why DEFERRABLE INITIALLY DEFERRED
- A balanced entry is inserted as multiple posting rows. Mid-insert the entry is transiently unbalanced. A non-deferred (row-level, immediate) check would reject the first row. The deferred constraint trigger runs the balance check **at COMMIT**, after all rows are present — so balanced multi-row inserts pass and only a net-unbalanced entry fails. A test must prove this deferral explicitly.

### Prior-story learnings (1.4)
- `@rose/ledger` exists with the migration runner (`migrate up|down|reset|verify`), `schema_migrations` tracking, and embedded raw-SQL migrations (typed modules). Add `migration0002` to `migrations/index.ts`; the runner and `check:migrations verify` already handle multiple migrations.
- Reuse the integration-test pattern from `ledger.test.ts` (`createPool`, `hardReset` + `migrateUp` in `beforeAll`, `pool.end()` in `afterAll`). Postgres on `:5544` locally; CI service on `:5432`.
- `gen_random_uuid()` is core in PG18. DDL is transactional (the trigger/function create+drop are reversible cleanly).
- `ORDER BY` on enum columns sorts by declaration order (noted in 1.4) — irrelevant here but keep in mind.

### Implementation guidance (prevent mistakes)
- Represent debits/credits with a `direction` enum (`DEBIT`/`CREDIT`) and a **positive** `amount` (CHECK `> 0`); the trigger compares Σ debit vs Σ credit. (Equivalent to a signed-amount model; this keeps the glossary "debits/credits" explicit.)
- The trigger function must resolve the affected `journal_entry_id` from `COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)` so it handles INSERT/UPDATE/DELETE; sum over all current postings of that entry; `RAISE EXCEPTION` with a clear message on imbalance; `RETURN NULL`.
- Use `NUMERIC` for `amount` (not `bigint`) so 18-decimal token magnitudes fit. Compare sums as `NUMERIC`.
- The down migration must `DROP TRIGGER` and `DROP FUNCTION` before dropping `postings` (or use `IF EXISTS` + correct order). Keep it the exact inverse.
- Tests use raw SQL via `pg` (parameterized) and explicit transactions (`BEGIN`/`COMMIT`) on a single `client` to exercise commit-time behavior; to prove "no partial state", assert the `journal_entries` row count is unchanged after a failed commit.

### Testing standards
[Source: architecture.md NFR-6] — invariant tests written FIRST, raw SQL, against real Postgres; cover balanced commit, unbalanced-fails-at-commit (no residue), bypass-resistance, and deferral.

### References
- [Source: epics.md#Story 1.5] — user story + both AC scenarios.
- [Source: epics.md#Functional Requirements FR-3, NonFunctional NFR-1/NFR-6] — DB-enforced invariant, integrity-by-construction, test-first.
- [Source: architecture.md#Data Architecture] — DEFERRABLE INITIALLY DEFERRED constraint trigger on postings; raw-SQL migration.
- [Source: architecture.md#Decision Impact Analysis] — sequence step 2: Drizzle schema + double-entry trigger migration + invariant tests (test-first).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- **Red (test-first, NFR-6):** wrote `double-entry.test.ts` first; ran before the migration → `relation "journal_entries" does not exist` (the commit-success cases failed). Then added schema + migration 0002 → green.
- Two cross-cutting fixes surfaced while integrating: (1) the two DB test files ran in parallel against one database and clobbered each other → set `fileParallelism: false` in `vitest.config.ts`; (2) `TRUNCATE accounts` was blocked by the new `postings.account_id` FK → `TRUNCATE accounts CASCADE`; and `ledger.test.ts` reversibility assertions made migration-count-agnostic (down-all → up).
- Final gate (all green, docker PG18 :5544): typecheck 0; lint 0; test → 6 files, 73 tests; format 0; regime 0; `check:migrations` → "Reversibility OK: up→down→up over 2 migration(s)".

### Completion Notes List

- **AC-1 satisfied (test-first):** invariant tests written and run before any recording API; they prove a balanced entry commits, an unbalanced entry fails **at COMMIT** with **no partial state** (the `journal_entries` row rolls back too), and the trigger is genuinely **DEFERRED** (intermediate-unbalanced but finally-balanced multi-row insert commits).
- **AC-2 satisfied:** the guarantee is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `postings` — tests drive the DB with **raw SQL only** (no app helper), so the guarantee cannot be bypassed; a single-leg (one-posting) entry is rejected; a balanced set commits.
- Migration 0002 ships the `posting_direction` enum, `journal_entries` (with non-empty-description CHECK), `postings` (amount NUMERIC, CHECK `> 0`), the index, the plpgsql `check_double_entry_balance()` function, and the constraint trigger — as raw SQL in a typed module; `down` is the exact inverse. `check:migrations verify` now covers both migrations.
- Scope discipline: NO recording API here (that's Story 1.6); the application path is deliberately excluded so AC-2's "bypass-resistance" is genuinely tested.
- `coupled_pair_id` column reserved on `journal_entries` (nullable, no FK — `coupled_pairs` is Epic 2).

### File List

- `prod/packages/ledger/src/double-entry.test.ts` (new — test-first invariant coverage)
- `prod/packages/ledger/src/schema/journal-entries.ts` (new)
- `prod/packages/ledger/src/schema/postings.ts` (new)
- `prod/packages/ledger/src/schema/index.ts` (modified — export new tables)
- `prod/packages/ledger/src/migrations/0002-double-entry-invariant.ts` (new — DEFERRABLE trigger)
- `prod/packages/ledger/src/migrations/index.ts` (modified — register migration0002)
- `prod/packages/ledger/src/ledger.test.ts` (modified — TRUNCATE CASCADE; migration-count-agnostic reversibility assertions)
- `vitest.config.ts` (modified — `fileParallelism: false` for shared-DB integration tests)

## Change Log

- 2026-06-15 — Story 1.5 implemented (test-first): database-enforced double-entry invariant via a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `postings` (migration 0002), with `journal_entries`/`postings` schema. Raw-SQL invariant tests prove balanced-commit, unbalanced-fails-at-commit-with-no-partial-state, bypass-resistance, and deferral. Serialized shared-DB test files. TDD; 73 tests total. All gates green. Status → review.
- 2026-06-15 — Code review (3 adversarial layers, live DB) + remediation: hardened the invariant trigger to balance **per (asset, decimal_scale)** (cross-asset/scale entries no longer net by raw integer) and to re-check **both** the OLD and NEW journal entry on an UPDATE that moves a posting (source entry could previously be left unbalanced); added a DB `CHECK (amount = trunc(amount))` enforcing integer smallest-units (NFR-2). +4 tests (77 total). Migration 0002 edited pre-merge. All gates green. Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 parallel adversarial layers, run against the live Postgres 18)
**Date:** 2026-06-15
**Outcome:** Approve (after remediation). Both ACs independently confirmed met (test-first, DB-enforced, deferral proven, bypass-resistant); the two High-severity integrity holes found in review were closed.

### Acceptance verdict
- **AC-1 (test-first; unbalanced fails at COMMIT, no partial state):** SATISFIED — raw-SQL tests written before any recording API; verified by all three reviewers.
- **AC-2 (cannot be bypassed; balanced commits):** SATISFIED — guarantee is the DB constraint trigger; tests bypass the app entirely.

### Action Items
- [x] [Review][Patch][High] The balance check summed raw `amount` across all postings regardless of asset/scale — a cross-asset (or cross-scale) entry could "balance" by integer coincidence (e.g. 1.00 EUR vs 0.000001 BTC). Fixed: balance is now enforced **per (asset, decimal_scale)** (join to `accounts`, GROUP BY). [migrations/0002-double-entry-invariant.ts]
- [x] [Review][Patch][High] On an UPDATE moving a posting between entries, `COALESCE(NEW, OLD)` always resolved to NEW, so the **source** entry was never re-checked and could be left unbalanced — a direct-write bypass of AC-2. Fixed: the trigger collects and re-validates **both** OLD and NEW `journal_entry_id`. [migrations/0002-double-entry-invariant.ts]
- [x] [Review][Patch][Med] `amount` was bare `NUMERIC` (fractional values committed), contradicting the integer-smallest-units contract (NFR-2). Fixed: `CHECK (amount = trunc(amount))`. [migrations/0002-double-entry-invariant.ts]
- [x] [Review][Defer][Low/Med] A journal entry with **zero postings** (or all postings deleted) persists "balanced by omission" — a per-row trigger on `postings` cannot observe it. Deferred to Story 1.6: `recordJournalEntry` enforces ≥2 postings at the application boundary and the ledger is append-oriented (no posting-delete API). Documented.
- [x] [Review][Dismiss][Low] Debit+credit on the same account, and TRUNCATE bypassing row triggers — acceptable/admin-only for P0; noted, no action.
- [x] [Review][Confirm] `RETURN NULL` for an AFTER trigger, `FOR EACH ROW` redundancy, `DEFERRABLE INITIALLY DEFERRED`, and exact-NUMERIC `<>` comparison all verified correct by the reviewers.
