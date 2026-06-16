---
baseline_commit: NO_VCS
---

# Story 1.4: Model the four fixed entities and typed accounts with reversible migrations

Status: done

## Story

As an internal operator,
I want the four fixed entities and five typed account kinds modeled in the database,
so that I have a correctly structured multi-entity book of record (FR-1).

## Acceptance Criteria

**AC-1 — Reversible migration (forward + down both succeed; CI verifies)**
**Given** the ledger schema and its Drizzle migration
**When** I apply the migration and then roll it back
**Then** both the forward and down migrations succeed (versioned, reversible from the first commit — NFR-5), and CI verifies this

**AC-2 — Exactly four entities, five typed account kinds, routing honored**
**Given** the migrated database
**When** I inspect the entities and accounts
**Then** exactly the four entity codes exist (`VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`), each with a `jurisdiction`, and no API path creates entities dynamically
**And** every account has one entity, one of the five types (`BACKING_FLOAT`, `DEPLOYED_CAPITAL`, `CLIENT_COLLATERAL`, `FEE_INCOME`, `NOTE_LIABILITY`), one asset, and a decimal scale
**And** account placement honors the routing rule (VCC = cash/NAV only; exchange accounts under `TRADING_CO`; coin treasury / on-chain liquidity under `COIN_ISSUER`)

## Tasks / Subtasks

- [x] **Task 1 — `@rose/ledger` package + DB driver (AC: 1)**
  - [x] Create `prod/packages/ledger/` (`package.json`, `tsconfig.json` extending base, `src/index.ts`). Add to root `tsconfig.json` references.
  - [x] Dependencies: `drizzle-orm` (architecture pins 0.45.x; use the closest available), `pg`. Dev: `@types/pg`. (`drizzle-kit` is already at the root.) Run `pnpm install`.
- [x] **Task 2 — Drizzle schema (AC: 2)**
  - [x] `src/schema/entities.ts`: `entities` table — `id uuid pk default gen_random_uuid()`, `code` enum `entity_code` (`VCC|HOLDING|TRADING_CO|COIN_ISSUER`) `not null unique`, `jurisdiction text not null`, `created_at timestamptz not null default now()`.
  - [x] `src/schema/accounts.ts`: `accounts` table — `id uuid pk`, `entity_id uuid not null references entities(id)`, `type` enum `account_type` (`BACKING_FLOAT|DEPLOYED_CAPITAL|CLIENT_COLLATERAL|FEE_INCOME|NOTE_LIABILITY`) not null, `asset text not null`, `decimal_scale smallint not null check (>= 0)`, `created_at timestamptz`, `unique(entity_id, type, asset)`, index `idx_accounts_entity_id`.
  - [x] `src/schema/index.ts` barrel; derive domain types from Drizzle inferred types. Use exact PRD-glossary enum codes; `snake_case` tables/columns (plural tables); FK `entity_id`.
- [x] **Task 3 — Reversible raw-SQL migration (AC: 1)**
  - [x] `src/migrations/0001_entities_accounts.up.sql`: create the two enum types, `entities`, `accounts`, the index, and **seed exactly the four fixed entities** (jurisdiction placeholder `UNSPECIFIED` — §8 Q3 parked, free-text field). Forward only; idempotent-safe is not required (the runner tracks state).
  - [x] `src/migrations/0001_entities_accounts.down.sql`: drop `accounts`, `entities`, then the two enum types — the exact inverse.
  - [x] Migrations are **append-only after merge** (NFR-5): never edit a merged migration; only add new forward+down pairs.
- [x] **Task 4 — Migration runner with up AND down (AC: 1)**
  - [x] `src/migrate.ts`: a small `pg`-based runner. Maintains `schema_migrations(version text primary key, applied_at timestamptz default now())`. `migrateUp(pool)` applies pending `*.up.sql` in version order inside a transaction each, recording the version. `migrateDown(pool, steps = 1)` runs the matching `*.down.sql` in reverse for the last `steps` applied, removing the version. Drizzle-kit does not generate down migrations, so this runner is what realizes NFR-5's reversibility.
  - [x] A connection helper `src/db.ts`: build a `pg.Pool`/Drizzle client from `DATABASE_URL` (default `postgres://rose:rose@localhost:5544/rose_engine` for local docker; CI sets its own).
- [x] **Task 5 — Routing-rule guard for account placement (AC: 2)**
  - [x] `src/repositories/accounts.ts`: `createAccount({ entityCode, type, asset, decimalScale })` that resolves the entity by code and inserts an account ONLY if the placement is allowed by the documented P0 routing policy `ENTITY_ALLOWED_ACCOUNT_TYPES`; otherwise throws a typed `AccountPlacementError` naming the entity + type. No `createEntity` is exported (entities are fixed/seeded — "no API path creates entities dynamically").
  - [x] Encode the **P0 routing policy** (the epic states the rule at a high level — this is the explicit P0 interpretation, documented and easily revised):
    - `VCC` (cash/NAV only): `BACKING_FLOAT`, `CLIENT_COLLATERAL`, `FEE_INCOME`, `NOTE_LIABILITY` (no `DEPLOYED_CAPITAL` — VCC holds cash/NAV, not deployed positions).
    - `TRADING_CO` (exchange/trading): `DEPLOYED_CAPITAL`, `FEE_INCOME`.
    - `COIN_ISSUER` (coin treasury / on-chain liquidity): `BACKING_FLOAT`, `DEPLOYED_CAPITAL`.
    - `HOLDING` (holding company): `FEE_INCOME`.
- [x] **Task 6 — Integration tests against PostgreSQL (AC: 1, 2)**
  - [x] `src/ledger.test.ts` (Vitest, hits the DB via `DATABASE_URL`). With a clean DB: `migrateUp` → assert exactly the four entity codes exist, each with a `jurisdiction`; assert the `entity_code`/`account_type` enums reject any other value; insert valid accounts; assert `accounts` carries entity/type/asset/decimal_scale and the `unique(entity_id,type,asset)` + scale-`>=0` constraints hold.
  - [x] Routing: `createAccount` succeeds for allowed placements and throws `AccountPlacementError` for a forbidden one (e.g. `DEPLOYED_CAPITAL` under `VCC`).
  - [x] **Reversibility:** `migrateDown` drops `accounts`, `entities`, and both enum types; a subsequent `migrateUp` succeeds again (forward→down→forward), proving NFR-5.
  - [x] Tests clean up / reset state so they are repeatable (down to baseline in `afterAll`, or migrate fresh in `beforeAll`).
- [x] **Task 7 — Wire CI + replace the migration-check placeholder (AC: 1)**
  - [x] Replace `tools/check-migrations.mjs` (the Story 1.1 placeholder) with a real check that runs **migrate up → down → up** against `DATABASE_URL` and exits non-zero on any failure.
  - [x] `.github/workflows/ci.yml`: add a `postgres:18` **service** to the `prod-typescript` job and set `DATABASE_URL` so `pnpm test` (ledger integration tests) and `pnpm check:migrations` have a database.
- [x] **Task 8 — Verification gate (AC: 1, 2)**
  - [x] With docker Postgres up: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` all green; `forge test` still green.

## Dev Notes

### Scope
- IS: the `entities` + `accounts` schema, a reversible migration, the seeded four entities, and the routing-rule guard. IS NOT: journal entries / postings (Story 1.6), the double-entry trigger (Story 1.5), coupled-pair schema (Epic 2). Do not add those tables here. The migration runner is general (later stories add migrations `0002+`).

### Architecture constraints (authoritative)
[Source: architecture.md#Data Architecture, #Naming Patterns, #Structure Patterns, NFR-5]
- **PostgreSQL 18.4**; **Drizzle ORM 0.45.x + drizzle-kit**, SQL-first. Migrations **versioned and reversible from the first commit** (NFR-5); migrations **never edited after merge** (forward + down only); CI runs forward/rollback.
- `snake_case` tables/columns, tables **plural** (`entities`, `accounts`). PK `id` (uuid). FK `<singular>_id` (`entity_id`). Enums use exact PRD-glossary uppercase codes. Indexes `idx_<table>_<cols>`.
- **Four fixed entities** (`VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`), each with a `jurisdiction`; **no dynamic entity creation**. Five fixed account types. Each account has an asset and **decimal scale**.
- Routing rule (FR-1): VCC = cash/NAV only; exchange accounts under `TRADING_CO`; coin treasury / on-chain liquidity under `COIN_ISSUER`.
- `jurisdiction` is a free-text field; the two offshore jurisdictions (§8 Q3) are parked — placeholder `UNSPECIFIED` is acceptable (this is NOT a refuse-if-absent parked parameter; those are config values handled by `@rose/config`).

### Prior-story learnings (1.1–1.3)
- New package mirrors `@rose/shared`/`@rose/config` layout; add to root `tsconfig.json` references; the package tsconfig must NOT exclude `*.test.ts` (so `tsc -b` typechecks tests, per the Story 1.1 fix).
- Decimal scale per account aligns with `@rose/shared` money utils (`knownScaleOf`, EUR=2/BTC=8/token=decimals()); the account stores `decimal_scale`.
- Money is integer smallest-units; no float (NFR-2) — relevant when later stories post amounts. This story stores `decimal_scale` metadata only.
- ESM, strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Typed error classes for refusals (cf. `ConfigRefusalError`).

### Implementation guidance (prevent mistakes)
- **Reversibility is the headline AC.** drizzle-kit only emits forward migrations, so hand-write `*.up.sql` + `*.down.sql` and apply them with the custom runner. The down must be the exact inverse (drop in reverse dependency order: `accounts` before `entities`; tables before their enum types).
- `gen_random_uuid()` is built into PostgreSQL 18 core (no `pgcrypto` extension needed).
- Use the **enum types** to make "exactly four entity codes" and "five account types" structurally unrepresentable otherwise — inserting any other code must fail.
- **DB connection:** read `DATABASE_URL`; default to the local docker URL on host port **5544** (`postgres://rose:rose@localhost:5544/rose_engine`). CI sets `DATABASE_URL` to its `postgres:18` service (default 5432, no local conflict there).
- The integration tests require a running PostgreSQL (architecture assumes docker-compose locally). Keep them repeatable (migrate fresh / tear down).
- Routing policy is the **P0 interpretation** of the epic's high-level rule — keep it in one documented map (`ENTITY_ALLOWED_ACCOUNT_TYPES`) so it is reviewable and revisable; enforce via a guard + test.

### Testing standards
[Source: architecture.md NFR-5, NFR-6, #Structure Patterns] — Vitest integration tests co-located in the package. Cover: forward migration result (4 entities, enum rejection, account constraints), routing guard (allow + reject), and forward→down→forward reversibility.

### References
- [Source: epics.md#Story 1.4] — user story + both AC scenarios.
- [Source: epics.md#Functional Requirements FR-1] — four entities, five account types, routing rule.
- [Source: architecture.md#Data Architecture] — Postgres 18, Drizzle, reversible migrations, decimal scale.
- [Source: architecture.md#Naming Patterns] — snake_case plural tables, uuid PK, FK `entity_id`, enum codes, index naming.
- [Source: architecture.md#Decision Impact Analysis] — implementation sequence: scaffold → schema+trigger → coupled-pair (this is the schema step, entities/accounts portion).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green, against docker Postgres 18.4 on :5544): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 5 files, 64 tests passed; `pnpm format:check` → clean; `pnpm check:regime` → 0; `pnpm check:migrations` → "Reversibility OK: up→down→up over 1 migration(s)"; `forge test` → 3 passed.

### Completion Notes List

- **AC-1 satisfied:** reversible migration via a custom up/down runner (`migrate.ts`) — drizzle-kit emits forward-only, so hand-written `up`/`down` SQL pairs (shipped as typed modules) + `schema_migrations` tracking realize NFR-5. `check:migrations` now runs `verify` (up→down→up) and is wired into CI with a `postgres:18` service.
- **AC-2 satisfied:** the four fixed entities are seeded by the migration and `entity_code`/`account_type` are PG enums, so any other code/type is structurally rejected (tested via raw inserts). `accounts` carries entity FK, type, asset, `decimal_scale` (with a `>= 0` DB check and `UNIQUE(entity_id,type,asset)`). No `createEntity` is exported ("no API path creates entities dynamically"). The **routing rule** is enforced by `createAccount`/`isPlacementAllowed` against the documented P0 policy map.
- **Routing policy is the explicit P0 interpretation** of FR-1's high-level rule (the epic states it at a high level); kept in one reviewable `ENTITY_ALLOWED_ACCOUNT_TYPES` map and flagged as revisable.
- New package **`@rose/ledger`** (drizzle-orm 0.45.2, pg 8.21.0). Migrations embedded as TS modules (portable raw SQL — no fs/dist-copy fragility). `DATABASE_URL` defaults to local docker `:5544`; CI uses its service on `:5432`.
- Learned/encoded: `gen_random_uuid()` is built into PG18 core; `ORDER BY` on an enum column sorts by declaration order (test sorts by text).
- Scope discipline: only entities + accounts. No journal_entries/postings (Story 1.6), no double-entry trigger (Story 1.5), no coupled-pair (Epic 2). Migration runner is general for `0002+`.
- Also fixed `docker-compose.yml` during DB bring-up (PG18 mount path + host port 5544) — recorded in Story 1.3's change log where the fix was made.

### File List

- `prod/packages/ledger/package.json` (new)
- `prod/packages/ledger/tsconfig.json` (new)
- `prod/packages/ledger/src/schema/entities.ts` (new)
- `prod/packages/ledger/src/schema/accounts.ts` (new)
- `prod/packages/ledger/src/schema/index.ts` (new)
- `prod/packages/ledger/src/migrations/0001-entities-accounts.ts` (new)
- `prod/packages/ledger/src/migrations/index.ts` (new)
- `prod/packages/ledger/src/db.ts` (new)
- `prod/packages/ledger/src/migrate.ts` (new)
- `prod/packages/ledger/src/migrate-cli.ts` (new)
- `prod/packages/ledger/src/repositories/accounts.ts` (new)
- `prod/packages/ledger/src/index.ts` (new)
- `prod/packages/ledger/src/ledger.test.ts` (new)
- `tsconfig.json` (modified — add `@rose/ledger` to references)
- `package.json` (modified — `check:migrations` now runs the real `verify`)
- `tools/check-migrations.mjs` (deleted — placeholder replaced by the real runner)
- `.github/workflows/ci.yml` (modified — `postgres:18` service + `DATABASE_URL` for the prod-typescript job)
- `pnpm-lock.yaml` (modified — add `drizzle-orm`, `pg`, `@types/pg`)

## Change Log

- 2026-06-15 — Story 1.4 implemented: `@rose/ledger` — entities + accounts Drizzle schema, reversible hand-written up/down SQL migrations with a custom runner (`migrate up|down|reset|verify`), the four seeded entities, fixed enums, account constraints, and the P0 routing-rule guard. `check:migrations` now verifies up→down→up; CI gains a Postgres service. TDD; 64 tests. All gates green. Status → review.
- 2026-06-15 — Code review (3 adversarial layers, live DB) + remediation: deterministic seed UUIDs (down→up restores identical entity identity); `decimalScale` domain guard (integer + range) before the DB; migration runner hardened — version-sorted apply/rollback, `pg_advisory_lock` serialization, guarded `ROLLBACK` (preserves root error), `steps` validation. +3 tests (67 total). Routing-policy placement questions documented as open product items (the flagged P0 interpretation). All gates green. Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 parallel adversarial layers, run against the live Postgres 18)
**Date:** 2026-06-15
**Outcome:** Approve (after remediation). Both ACs independently confirmed met (structural enum/constraint enforcement, reversible migration verified in CI); no scope creep.

### Acceptance verdict
- **AC-1 (reversible forward+down; CI verifies):** SATISFIED — real `down`, custom up/down runner, `check:migrations verify` (up→down→up) wired into CI with a `postgres:18` service.
- **AC-2 (four entities, five typed accounts, routing honored):** SATISFIED — `entity_code`/`account_type` PG enums make other codes unrepresentable; accounts carry entity/type/asset/decimal_scale with DB constraints; no `createEntity`; routing enforced by `createAccount` + tests.

### Action Items
- [x] [Review][Patch][High] Seeded entities used `gen_random_uuid()`, so down→up produced new entity ids (identity not restored). Fixed: deterministic seed UUIDs; test asserts VCC's id is stable across down→up. [migrations/0001-entities-accounts.ts]
- [x] [Review][Patch][Med] `createAccount` didn't validate `decimalScale` integer/range — a JS float (`2.5`) surfaced as a raw pg error and was one cast-path from silent rounding. Fixed: `assertValidDecimalScale` domain guard before the DB. [repositories/accounts.ts]
- [x] [Review][Patch][Low] Migration runner: version-sorted apply/rollback (inverse-safe regardless of array order), `pg_advisory_lock` to serialize concurrent runners, guarded `ROLLBACK` (preserves the original error), and `migrateDown` `steps` validation. [migrate.ts]
- [x] [Review][Defer][Low/Med] Routing-policy placement questions (HOLDING limited to FEE_INCOME; NOTE_LIABILITY/CLIENT_COLLATERAL VCC-exclusive; FEE_INCOME under VCC vs "cash/NAV only"; coin liability location). The epic states the routing rule only at a high level; the Acceptance Auditor confirmed the policy does not contradict it. Kept as the documented, revisable P0 interpretation in one map — these are product decisions to confirm, not code defects.
- [x] [Review][Dismiss][Low] "accounts.id has no PK default" and "accounts.created_at nullable" — false positives from the abbreviated code shown to the Blind Hunter; the real migration has `DEFAULT gen_random_uuid()` and `NOT NULL DEFAULT now()` (verified). The `version DESC` "10+ migrations" concern is a non-bug under the zero-padded convention. No action.
- [x] [Review][Dismiss][Low] TS-module migrations (vs `.sql` files), app-layer routing, and no-Zod-at-`createAccount` — all deliberate and documented (portability; policy-shaped rule; no external ingress until Epic 6). No action.
