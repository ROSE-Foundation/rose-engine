---
baseline_commit: NO_VCS
---

# Story 2.1: Freeze and persist the coupled-pair shared data model

Status: done

## Story

As a build engineer,
I want the coupled-pair schema frozen first with its exact field types,
so that every downstream track consumes one stable inter-track contract and a single-leg pair is unrepresentable (FR-6).

## Acceptance Criteria

**AC-1 — Persisted model carries the frozen fields with the frozen types**
**Given** the `coupled_pairs` schema and migration
**When** I inspect the persisted model
**Then** a pair carries identifier, `reference_asset` (text), `anchor_price` P₀ `decimal(18,8)`, `leverage` L `decimal` (per-pair), `collateral_pool` K (`NUMERIC`, smallest-unit), `floor` f `decimal`, `state` enum (`PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`), and `timestamptz` timestamps

**AC-2 — Single-leg pair is structurally unrepresentable; leverage is per-pair**
**Given** an attempt to persist a pair with only one leg
**When** the write is made
**Then** the schema makes a persistent single-leg pair impossible to represent
**And** `leverage` is read per-pair from the row and never hard-coded (EUR/USD and BTC both at L=1 in P0 validation)

## Tasks / Subtasks

- [x] **Task 1 — Drizzle schema for `coupled_pairs` (AC: 1, 2)**
  - [x] `src/schema/coupled-pairs.ts`: `coupled_pairs` table with both legs as NOT NULL columns on the single pair row (the structural "single-leg unrepresentable" mechanism), the frozen field types, the `coupled_pair_state` enum, and `timestamptz` timestamps. Derive inferred types.
  - [x] `src/schema/index.ts`: export the coupled-pairs schema barrel.
- [x] **Task 2 — Reversible migration `0003` (AC: 1, 2)**
  - [x] `src/migrations/0003-coupled-pairs.ts`: typed module with raw-SQL `up`/`down`. `up` creates the `coupled_pair_state` enum, the `coupled_pairs` table (frozen field types, both-leg NOT NULL columns, CHECK constraints), and adds the deferred FK `journal_entries.coupled_pair_id → coupled_pairs(id)` (the column was created nullable + FK-less in migration 0002, per the brief). `down` is the exact inverse (drop FK, drop table, drop enum type).
  - [x] Register `migration0003` append-only in `src/migrations/index.ts`.
- [x] **Task 3 — Repository (AC: 1, 2)**
  - [x] `src/repositories/coupled-pairs.ts`: `createCoupledPair(...)` validates inputs (positive anchor price/leverage, non-negative floor, integer smallest-unit collateral/leg values via `assertNotFloat`/bigint) and inserts ONE row carrying BOTH legs — there is no API to create a lone leg. `getCoupledPair(db, id)` reads the row back, returning `leverage` per-pair from the row (never a constant). Typed `InvalidCoupledPairError`.
  - [x] `src/index.ts`: export the repository.
- [x] **Task 4 — Integration tests against PostgreSQL (AC: 1, 2)**
  - [x] `src/coupled-pairs.test.ts`: migrate fresh, then prove — (a) a pair persists all frozen fields with the frozen types (column type/precision introspected from `information_schema`); (b) the `coupled_pair_state` enum rejects any non-glossary value and defaults to `PENDING`; (c) **single-leg is unrepresentable** — there is no legs table, and a raw insert omitting either leg column fails the NOT NULL constraint; (d) `leverage` is read per-pair from the row (two pairs with different L round-trip their own L); (e) the FK rejects a journal entry referencing a non-existent pair and accepts one referencing a real pair; (f) forward→down→forward reversibility for migration 0003.
- [x] **Task 5 — Keep the existing 1.6 journal-entry test green under the new FK (AC: 1)**
  - [x] The "stores the optional coupled-pair link" test in `journal-entries.test.ts` previously used a fabricated pair UUID; with the new FK it must reference a real `coupled_pairs` row. Insert a real pair first and link to it. (Test-only consequence of adding the FK the brief instructed; no DONE migration is edited.)
- [x] **Task 6 — Verification gate (AC: 1, 2)**
  - [x] With docker Postgres up: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` all green; `forge test` still green.

## Dev Notes

### Scope
- IS: the frozen `coupled_pairs` schema, the `0003` reversible migration (incl. the deferred FK on `journal_entries.coupled_pair_id`), inferred types, a minimal create/read repository, and integration tests proving the frozen field types + the single-leg-unrepresentable structural guarantee.
- IS NOT: the lifecycle **state machine / transitions** (Story 2.2 — this story only persists the `state` enum + `PENDING` default, no transition logic), issuance journal entries (Story 2.3), Rose Note embedding / delta-neutrality (Story 2.4), and the conservation/loss-allocation math (Epic 7, D1 parked). Do not add those here.

### Design decision — how a single-leg pair is made unrepresentable
[Source: epics.md#Story 2.1; architecture.md#Data Architecture — "Schema cannot represent a persistent single-leg pair"; FR-6]
**Both legs live as NOT NULL columns on the single `coupled_pairs` row.** A coupled pair is one atomic row that carries the long leg (`long_leg_value`, V_A) and the short leg (`short_leg_value`, V_B). There is deliberately **no separate `legs`/`pair_legs` table** — therefore a leg has nowhere to exist on its own, and an orphan/single leg is *structurally* impossible (not merely validated at runtime). Because both leg columns are `NOT NULL`, a persisted pair always has both legs; a write that supplies only one leg fails the NOT NULL constraint at the database. This is the data-model analog of the on-chain "atomic paired mint/burn — single leg impossible" guarantee (Story 4.3). The legs are represented by their **values** (V_A, V_B) — the exact quantities surfaced in the Coupled-Pair view (FR-6: V_A, V_B, K, floor, anchor). The schema intentionally does **not** encode the `V_A + V_B = K` conservation invariant nor any post-reset loss-allocation, so it stays compatible with **either** D1 interpretation (bundled vs separate L/S) — that invariant/allocation is proved/decided later (Epic 7 math; D1 parked).

### Architecture constraints (authoritative — the coupled-pair freeze)
[Source: architecture.md#Data Architecture (coupled-pair field types), #Naming Patterns, CYCLE-BRIEF "Coupled-pair freeze"]
- Field types are **frozen** (PRD addendum §D): `anchor_price` (P₀) `decimal(18,8)`; `leverage` (L) `decimal`, **per-pair, never hard-coded**; `collateral_pool` (K) integer smallest-unit as **`NUMERIC` (not `bigint`)** so 18-decimal token magnitudes fit; `floor` (f) `decimal`; `state` enum `PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`; `reference_asset` `text`; timestamps `timestamptz`.
- Naming: `snake_case` plural table `coupled_pairs`; PK `id uuid default gen_random_uuid()`; FK `<singular>_id` (`coupled_pair_id`); enum values are the exact PRD-glossary UPPERCASE codes; indexes `idx_<table>_<cols>`.
- The double-entry trigger and `journal_entries.coupled_pair_id` already exist (Stories 1.5/1.6). The brief mandates: "the `journal_entries.coupled_pair_id` column already exists (nullable, no FK yet — **add the FK when you create the `coupled_pairs` table**)." Done here in `0003` via `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`.
- `NUMERIC` smallest-unit columns mirror the postings pattern: a `CHECK (col >= 0 AND col = trunc(col))` keeps amounts non-negative integers in the smallest unit (NFR-2). Decimal factors/prices (`anchor_price`, `leverage`, `floor`) get sign CHECKs only (`> 0` / `>= 0`).

### Prior-story learnings (1.4–1.6)
- Migrations are **typed modules embedding raw SQL** (`up`/`down`), registered append-only in `migrations/index.ts`; the custom runner (`migrate.ts`) is version-sorted + advisory-locked. NEVER edit a merged/DONE migration — only add `0003`.
- The runner's `down` order must be the **exact inverse**, dependency-respecting: drop the FK before the table it points at; drop the table before its enum type. `IF EXISTS` keeps `hardReset` safe.
- Drizzle `numeric(...)` columns read back as **strings**; the repo converts smallest-unit NUMERICs to/from `bigint` (cf. `journal-entries.ts numericToBigInt`), and decimals stay decimal strings (money over the wire = decimal strings).
- The ledger repos validate manually + throw typed errors (no Zod at this internal layer — there is no external ingress until Epic 6; this matches the reviewed 1.4/1.6 decision). Use `assertNotFloat` from `@rose/shared` to reject a JS float where a `bigint` smallest-unit is required (NFR-2).
- Enum types make "exactly these codes" structurally unrepresentable — inserting any other `state` value must fail (cf. `entity_code`/`account_type`).
- Tests share ONE DB serially (`fileParallelism:false`): `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE … CASCADE` for per-test isolation. Test-first on the structural invariants (NFR-6).
- Adding the FK breaks one existing 1.6 test that used a fabricated pair UUID; updated that test to reference a real pair (Task 5). This edits a test, not a DONE migration.

### Implementation guidance (prevent mistakes)
- `decimal(18,8)` → Drizzle `numeric('anchor_price', { precision: 18, scale: 8 })`; bare `decimal`/`NUMERIC` → `numeric('col')` (unconstrained precision).
- `state` default `PENDING` at the DB. Do NOT add transition enforcement (that is Story 2.2's state machine).
- Keep `pnpm check:migrations` green: it runs `verify` (up→down→up) over **all** migrations (now 3). The `0003` `down` must fully reverse `0003` (FK + table + enum) so a second `up` re-creates cleanly.
- `gen_random_uuid()` is built into PG18 core (no extension). Use deterministic test UUIDs where identity stability matters.

### Testing standards
[Source: architecture.md NFR-6, #Structure Patterns] — Vitest integration tests co-located in `@rose/ledger`, against the live Postgres on `:5544`. Cover: frozen field presence + types (introspect `information_schema.columns` for `anchor_price` precision/scale and the `NUMERIC` columns), enum rejection + `PENDING` default, the single-leg structural guarantee (no legs table; NOT NULL on each leg column), per-pair leverage round-trip, the FK behaviour, and `0003` forward→down→forward reversibility.

### References
- [Source: epics.md#Story 2.1] — user story + both AC scenarios (frozen fields; single-leg unrepresentable; per-pair leverage).
- [Source: epics.md#Epic 2] — coupled-pair contract frozen first; consumed by every downstream track.
- [Source: architecture.md#Data Architecture] — coupled-pair field-type freeze (PRD addendum §D); NUMERIC vs bigint; single-leg unrepresentable.
- [Source: architecture.md#Deferred Dependencies D1] — schema supports either Rose-Note composition; does not encode loss-allocation.
- [Source: CYCLE-BRIEF.md] — coupled-pair freeze field types; add the `journal_entries.coupled_pair_id` FK with this table; migrations append-only `0003`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green, docker Postgres 18 on :5544): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 8 files, 104 tests passed; `pnpm format:check` → clean; `pnpm check:regime` → OK; `pnpm check:migrations` → "Reversibility OK: up→down→up over 3 migration(s)"; `forge test` → 3 passed.

### Completion Notes List

- **AC-1 satisfied:** `coupled_pairs` carries the frozen field set with the frozen types, verified by introspecting `information_schema.columns` — `anchor_price` is `numeric(18,8)`; `leverage`/`collateral_pool`/`floor`/`long_leg_value`/`short_leg_value` are unconstrained `NUMERIC` (not bigint); `reference_asset` is `text`; `state` is the `coupled_pair_state` enum; `created_at`/`updated_at` are `timestamptz`. The enum exposes exactly the six glossary codes (order-asserted) and defaults to `PENDING`; a non-glossary value is rejected at the DB.
- **AC-2 satisfied (single-leg unrepresentable):** both legs are NOT NULL columns on the single `coupled_pairs` row and there is **no separate legs table** — tests assert no `legs`/`pair_legs`/`coupled_pair_legs` table exists and that a raw insert omitting either leg column fails the NOT NULL constraint. The repository requires both legs as inputs (a `longLegValue: undefined` create both fails to type-check and throws `InvalidCoupledPairError`). **Leverage is per-pair:** two pairs with L=`1` and L=`3.5` round-trip their own row value (never a constant).
- **Deferred FK wired (per the brief):** migration `0003` adds `journal_entries_coupled_pair_id_fkey` (`journal_entries.coupled_pair_id → coupled_pairs(id)`). Consequence: the existing Story 1.6 test "stores the optional coupled-pair link" used a fabricated pair UUID; it now creates a real pair first. This edits a test only — no DONE migration is modified.
- **Reversibility:** `0003` `down` drops the FK, then the table, then the enum type (exact inverse). `check:migrations verify` (up→down→up over 3 migrations) is green; a dedicated test rolls back only `0003`, asserts table+enum gone, re-applies, asserts table back.
- **Numeric boundary contract:** smallest-unit magnitudes (K, V_A, V_B) cross the repo boundary as `bigint` and are stored/read as integer `NUMERIC` (DB CHECK `col >= 0 AND col = trunc(col)`, mirroring `postings.amount`); decimal factors/prices (P₀, L, f) cross as decimal strings (money over the wire = decimal strings). `assertNotFloat` rejects a JS number for any smallest-unit field (NFR-2).
- **Scope discipline:** no lifecycle transitions (Story 2.2 — only the enum + `PENDING` default here), no issuance (2.3), no Note embedding/delta-neutrality (2.4). The schema deliberately does NOT encode `V_A + V_B = K` or post-reset loss-allocation, keeping it compatible with either D1 interpretation (parked).
- **P0 interpretation (documented):** the two legs are represented by their **values** V_A/V_B (the quantities surfaced in the FR-6 Coupled-Pair view). This is the explicit, reviewable choice for "what a leg is" at the data layer; it is the minimal representation that makes single-leg structurally impossible while staying D1-agnostic.

### File List

- `prod/packages/ledger/src/schema/coupled-pairs.ts` (new)
- `prod/packages/ledger/src/migrations/0003-coupled-pairs.ts` (new)
- `prod/packages/ledger/src/repositories/coupled-pairs.ts` (new)
- `prod/packages/ledger/src/coupled-pairs.test.ts` (new)
- `prod/packages/ledger/src/migrations/index.ts` (modified — register `migration0003`)
- `prod/packages/ledger/src/schema/index.ts` (modified — export coupled-pairs barrel)
- `prod/packages/ledger/src/schema/journal-entries.ts` (modified — `coupledPairId` now `.references(coupledPairs.id)`)
- `prod/packages/ledger/src/index.ts` (modified — export the coupled-pairs repository)
- `prod/packages/ledger/src/journal-entries.test.ts` (modified — link the optional-pair test to a real pair under the new FK)

## Change Log

- 2026-06-16 — Story 2.1 drafted: frozen `coupled_pairs` schema design (both legs as NOT NULL columns → single-leg structurally unrepresentable), `0003` reversible migration incl. the deferred `journal_entries.coupled_pair_id` FK, minimal repository, integration tests. Status → ready-for-dev → in-progress.
- 2026-06-16 — Story 2.1 implemented (TDD on the structural invariants): `@rose/ledger` gains the frozen `coupled_pairs` Drizzle schema + `coupled_pair_state` enum, migration `0003` (table + CHECKs + deferred journal-entries FK, exact-inverse down), a create/read repository with typed `InvalidCoupledPairError`, and 17 new integration tests (104 total). All gates green (incl. `check:migrations` over 3 migrations and `forge test`). Status → review.
- 2026-06-16 — Code review (3 adversarial lenses, live Postgres 18 probed via raw-SQL bypass) + remediation: added an explicit anchor_price precision guard (reject >8 fractional digits rather than letting numeric(18,8) silently round, e.g. 1.123456789 → 1.12345679) and two regression tests (the precision guard; a DB-CHECK-backstop test proving a fractional smallest-unit is rejected even when the repo is bypassed). +2 tests (106 total). All gates green. Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 adversarial lenses — Correctness, Edge cases via live-DB raw-SQL probes, Acceptance — against Postgres 18 on :5544)
**Date:** 2026-06-16
**Outcome:** Approve (after one Low remediation). Both ACs independently confirmed; no scope creep into lifecycle/issuance/Note.

### Acceptance verdict
- **AC-1 (frozen fields + frozen types):** SATISFIED — `information_schema` introspection confirms `anchor_price numeric(18,8)`, `leverage`/`collateral_pool`/`floor`/`long_leg_value`/`short_leg_value` unconstrained `NUMERIC` (not bigint), `reference_asset text`, `state` = `coupled_pair_state` enum (exactly the six glossary codes, in order, default `PENDING`), `created_at`/`updated_at` `timestamptz`.
- **AC-2 (single-leg unrepresentable; per-pair leverage):** SATISFIED — both legs are NOT NULL columns on the single row and there is no separate legs table (asserted); a raw insert omitting either leg fails the NOT NULL constraint; the repo requires both legs (a lone-leg create neither type-checks nor runs). Two pairs with L=`1` and L=`3.5` round-trip their own per-row leverage.

### Findings & resolution
- **[Edge/Med→resolved] Silent anchor-price rounding.** `numeric(18,8)` silently rounds an over-precise input (live probe: `1.123456789` → `1.12345679`). Inconsistent with the codebase's no-silent-money-precision-loss stance (NFR-2). **Fixed:** repo rejects an `anchorPrice` with >8 fractional digits with an explicit error; regression test added (exactly 8 digits still accepted).
- **[Correctness/Defense-in-depth — confirmed good] DB is the real backstop.** Live raw-SQL probes (repo bypassed) confirm every guard holds at the DB: fractional/negative `collateral_pool` & leg values rejected by the `*_nonneg_int` CHECKs; zero `anchor_price`/`leverage` rejected by the sign CHECKs; empty `reference_asset` rejected; explicit `NULL state` rejected by NOT NULL; non-glossary `state` rejected by the enum. Added a regression test asserting the smallest-unit integer CHECK fires on a raw-SQL insert.
- **[Acceptance — confirmed] Deferred FK.** `journal_entries.coupled_pair_id → coupled_pairs(id)` wired in `0003`; rejects an orphan reference, accepts a real one; the pre-existing 1.6 link test was updated to use a real pair (test-only; no DONE migration touched).
- **[Reversibility — confirmed] `0003` down** drops FK → table → enum (exact inverse); `check:migrations verify` green over 3 migrations; dedicated test rolls back only `0003` and re-applies.
- **[Documented decision — accepted] Legs modeled by value (V_A/V_B).** The two legs are represented by their values (the quantities the FR-6 view surfaces). The schema intentionally omits `V_A + V_B = K` / loss-allocation, keeping it D1-agnostic (parked). This is the minimal representation that makes single-leg structurally impossible.

### Action Items
- [x] [Review][Patch][Med] Reject over-precision `anchorPrice` instead of silently rounding (explicit precision-loss error + regression test). [repositories/coupled-pairs.ts, coupled-pairs.test.ts]
- [x] [Review][Test][Low] Add a DB-CHECK-backstop regression test (fractional smallest-unit rejected via raw SQL, repo bypassed). [coupled-pairs.test.ts]
