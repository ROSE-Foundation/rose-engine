---
baseline_commit: NO_VCS
---

# Story 2.4: Embed a coupled pair in a Rose Note, delta-neutral at issuance

Status: done

## Story

As an Investment Manager,
I want a Rose Note to reference exactly one coupled pair whose legs offset at issuance,
so that the instrument is market-neutral on the underlying at issuance and directional risk comes only from strategy (FR-12).

## Acceptance Criteria

**AC-1 — A Rose Note references exactly one coupled pair whose legs are at equal notional (delta-neutral) at issuance**
**Given** a Rose Note record
**When** it is created
**Then** it references exactly one coupled pair, and that pair's two legs are at equal notional (delta-neutral / market-neutral on the underlying) at issuance

**AC-2 — The Note↔pair model accommodates either D1 interpretation and does not encode the parked loss-allocation**
**Given** the unresolved D1 product decision (bundled vs separate L/S, reset loss-allocation)
**When** the Note↔pair model is implemented
**Then** the schema accommodates either interpretation without committing to one (it does not encode post-reset loss-allocation, which is parked)

## Tasks / Subtasks

- [x] **Task 1 — `rose_notes` schema + migration 0005 (AC: 1, 2)**
  - [x] New migration `prod/packages/ledger/src/migrations/0005-rose-notes.ts` (raw SQL, typed module, `up`/`down`), registered append-only in `migrations/index.ts`. Epic 2 ended at migration `0004`; this is `0005`.
  - [x] `CREATE TABLE rose_notes` with: `id uuid PK default gen_random_uuid()`; `coupled_pair_id uuid NOT NULL REFERENCES coupled_pairs(id)` — **exactly one** coupled pair (single NOT NULL FK column ⇒ a Note cannot reference zero or two pairs); `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`.
  - [x] `UNIQUE (coupled_pair_id)` — a coupled pair is **embedded in at most one** Rose Note (1:1 embedding — the faithful reading of "embed a coupled pair in a Rose Note"), as named constraint `rose_notes_coupled_pair_id_key`.
  - [x] **Delta-neutral-at-issuance DB backstop:** a `BEFORE INSERT` trigger `trg_rose_notes_delta_neutral` calling a `plpgsql` function that looks up the referenced pair and `RAISE`s (ERRCODE `check_violation`) if `long_leg_value <> short_leg_value`. INSERT-only (issuance), so the legs may legitimately diverge AFTER issuance (directional risk from strategy) without affecting the existing note. Mirrors the codebase's integrity-by-construction backstops (double-entry trigger 0002, lifecycle trigger 0004).
  - [x] The table deliberately carries **no** columns for composition mode (bundled vs separate L/S) or post-reset loss-allocation (D1 parked) — AC-2.
  - [x] `down` is the exact inverse in reverse dependency order (`DROP TRIGGER` → `DROP FUNCTION` → `DROP TABLE`), each `IF EXISTS` for safe resets. `pnpm check:migrations` green over 5 migrations.
- [x] **Task 2 — Drizzle schema `schema/rose-notes.ts` (AC: 1, 2)**
  - [x] `roseNotes` `pgTable('rose_notes', …)` mirroring migration 0005: `id`, `coupledPairId: uuid('coupled_pair_id').notNull().unique().references(() => coupledPairs.id)`, `createdAt`, `updatedAt`. Export `RoseNote = typeof roseNotes.$inferSelect`.
  - [x] Export from `schema/index.ts`.
- [x] **Task 3 — `createRoseNote` repository + delta-neutrality guard (AC: 1)**
  - [x] New `prod/packages/ledger/src/repositories/rose-notes.ts`. `createRoseNote(db: RoseExecutor, { coupledPairId })`:
    - Reads the referenced pair via `getCoupledPair` (widened to `RoseExecutor` so it reads on the same executor/transaction); throws `CoupledPairNotFoundError` (reused from `coupled-pairs.ts`) if absent or if the id is empty/non-string.
    - **App-level delta-neutrality guard:** throws typed `NotDeltaNeutralError(coupledPairId, longLegValue, shortLegValue)` unless `pair.longLegValue === pair.shortLegValue` (pure `bigint` comparison off the validated `CoupledPairView` — never a float). The DB trigger (Task 1) is the non-bypassable backstop.
    - Inserts the note and returns a `RoseNoteView { id, coupledPairId, createdAt, updatedAt }`.
  - [x] `getRoseNote(db: RoseDb, id)` → `RoseNoteView | null`.
  - [x] `createRoseNote` accepts `RoseExecutor` (consistent with `createCoupledPair`) so Epic 6 subscription can compose it inside a transaction.
  - [x] Export `createRoseNote`, `getRoseNote`, `NotDeltaNeutralError`, and the view/input types from `repositories/rose-notes.ts`; re-export from `src/index.ts`.
- [x] **Task 4 — Integration tests against PostgreSQL, test-first on the invariant (AC: 1, 2)**
  - [x] AC-1 happy path: creating a note over a delta-neutral pair persists exactly one `rose_notes` row referencing that one pair; `getRoseNote` reads it back.
  - [x] AC-1 rejection (app guard): creating a note over a non-delta-neutral pair throws `NotDeltaNeutralError`; nothing persists.
  - [x] AC-1 rejection (DB backstop): a raw `INSERT INTO rose_notes` over a non-delta-neutral pair is rejected by the trigger (`check_violation`, 23514); a raw insert over a delta-neutral pair passes.
  - [x] AC-1 "exactly one": a second note over the SAME pair is rejected by the UNIQUE constraint (`unique_violation`, 23505 on `.cause`); `coupled_pair_id` is NOT NULL.
  - [x] AC-1 referential integrity: a note over a non-existent pair id throws `CoupledPairNotFoundError`; a raw bogus FK insert is rejected (`foreign_key_violation`, 23503).
  - [x] AC-1 post-issuance divergence allowed: after a note is created, a direct leg-value UPDATE does NOT invalidate the existing note (trigger is INSERT-only).
  - [x] AC-2: `information_schema.columns` confirms the column set is exactly `id, coupled_pair_id, created_at, updated_at` (no loss-allocation/composition column).
- [x] **Task 5 — Verification gate (AC: 1, 2)**
  - [x] With docker Postgres up: `pnpm typecheck`, `pnpm lint`, `pnpm test` (138, +9 new), `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (5 migrations, up→down→up) all green; `forge test` 3/3 green.

## Dev Notes

### Scope
- IS: the OFF-CHAIN **Note↔pair data-model contract** — a `rose_notes` table that references **exactly one** coupled pair, plus a `createRoseNote` primitive that enforces **delta-neutrality at issuance** (the pair's two leg values are equal at the moment the note is created), backed by a DB `BEFORE INSERT` trigger (integrity-by-construction, NFR-1). Pure persisted relational model; composes the Story 2.1 `coupled_pairs` table.
- IS NOT: the on-chain mint (FR-18 — Epic 5); live subscription/redemption of Rose Notes (FR-11 — Epic 6, the dedicated `rose-note/` orchestration package); coupon / use-of-proceeds / conversion parameters (parked §11.2); the V_A + V_B = K conservation invariant (Epic 7 / D1 parked); rebalancing/reset math; **post-reset loss-allocation and the bundled-vs-separate-L/S composition mode (D1 — explicitly NOT encoded, AC-2)**; any directional-risk/strategy modeling.

### Design decision — `rose_notes` lives in `@rose/ledger` (variance from the idealized package split)
[Source: architecture.md#Project Structure (`coupled-pair/` FR-6/FR-12, `rose-note/` FR-11); Stories 2.1/2.2/2.3 all landed coupled-pair code in `@rose/ledger`]
The architecture's idealized structure lists a separate `coupled-pair/` package (FR-12) and a `rose-note/` package (FR-11/Epic 6). The **established implementation reality** (Stories 2.1–2.3) consolidated the entire coupled-pair contract into `@rose/ledger`, where it shares the drizzle schema, the append-only migration runner, the repository conventions, and the `journal_entries.coupled_pair_id` FK. The Note↔pair model is a persisted relational model with a NOT NULL FK to `coupled_pairs`, so it belongs in the same package for the same reasons. The dedicated `rose-note/` package (Epic 6) is for the live subscription/redemption **orchestration & lifecycle**, not this Epic-2 data-model contract. **Variance documented; no new package** — consistent with the CYCLE-BRIEF "stay in `@rose/ledger`; no new package" pattern used for 2.3.

### Design decision — "references exactly one coupled pair" + "embed" ⇒ 1:1 (multi-layer)
[Source: epics.md#Story 2.4 / FR-12 "A Rose Note references exactly one coupled pair"]
- **Exactly one:** `coupled_pair_id` is a single `NOT NULL` FK column — a note cannot reference zero pairs (NOT NULL) and cannot reference two (one column, one FK). There is deliberately no join table, so "a note with two pairs" is structurally unrepresentable (mirrors the Story 2.1 single-leg-unrepresentable approach).
- **Embed ⇒ at most one note per pair:** a `UNIQUE (coupled_pair_id)` constraint makes the relationship 1:1 — a given coupled pair is *embedded in* at most one Rose Note. This is the faithful reading of "embed a coupled pair **in** a Rose Note" (an embedding is exclusive). Documented P0 interpretation: the epic does not explicitly forbid embedding one pair in many notes, but "embed … in a Note" most naturally means exclusive ownership; UNIQUE encodes that and can be relaxed later via a new migration if the product decides otherwise.

### Design decision — delta-neutral = equal-notional legs, enforced AT ISSUANCE (app guard + DB backstop)
[Source: epics.md#Story 2.4 "that pair's two legs are at equal notional (delta-neutral / market-neutral on the underlying) at issuance"; Stories 1.5/2.2 DB-trigger backstop pattern; architecture.md#Enforcement (integrity-by-construction, NFR-1)]
- **Definition:** the two legs are at *equal notional* ⇔ `long_leg_value === short_leg_value` (both are smallest-unit `NUMERIC`/`bigint` notionals of the same pair). Equality is a pure `bigint` comparison — never a binary float (NFR-2).
- **At issuance only:** the constraint binds at note **creation** (issuance). It is a `BEFORE INSERT` trigger on `rose_notes`, so after issuance the pair's legs may legitimately diverge ("directional risk arises only from strategy" — FR-12) without invalidating the existing note. A test asserts a post-issuance leg divergence does NOT break the note.
- **Two layers (each sufficient):** (1) app-level `NotDeltaNeutralError` in `createRoseNote` (friendly typed refusal, the established repository idiom); (2) the `BEFORE INSERT` trigger as the non-bypassable backstop — a raw SQL insert over a skewed pair is still rejected (a test proves this). This is exactly the codebase's integrity-by-construction stance (Story 1.5 double-entry trigger, Story 2.2 lifecycle trigger).

### Design decision — AC-2: the schema does NOT encode the parked D1 decision
[Source: epics.md#Story 2.4 AC-2; architecture.md#D1 "schema/contract support both interpretations"; CYCLE-BRIEF "flag any genuinely ambiguous product decision … rather than inventing scope"]
D1 (PRD §8 Q1) is unresolved: a Rose Note is either a **bundled** market-neutral holding or **separate** L/S (zero-sum, directional), and the post-reset loss-allocation is parked. The `rose_notes` table is intentionally **minimal** — `id`, `coupled_pair_id`, `created_at`, `updated_at` — with **no** column for composition mode, loss-allocation, coupon, or use-of-proceeds. Either D1 interpretation can later be layered on (separate L/S accounting, or a bundled holding) without altering this contract. A test asserts the exact column set, so a future story cannot silently smuggle a D1-committing column past AC-2.

### Architecture constraints
[Source: architecture.md#Naming Patterns, #Data Architecture, #Structure Patterns; CYCLE-BRIEF]
- DB: `snake_case` plural table `rose_notes`; `id uuid` PK; FK `coupled_pair_id` (`<singular>_id`); `timestamptz` timestamps. Glossary discipline: the term is **Rose Note** (PRD §3) — table `rose_notes`, function `createRoseNote`.
- No glossary verb is frozen for note creation (`postTransfer`, `issueCoupledPair`, `mintPair`, `burnPair`, `reconcile` are the frozen set); `createRoseNote` follows the `create<Entity>` repository idiom already used by `createCoupledPair`.
- Money/notional stays integer smallest-units (`NUMERIC` in DB, `bigint` in TS); never a binary float (NFR-2). The delta-neutrality check is a `bigint` equality off the validated `CoupledPairView`.
- Typed errors for refusals (`NotDeltaNeutralError`, reuse `CoupledPairNotFoundError`), matching `InvalidCoupledPairError` / `UnbalancedEntryError` / `IllegalPairTransitionError`.
- Migration `0005`, append-only; never edit `0001`–`0004` (DONE stories). `check:migrations` verifies up→down→up over 5 migrations.

### Project Structure Notes
- New: `schema/rose-notes.ts`, `repositories/rose-notes.ts`, `migrations/0005-rose-notes.ts`, `rose-notes.test.ts` (all under `prod/packages/ledger/src/`).
- Modified: `schema/index.ts` (export rose-notes schema), `migrations/index.ts` (register 0005), `src/index.ts` (export rose-notes repository).
- No new package, no `tsconfig`/workspace changes (stays in `@rose/ledger`).
- Variance from architecture's idealized `coupled-pair/` + `rose-note/` package split — see "Design decision" above; consistent with the Epic-2 consolidation into `@rose/ledger`.

### Prior-story learnings (2.1, 2.2, 2.3)
- `createCoupledPair` inserts ONE row carrying both legs; reads them back as `bigint` via `numericToBigInt` on the `CoupledPairView` (drizzle `numeric` reads as strings). Use `getCoupledPair`'s view for the delta-neutrality `bigint` comparison — no float, already type-validated.
- `RoseExecutor = RoseDb | RoseTransaction` (Story 2.3) lets a repo run inside an outer transaction. `createRoseNote` takes `RoseExecutor` so Epic 6 can compose it; existing callers pass a plain `RoseDb`.
- DB triggers are the codebase's backstop idiom: the double-entry `DEFERRABLE` trigger (0002) and the lifecycle `BEFORE UPDATE` trigger (0004) both use `plpgsql` + `RAISE … USING ERRCODE = 'check_violation'`. Mirror that shape for the delta-neutrality `BEFORE INSERT` trigger.
- Tests share ONE DB serially (`fileParallelism:false`): `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE … CASCADE` per test. Seed a pair via `createCoupledPair` (or raw SQL) per test. `TRUNCATE coupled_pairs CASCADE` clears `rose_notes` (FK) too.

### Testing standards
[Source: architecture.md NFR-6; CYCLE-BRIEF] — Vitest integration tests co-located in `@rose/ledger`, against the live Postgres on `:5544`. **Test-first on the invariant:** a delta-neutral pair yields exactly one note referencing that one pair; a skewed pair is rejected at BOTH the app layer (`NotDeltaNeutralError`) AND the DB layer (raw-insert `check_violation`); a duplicate-pair note is rejected (UNIQUE); a bogus FK is rejected; post-issuance divergence is allowed; and the column set is exactly the minimal four (AC-2). Assert nothing persists after each rejection.

### References
- [Source: epics.md#Story 2.4] — user story + both AC scenarios (exactly one pair, equal-notional/delta-neutral at issuance; schema accommodates either D1 interpretation, no loss-allocation).
- [Source: epics.md#FR-12] — a Rose Note references exactly one coupled pair whose legs offset at issuance; directional risk arises only from strategy.
- [Source: architecture.md#Data Architecture / coupled-pair freeze §D] — leg values are smallest-unit NUMERIC; the schema cannot represent a persistent single-leg pair.
- [Source: architecture.md#D1] — Rose Note composition & reset loss-allocation parked; schema/contract support both interpretations.
- [Source: architecture.md#Naming Patterns, #Structure Patterns] — `snake_case` plural tables, `<singular>_id` FKs, glossary terms, co-located tests, migrations live with the ledger package and are never edited after merge.
- [Source: implementation-artifacts/2-3-*.md] — `RoseExecutor` composition, `CoupledPairView` bigint reads, DB-trigger backstop idiom, serial DB test scaffolding.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green, docker Postgres 18 on :5544): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 11 files, 138 tests passed (9 new in `rose-notes.test.ts`); `pnpm format:check` → clean; `pnpm check:regime` → OK; `pnpm check:migrations` → "Reversibility OK: up→down→up over 5 migration(s)"; `forge test` → 3 passed.

### Completion Notes List

- **AC-1 satisfied (exactly one delta-neutral pair at issuance):** `rose_notes.coupled_pair_id` is a single `NOT NULL` + `UNIQUE` FK — a note references exactly one pair (cannot be zero/two) and a pair embeds into at most one note (1:1). `createRoseNote` reads the pair and refuses unless `longLegValue === shortLegValue` (`NotDeltaNeutralError`), a pure bigint comparison; the `BEFORE INSERT` trigger `trg_rose_notes_delta_neutral` is the non-bypassable backstop (a raw skewed-pair insert is rejected with `check_violation`). Tests prove the happy path, both rejection layers, the UNIQUE/FK/NOT-NULL guards, and the read-back.
- **AC-1 "at issuance" only:** the trigger is INSERT-only; a test mutates the pair's legs AFTER note creation and confirms the existing note is not invalidated ("directional risk arises only from strategy", FR-12).
- **AC-2 satisfied (D1 parked):** `rose_notes` is minimal — `id, coupled_pair_id, created_at, updated_at`. No composition-mode (bundled vs separate L/S) or post-reset loss-allocation column; a test asserts the exact column set so a future story cannot silently smuggle a D1-committing column past AC-2.
- **`getCoupledPair` widened to `RoseExecutor`** (was `RoseDb`) so `createRoseNote` can read the pair on the same executor/transaction (Epic 6 can compose it). Backward compatible — a plain `RoseDb` still satisfies the union; the now-unused `RoseDb` import in `coupled-pairs.ts` was removed.
- **No DONE migration edited** — migration 0005 is append-only. Two pre-existing reversibility tests that hard-code a rollback step count (`coupled-pairs.test.ts` 0003 test, `coupled-pair-lifecycle.test.ts` 0004 test) were bumped (2→3 and 1→2) to account for 0005 now sitting on top — the same test maintenance Story 2.2 applied to the 0003 test (documented in that test's own comment). No production migration logic changed.
- **Scope discipline:** off-chain Note↔pair data-model contract only. No on-chain mint (Epic 5), no live subscription/redemption orchestration (Epic 6 `rose-note/` package), no coupon/use-of-proceeds (parked §11.2), no V_A+V_B=K (Epic 7), no D1 loss-allocation/composition.

### File List

- `prod/packages/ledger/src/migrations/0005-rose-notes.ts` (new — `rose_notes` table, NOT NULL + UNIQUE FK, delta-neutral `BEFORE INSERT OR UPDATE` trigger + function, reversible down)
- `prod/packages/ledger/src/schema/rose-notes.ts` (new — `roseNotes` drizzle table + `RoseNote` type)
- `prod/packages/ledger/src/repositories/rose-notes.ts` (new — `createRoseNote`, `getRoseNote`, `NotDeltaNeutralError`, `RoseNoteView`/`CreateRoseNoteInput`)
- `prod/packages/ledger/src/rose-notes.test.ts` (new — 9 integration tests: happy path, app + DB delta-neutral rejection, UNIQUE/FK/NOT-NULL, post-issuance divergence, AC-2 column set)
- `prod/packages/ledger/src/migrations/index.ts` (modified — register `migration0005`)
- `prod/packages/ledger/src/schema/index.ts` (modified — export rose-notes schema)
- `prod/packages/ledger/src/index.ts` (modified — export rose-notes repository)
- `prod/packages/ledger/src/repositories/coupled-pairs.ts` (modified — widen `getCoupledPair` to `RoseExecutor`; drop now-unused `RoseDb` import)
- `prod/packages/ledger/src/coupled-pairs.test.ts` (modified — bump migration-0003 reversibility rollback 2→3 steps for appended 0005)
- `prod/packages/ledger/src/coupled-pair-lifecycle.test.ts` (modified — bump migration-0004 reversibility rollback 1→2 steps for appended 0005)

## Change Log

- 2026-06-16 — Story 2.4 drafted: the off-chain Note↔pair data-model contract — a `rose_notes` table referencing exactly one coupled pair (NOT NULL + UNIQUE FK), `createRoseNote` enforcing delta-neutrality (equal-notional legs) at issuance with a `BEFORE INSERT` DB trigger backstop, and a deliberately minimal schema that does not encode the parked D1 loss-allocation/composition decision. Migration 0005. Status → ready-for-dev.
- 2026-06-16 — Story 2.4 implemented (TDD on the invariant): `@rose/ledger` gains `rose_notes` (migration 0005 + drizzle schema), `createRoseNote`/`getRoseNote`/`NotDeltaNeutralError`, `getCoupledPair` widened to `RoseExecutor`, and 9 new integration tests. Two appended-migration reversibility step counts bumped (no DONE migration edited). All gates green (138 tests; `check:migrations` over 5 migrations; `forge` 3/3). Status → review.
- 2026-06-16 — Code review (3 adversarial lenses — Blind Hunter, Edge Case Hunter against live Postgres 18, Acceptance Auditor): both ACs independently confirmed; no scope creep. Fixed 1 Med (raw `UPDATE` re-pointing a note to a skewed pair bypassed the INSERT-only trigger → trigger is now `BEFORE INSERT OR UPDATE`, re-checking only when `coupled_pair_id` changes) and improved review-surfaced clarity/test honesty (removed the trigger's redundant `IF NOT FOUND` branch so the real FK/NOT NULL constraints reject with native codes; corrected the docstring's UNIQUE-vs-"exactly one" attribution; documented + locked the 0/0 delta-neutral-by-design decision). +4 regression tests. All gates green (142 tests; `check:migrations` over 5; `forge` 3/3). Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 adversarial lenses — Blind Hunter (diff-only), Edge Case Hunter (live Postgres 18 on :5544, probed), Acceptance Auditor (diff + spec + epics + architecture))
**Date:** 2026-06-16
**Outcome:** Approve. Both ACs independently confirmed; off-chain Note↔pair data-model contract only (no Epic 5 mint, no Epic 6 subscription orchestration).

### Acceptance verdict
- **AC-1 (exactly one delta-neutral pair at issuance):** SATISFIED — `coupled_pair_id` NOT NULL + single FK column makes "exactly one" structural (zero/two unrepresentable, both arms now tested: NULL → 23502, two impossible by construction); `UNIQUE` makes the 1:1 embedding (documented P0 interpretation). Delta-neutral = `long_leg_value == short_leg_value`, enforced at issuance by the app guard (`NotDeltaNeutralError`, pure bigint) AND the DB trigger (now `BEFORE INSERT OR UPDATE`, non-bypassable — a raw re-point to a skewed pair is rejected). Post-issuance leg divergence does not invalidate an existing note (tested).
- **AC-2 (D1 parked):** SATISFIED — `rose_notes` is exactly `id, coupled_pair_id, created_at, updated_at`; no composition-mode / loss-allocation column; the trigger checks leg EQUALITY only (not V_A+V_B=K, which stays Epic 7 / D1). A test locks the column set.

### Findings & resolution
- **[Med — Blind Hunter — FIXED] Re-point bypass.** A raw `UPDATE rose_notes SET coupled_pair_id = <skewed pair>` slipped past the INSERT-only trigger, defeating the "non-bypassable" claim. Trigger changed to `BEFORE INSERT OR UPDATE`; on UPDATE it re-validates ONLY when `coupled_pair_id` actually changes (`TG_OP`/`IS NOT DISTINCT FROM` guard), so a re-point to a skewed pair is rejected (`check_violation`) while a no-op/`updated_at` bump — and the legitimate post-issuance divergence of the pair's own legs — pass untouched. Two regression tests added.
- **[Med — Acceptance Auditor — ADDRESSED (doc)] UNIQUE over-attribution.** The `createRoseNote` docstring claimed UNIQUE was part of "exactly one." Corrected: NOT NULL + single column ⇒ "exactly one"; UNIQUE ⇒ "at most one note per pair" (1:1 embedding, a documented P0 interpretation, not an AC requirement; reversible via a later migration). The 1:1 decision itself is retained and documented.
- **[Med — Edge Case Hunter — ADDRESSED (document + test)] 0/0 pair accepted.** `0 == 0` is delta-neutral, so a note over a zero-notional pair is accepted. This data-model layer intentionally does NOT require positive notional or an ACTIVE pair — economic substance is enforced upstream at issuance (Story 2.3 rejects a zero-value leg) and at live subscription (Epic 6). Adding a positive-notional guard here would invent scope beyond the AC ("equal notional"). Documented in the docstring and locked with an explicit test.
- **[Low — Blind + Edge — FIXED] Test honesty (FK/NOT-NULL).** The trigger's redundant `IF NOT FOUND` branch was raising `foreign_key_violation` for absent/NULL pairs, so the "bogus FK" test passed via the trigger, not the real constraint. Removed the branch: an absent/NULL pair leaves the legs NULL (`NULL IS DISTINCT FROM NULL` = false), so the trigger defers to the real FK (23503) and NOT NULL (23502) constraints, which the tests now genuinely exercise. The trigger owns ONLY delta-neutrality.
- **[Low — Edge Case Hunter — DISMISSED (correct by design)] TOCTOU.** The app-level read+insert is not row-locked, but the hunter proved (two live connections) the `BEFORE INSERT` trigger re-reads `coupled_pairs` at insert time and rejects a concurrently-skewed pair (`check_violation`) — so correctness rests on the trigger; the app guard is an advisory pre-check. Consistent with "delta-neutral at issuance" (the insert instant is the issuance instant).
- **[Low — Blind Hunter — DISMISSED] Empty-id error type, migration non-idempotent `up`, latent bigint-vs-numeric domain.** Empty/blank `coupledPairId` → `CoupledPairNotFoundError` is defensible at this internal layer; bare `CREATE` in `up` matches the established append-only/version-tracked convention (0001–0004); the bigint(app)/numeric(trigger) domains cannot disagree because `coupled_pairs` CHECKs force integral legs. No change.

### Action Items
- None blocking. Gate green (142 tests, +4 regression; `check:migrations` up→down→up over 5; `forge` 3/3); architecture-consistent (glossary `rose_notes`/`createRoseNote`, integrity-by-construction trigger, money as bigint/NUMERIC, no new package).
- Carry-forward (not this story): if the product later decides one coupled pair may back multiple Rose Notes (D1), relax the `UNIQUE (coupled_pair_id)` constraint via a new migration; economic-substance/ACTIVE-pair gating belongs to the Epic 6 subscription flow.
