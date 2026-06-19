---
baseline_commit: 8beba739bd3b32f1dcedb36912718ad136904a58
---

# Story 8.2: Persist the off-chain per-user position model (leverage pinned 1x)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a build engineer,
I want a per-user position entity stored off-chain and linked to an issued coupled pair,
So that a Subscriber's directional exposure is recorded exactly (integer/`NUMERIC` money) without ever creating a single on-chain leg (FR-23, NFR-2).

## Acceptance Criteria

**Given** the `positions` package and a reversible migration
**When** a position is persisted
**Then** it stores `(owner, reference asset, side L/S, size/units, entry = anchor P₀, collateral, leverage, realized + unrealized P&L, lifecycle, link to the issued coupled pair)`; money fields are integer smallest-units / `NUMERIC` and `entry` is `decimal(18,8)` (NFR-2)
**And** a position **always references an issued coupled pair** — the schema cannot represent a position with no pair, and **no single-leg on-chain artifact is created**

**Given** the P0 leverage rule
**When** a position is created with `leverage ≠ 1`
**Then** it is **rejected** (the field is modelled for forward extensibility, but P0 forces 1x); a test asserts the rejection

**Given** the position lifecycle `OPEN → (RESET) → CLOSED`
**When** the underlying pair resets (the D1/D1a settlement boundary)
**Then** the position's `entry` re-anchors to the new P₀, its unrealized P&L **crystallises to realized/withdrawable**, and it re-bases with the pair's fresh symmetric split (no carried P&L)
**And** a position **never outlives a `CLOSED` pair**

### Scope boundary (P0, this story only)

- **IN:** a new PROD package `prod/packages/positions` with (a) a Drizzle **`positions` schema** (FK→`coupled_pairs`, side enum, lifecycle enum, `leverage` modelled with a `CHECK (leverage = 1)` P0 guard), (b) a **reversible migration** added as the ledger's NEXT migration (`0009`, registered append-only in `prod/packages/ledger/src/migrations/index.ts`), (c) a **position repository** (`createPosition`, `getPosition`, `applyPositionReset`, `closePosition`) enforcing the frozen money types (integer smallest-units / `NUMERIC`; `entry` `decimal(18,8)`), the `leverage = 1` P0 rejection, the `OPEN → (RESET) → CLOSED` lifecycle, the D1/D1a reset re-anchor/crystallise/re-base, and the "never outlives a `CLOSED` pair" invariant. Wire the package into root `tsconfig.json` references + its own tsconfig references (`@rose/ledger`, `@rose/shared`) + `workspace:*` deps + `pnpm install`.
- **OUT (later stories, do NOT pull forward):** `openPosition`/`closePosition` composed over the atomic subscribe/mint + redeem/burn flow (8.3), the API endpoints + Exchange-terminal wiring (8.4), position↔pair reconciliation / residual-backing invariant (8.5), the single-side-close solvency guardrail (8.6). This story persists and constrains the entity; it does NOT acquire/release on-chain exposure.
- **OUT:** any change to `@rose/ledger` / `coupled_pairs` schema semantics beyond an APPEND-ONLY new migration (`0009`) that adds the `positions` table + the "never outlives a CLOSED pair" backstop trigger; no change to on-chain coupling, `postTransfer`, or any minting. The positions layer writes **no postings** and mints **no leg** (derived off-chain layer).

## Tasks / Subtasks

- [x] Task 1 — Scaffold the `@rose/positions` PROD package (AC: #1)
  - [x] Add `prod/packages/positions/{package.json,tsconfig.json,src/index.ts}` mirroring the `@rose/reconcile` scaffold (ESM, composite, `rootDir: src`/`outDir: dist`). Dependencies: `@rose/ledger` + `@rose/shared` (`workspace:*`) + `drizzle-orm`.
  - [x] Register the package in root `tsconfig.json` `references` (after `price-oracle`); add `references` to `../ledger` + `../shared` in the package tsconfig. Run `pnpm install`.
- [x] Task 2 — The `positions` Drizzle schema (AC: #1, #2)
  - [x] `src/schema/positions.ts`: `position_side` enum (`LONG|SHORT`), `position_lifecycle` enum (`OPEN|CLOSED`), and the `positions` table: `id uuid pk`, `coupled_pair_id uuid NOT NULL REFERENCES coupled_pairs(id)` (single-leg-with-no-pair unrepresentable), `owner text NOT NULL`, `reference_asset text NOT NULL`, `side position_side NOT NULL`, `size_units numeric NOT NULL` (non-neg int), `entry_price numeric(18,8) NOT NULL` (positive), `collateral numeric NOT NULL` (non-neg int), `leverage numeric NOT NULL DEFAULT 1` with `CHECK (leverage = 1)`, `realized_pnl numeric NOT NULL DEFAULT 0` (signed int), `unrealized_pnl numeric NOT NULL DEFAULT 0` (signed int), `lifecycle position_lifecycle NOT NULL DEFAULT 'OPEN'`, `created_at`/`updated_at timestamptz`. Mirror the frozen-type idiom from `coupled-pairs.ts`.
  - [x] `src/schema/index.ts` re-exporting it.
- [x] Task 3 — The reversible migration `0009` (in `@rose/ledger`) (AC: #1, #3)
  - [x] `prod/packages/ledger/src/migrations/0009-positions.ts`: typed `up`/`down` raw SQL creating the two enums + `positions` table (mirroring the Drizzle schema's columns/checks exactly), the NOT NULL FK to `coupled_pairs`, the `CHECK (leverage = 1)` P0 guard, the integer/sign money checks, and the **"never outlives a CLOSED pair" backstop**: (i) a BEFORE INSERT OR UPDATE trigger on `positions` rejecting an `OPEN` position whose pair is `CLOSED`; (ii) a BEFORE UPDATE trigger on `coupled_pairs` rejecting a transition to `CLOSED` while any `OPEN` position references it. Exact-inverse `down` (triggers → functions → table → enums, `IF EXISTS`). Register append-only in `migrations/index.ts`.
- [x] Task 4 — The position repository (AC: #1, #2, #3)
  - [x] `src/repositories/positions.ts`: `PositionView` (smallest-unit magnitudes as `bigint`; `entryPrice`/`leverage` as decimal strings), `CreatePositionInput`, typed errors (`InvalidPositionError`, `PositionLeverageError`, `PositionNotFoundError`, `PositionLifecycleError`, `ClosedPairError`).
  - [x] `createPosition`: validate frozen types (positive `entryPrice` at scale 8, non-neg int `sizeUnits`/`collateral`, signed-int `realizedPnl`/`unrealizedPnl` default `0n`), **reject `leverage !== '1'` with `PositionLeverageError`** (forward-extensible field, P0 1x), confirm the pair exists + matches `referenceAsset` + is not `CLOSED`, insert (uses `db.select/insert` on a ledger `RoseExecutor` — no need to register the schema in the ledger drizzle client). Returns the persisted `PositionView`.
  - [x] `getPosition`.
  - [x] `applyPositionReset(db, { positionId, newAnchorPrice, newSizeUnits })`: row-locking tx; refuse a `CLOSED` position (`PositionLifecycleError`); re-anchor `entryPrice ← newAnchorPrice`, **crystallise** `realizedPnl ← realizedPnl + unrealizedPnl`, zero `unrealizedPnl` (no carried P&L), **re-base** `sizeUnits ← newSizeUnits` (the pair's fresh symmetric split); advance `updated_at`.
  - [x] `closePosition(db, positionId)`: row-locking tx; `OPEN → CLOSED`; reject a double-close (`PositionLifecycleError`). (Economic close/redeem is 8.3; this is the lifecycle transition only.)
- [x] Task 5 — Tests (test-first on the invariants) (AC: #1–#3)
  - [x] Persistence: `createPosition` round-trips all fields; money fields are exact `bigint` smallest-units; `entryPrice` is the `decimal(18,8)` anchor; a position with no `coupledPairId` is a type error / NOT NULL rejection; the schema has no lone-leg representation.
  - [x] Leverage: `createPosition` with `leverage = '2'` (and `'0.5'`) ⇒ `PositionLeverageError`; raw SQL insert with `leverage = 2` ⇒ DB `CHECK` violation (backstop). `leverage = '1'` ⇒ OK.
  - [x] Reset (D1/D1a): seed an `OPEN` position with non-zero `unrealizedPnl`; `applyPositionReset` re-anchors `entryPrice`, crystallises (`realizedPnl += unrealizedPnl`, `unrealizedPnl = 0`), re-bases `sizeUnits` to the fresh split; `updated_at` advanced; resetting a `CLOSED` position ⇒ `PositionLifecycleError`.
  - [x] Never outlives a CLOSED pair: cannot `createPosition` (OPEN) on a `CLOSED` pair (`ClosedPairError` app-level + trigger backstop via raw SQL); cannot transition a pair to `CLOSED` while an `OPEN` position references it (DB trigger); after `closePosition`, the pair may close.
  - [x] No on-chain artifact / no postings: the package imports neither `chain` nor `postTransfer`; it writes only the `positions` table.
- [x] Task 6 — Wire into the gate & validate (AC: #1)
  - [x] `vitest.config.ts` already matches `prod/packages/**/*.test.ts` — no config change. Full gate green: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` + `format:check`, `pnpm check:regime`, `pnpm check:migrations` (0009 round-trips up→down→up), `(cd prod/contracts && forge test)`.

## Dev Notes

### Scope & interpretation (P0)

- **`owner` is a non-empty `text` owner reference, not a FK (documented P0 interpretation).** The architecture lists `owner` plainly with no FK target [Source: `architecture.md` L179]. The four fixed `entities` (VCC/HOLDING/TRADING_CO/COIN_ISSUER) are *not* per-user Subscribers, and there is no Subscribers/Members table in P0. Adding one would be scope creep into 8.3 (the subscribe/redeem flow that ties a position to a Rose Member). So `owner` is a validated non-empty text identifier here; a FK to a future members table is deferred to when that table exists. **[P0 interpretation, documented]**
- **Side codes `LONG|SHORT`.** The architecture / sprint-change write the side as shorthand "L/S" [Source: `architecture.md` L179; `sprint-change-proposal-2026-06-18.md` L141]. The enum uses the unambiguous UPPERCASE glossary-style codes `LONG`/`SHORT` (consistent with `coupled_pairs.long_leg_value`/`short_leg_value`).
- **Lifecycle enum is `OPEN|CLOSED`; `RESET` is an *event*, not a persisted state.** The spec writes `OPEN → (RESET) → CLOSED` [Source: `epics.md` Story 8.2; `architecture.md` L182]. `(RESET)` is parenthetical: at the D1/D1a boundary the position is re-anchored/crystallised/re-based **while staying OPEN** — it is the underlying pair that resets. So `RESET` is `applyPositionReset` (an operation on an OPEN position), not a third lifecycle value. **[P0 interpretation, documented]**
- **`applyPositionReset` crystallises the row's *stored* `unrealizedPnl`.** Faithful to D1a (architecture L77, L182): "each reset realizes the winner's gain (withdrawable) and settles the loser's loss, then both legs re-base to a fresh symmetric split … no carried P&L." The persistence-layer reset reads the position's current `unrealizedPnl` (the mark at the boundary, written by 8.3/strategy execution upstream), adds it to `realizedPnl` (crystallised → withdrawable), zeroes `unrealizedPnl`, re-anchors `entryPrice` to the new P₀, and re-bases `sizeUnits` to the pair's fresh symmetric split. The actual price/mark computation is 8.1 (`@rose/price-oracle`); the reset orchestration over a real pair RESET is 8.3+. To keep the reset testable at the persistence layer without pulling forward 8.3, `createPosition` accepts optional `realizedPnl`/`unrealizedPnl` (default `0n`). **[P0 interpretation, documented]**
- **`closePosition` is the lifecycle transition only.** The economic close (redeem/burn, balanced journal entry) is Story 8.3 over the FR-21 path. 8.2 persists `OPEN → CLOSED` (rejecting a double-close), which is what the "never outlives a CLOSED pair" invariant needs. **[P0 interpretation, documented]**
- **`reference_asset` must match the linked pair.** A position whose `reference_asset` differs from its pair's would be nonsensical; `createPosition` reads the pair and rejects a mismatch (`InvalidPositionError`). App-level (not a trigger) to keep the DDL minimal.

### Architecture & convention constraints (cite)

- **Position model (FR-23):** off-chain `positions` table `(owner, reference_asset, side L|S, size/units, entry = anchor P₀, collateral, leverage, realized_pnl, unrealized_pnl, lifecycle, coupled_pair_id → issued pair)`; `leverage` modelled but **pinned to 1x in P0** (a `CHECK (leverage = 1)` / domain guard rejects >1x); lifecycle `OPEN → (RESET) → CLOSED`, `RESET` = the D1/D1a settlement boundary (entry re-anchors, unrealized P&L crystallises to realized/withdrawable, re-base on the fresh symmetric split, no carried P&L); **a position never outlives a CLOSED pair**; the position boundary never mints/transfers a single leg and writes no postings (derived layer). [Source: `architecture.md` L179–L186, L373; `epics.md` Story 8.2]
- **Money exactness (NFR-2):** money fields are integer smallest-units as `NUMERIC` (mirroring `coupled_pairs.collateral_pool` — NUMERIC, not bigint, for 18-decimal tokens), crossing the repo boundary as `bigint`; `entry` is `decimal(18,8)`; `leverage` is `NUMERIC` (decimal string, pinned `'1'`); never binary float. P&L fields are **signed** integers (the losing leg's loss is negative). [Source: `coupled-pairs.ts` schema; `architecture.md` L179; CYCLE-BRIEF "Money"]
- **Single-leg unrepresentable / no-pair unrepresentable:** the `coupled_pair_id` FK is `NOT NULL`, so a position with no pair has nowhere to exist (mirrors the `rose_notes.coupled_pair_id NOT NULL FK` idiom). The positions layer creates **no on-chain leg** — it imports neither the chain package nor `postTransfer`, and writes only the `positions` table. [Source: `0005-rose-notes.ts`; `architecture.md` L178, L373]
- **Migration discipline:** typed module embedding raw SQL with `up`/`down`, in `prod/packages/ledger/src/migrations/NNNN-*.ts`, registered append-only in `migrations/index.ts`. Epic ended at `0008`; the next is `0009`. NEVER edit a merged migration. `pnpm check:migrations` (up→down→up) must stay green — `0009` must round-trip. The migration lives in `@rose/ledger` (the single migration runner / `migrate-cli.ts`) so it is wired to the gate and ordered after `coupled_pairs` (`0003`) for the FK. [Source: CYCLE-BRIEF "Migrations"; `migrations/index.ts`]
- **Integrity-by-construction backstops:** the "never outlives a CLOSED pair" rule is enforced by DB triggers (the same idiom as the double-entry trigger `0002`, the lifecycle trigger `0004`, the delta-neutral trigger `0005`) behind the app-level guards, so a raw SQL write cannot bypass it. [Source: `0004-coupled-pair-lifecycle.ts`; `0005-rose-notes.ts`]
- **Package wiring:** add to root `tsconfig.json` `references` + `references` to `../ledger` + `../shared` in the package tsconfig + `workspace:*` deps; run `pnpm install`; tsconfig must NOT exclude `*.test.ts`. ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Files `kebab-case.ts`. [Source: CYCLE-BRIEF "Established project conventions"; `prod/packages/reconcile/{package.json,tsconfig.json}`]
- **Regime:** PROD, TypeScript; `/prod` never imports `/throwaway`. `pnpm check:regime` + eslint stay green. [Source: `architecture.md` L373–L374]

### Prior-story learnings reused

- **8.1 (`@rose/price-oracle`):** keep the new package decoupled and substitutable; money exact (`bigint` smallest-units / decimal strings, never float); validate at the boundary with strict decimal patterns + typed error classes; scope held tightly (no pulling 8.3–8.6 forward). [Source: `8-1-...md`]
- **Coupled-pair repo idioms reused:** strict `DECIMAL_PATTERN` (`^-?\d+(\.\d+)?$`), `assertMaxFractionalDigits` for the `decimal(18,8)` anchor (reject silent precision loss), `numericToBigInt` for reading smallest-unit NUMERICs, `RoseExecutor`-typed repo functions, row-locking (`SELECT … FOR UPDATE`) transactions for atomic read-check-write (mirrors `transitionPair` / `applyCoupledPairReset`). [Source: `prod/packages/ledger/src/repositories/coupled-pairs.ts`]

### Testing standards

- Vitest, co-located `*.test.ts`. DB integration tests share ONE database and run **serially** (`vitest.config.ts` `fileParallelism:false`). Pattern: `createPool`/`createDb`, `hardReset(pool)`+`migrateUp(pool)` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE positions, coupled_pairs CASCADE` per test. Test-first on the invariants (NFR-6): exact money round-trip, `leverage = 1` rejection (app + DB backstop), reset re-anchor/crystallise/re-base, never-outlives-a-CLOSED-pair (both trigger directions). [Source: CYCLE-BRIEF "Tests"; `coupled-pair-reset.test.ts`]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Full gate (Node 20 local; engine warns, non-fatal): `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm test` → 859 passed / 102 files (19 new in `positions`), `pnpm format` + `format:check` ✓, `pnpm check:regime` ✓ (`/prod` ↮ `/throwaway`), `pnpm check:migrations` ✓ (up→down→up over 9 migrations — `0009` round-trips), `forge test` → 171 passed. DB left migrated+seeded (reset to `0009`).
- One test fix during dev: the "cannot CLOSE a pair while an OPEN position references it" trigger fires inside `transitionPair`'s drizzle transaction, which wraps the pg error; added a `pgErrorCode` cause-chain unwrap helper to assert SQLSTATE `23514`.

### Completion Notes

- New PROD package `@rose/positions` (deps: `@rose/ledger` + `@rose/shared`). Off-chain `positions` entity layered over an issued coupled pair: `(owner, reference_asset, side LONG|SHORT, size_units, entry_price = anchor P₀, collateral, leverage, realized_pnl, unrealized_pnl, lifecycle OPEN|CLOSED, coupled_pair_id → coupled_pairs)`. Money exact (NFR-2): size/collateral/P&L are integer smallest-unit NUMERICs crossing the repo boundary as `bigint` (P&L signed — a loss is negative); `entry_price` is `decimal(18,8)`; `leverage` is a decimal string pinned `'1'`. Writes ONLY the `positions` table — imports neither the chain package nor `postTransfer`; mints no leg, posts nothing (test asserts 0 postings / 0 journal entries after open).
- Reversible migration `0009-positions.ts` added in `@rose/ledger` (the single migration runner) and registered append-only — ordered after `coupled_pairs (0003)` for the NOT NULL FK. The FK makes a position with no pair structurally unrepresentable (there is no single-leg table).
- Leverage pinned 1x: rejected at the app boundary (`PositionLeverageError`, accepts only exact-1 forms `'1'`/`'1.0'`) AND by a DB `CHECK (leverage = 1)` backstop (raw insert with `leverage = 2` ⇒ `23514`).
- D1/D1a reset (`applyPositionReset`): re-anchors `entry` to the new P₀, **crystallises** the stored unrealized P&L into realized/withdrawable (`realized += unrealized`, signed), **zeroes** unrealized (no carried P&L), and **re-bases** `size` to the pair's fresh symmetric split — position stays OPEN; refuses a CLOSED/missing position.
- "Never outlives a CLOSED pair" enforced from BOTH directions by non-bypassable BEFORE triggers: (1) on `positions` — an OPEN position cannot be inserted/kept against a CLOSED pair; (2) on `coupled_pairs` — a pair cannot transition to CLOSED while an OPEN position references it. App-level `ClosedPairError` gives the precise error for the create path.
- Scope held to 8.2: no open/close over subscribe/redeem (8.3), no API/web (8.4), no reconciliation (8.5), no single-side-close guardrail (8.6). `closePosition` is the lifecycle transition only (the economic redeem/burn close is 8.3).

### File List

- `prod/packages/positions/package.json` (new)
- `prod/packages/positions/tsconfig.json` (new)
- `prod/packages/positions/src/index.ts` (new)
- `prod/packages/positions/src/schema/positions.ts` (new — the Drizzle schema)
- `prod/packages/positions/src/schema/index.ts` (new)
- `prod/packages/positions/src/repositories/positions.ts` (new — the repository)
- `prod/packages/positions/src/repositories/positions.test.ts` (new — 19 tests)
- `prod/packages/ledger/src/migrations/0009-positions.ts` (new — reversible migration)
- `prod/packages/ledger/src/migrations/index.ts` (edit — register `migration0009` append-only)
- `tsconfig.json` (edit — add `positions` to references)
- `pnpm-lock.yaml` (edit — register `@rose/positions`)

## Change Log

| Date       | Version | Description                                                                                                | Author          |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------- | --------------- |
| 2026-06-19 | 0.1     | Story drafted (create-story), ready-for-dev                                                                | Amelia          |
| 2026-06-19 | 0.2     | Implemented `@rose/positions` (schema + migration 0009 + repository); leverage 1x, D1/D1a reset, never-outlives triggers; gate green; status review | Amelia          |
| 2026-06-19 | 0.3     | Adversarial review (3 lenses) + live-Postgres constraint & concurrency probes; no High/Med findings; gate green; status done | Amelia (review) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (adversarial, fresh-context). **Date:** 2026-06-19. **Outcome:** APPROVE — merge-ready.

### Scope & method

Reviewed across three lenses — Correctness (money/precision, lifecycle, the reset crystallisation, transactionality), Edge-cases (probed live Postgres on :5544 with raw SQL: integer/sign checks, the leverage `CHECK`, the enum, the over-scale silent-round, and a two-connection concurrency test of the "never outlives" lock interaction), Acceptance (every AC element; no scope creep into 8.3–8.6). Full gate re-run green; no production code changed during review (only ephemeral probe scripts, deleted). DB left migrated+seeded.

### Correctness

- **Money exactness (NFR-2):** `size_units`/`collateral` are non-negative integer NUMERICs; `realized_pnl`/`unrealized_pnl` are **signed** integer NUMERICs (a loss is negative — confirmed by probe: `realized_pnl = -9999` accepted, `2.5` rejected `23514`); they cross the repo boundary as `bigint` (custom signed `numericToBigInt`). `entry_price` is `decimal(18,8)`; `leverage` is a decimal string pinned `'1'`. No binary float on any money path.
- **Silent-rounding guard:** the DB would silently round an over-scale `entry_price` (`1.123456789 → 1.12345679`, confirmed by probe); the repo's `assertMaxFractionalDigits` rejects >scale-8 input first, so no silent precision loss on the sanctioned path.
- **Reset (D1/D1a):** `applyPositionReset` re-anchors `entry`, crystallises the stored unrealized into `realized` (`realized += unrealized`, signed — verified for both a gain `+25_000` and a loss `-40_000`), zeroes unrealized (no carried P&L), re-bases `size`; runs in a row-locking (`FOR UPDATE`) tx; refuses CLOSED/missing. The position stays OPEN across resets (RESET is an event, not a state) — matches the spec.
- **No fabrication / no on-chain artifact:** the package imports neither the chain package nor `postTransfer`; opening a position writes only the `positions` table (test asserts 0 postings / 0 journal entries).

### Edge-cases (live Postgres probe)

- NOT NULL FK ⇒ a position with no `coupled_pair_id` is `23502` (no lone leg); reference-asset mismatch is rejected app-level; blank `owner`/`reference_asset` are `23514`; `side = 'L'` is `22P02` (enum is `LONG|SHORT`).
- Leverage: app `PositionLeverageError` for `'2'`/`'0.5'`; DB `CHECK` `23514` for raw `leverage = 2` and `-1`; `'1'`/`'1.0'`/`1.0000` accepted (numeric equality).
- **"Never outlives a CLOSED pair" — both directions + concurrency:** (1) an OPEN position cannot be opened/kept against a CLOSED pair (app `ClosedPairError` + trigger `23514`); (2) a pair cannot transition to CLOSED while an OPEN position references it (trigger `23514`, surfaced through `transitionPair`'s wrapped pg error). A two-connection probe confirmed `transitionPair`'s `SELECT … FOR UPDATE` on the pair row **blocks** while an OPEN-position insert is in-flight (the FK `FOR KEY SHARE` lock conflicts with `FOR UPDATE`), so the invariant is concurrency-safe on the sanctioned close path (no write-skew).

### Acceptance

- **AC1 (persist owner/asset/side/size/entry/collateral/leverage/realized+unrealized P&L/lifecycle/pair link; integer-`NUMERIC` money + `decimal(18,8)` entry; always references a pair; no single-leg artifact):** MET.
- **AC2 (`leverage ≠ 1` rejected; field forward-extensible; test asserts rejection):** MET — app guard + DB `CHECK`, both tested.
- **AC3 (lifecycle `OPEN → (RESET) → CLOSED`; reset re-anchors/crystallises/re-bases; never outlives a CLOSED pair):** MET.
- **No scope creep:** no subscribe/redeem open-close (8.3), no API/web (8.4), no reconciliation (8.5), no single-side-close guardrail (8.6). `closePosition` is the lifecycle transition only.

### Findings & Action Items

- **No High/Med findings.** No code changes required during review.
- **[Low — documented, no fix]** A raw `UPDATE coupled_pairs SET state='CLOSED'` that bypasses `transitionPair` (and thus takes `FOR NO KEY UPDATE`, which does not conflict with the insert's `FOR KEY SHARE`) could theoretically write-skew with a concurrent in-flight position insert under READ COMMITTED. The sanctioned close path (`transitionPair`, `FOR UPDATE`) is safe (proven by probe), and the FR-10 reconcile-and-correct layer (Story 8.5) is the eventual backstop. Out of 8.2 scope.
- **[Low — by design]** `owner` is a non-empty `text` reference, not a FK — there is no Subscribers/Members table in P0 (a FK lands with the 8.3 subscribe/redeem flow). Documented as a P0 interpretation in Dev Notes.
