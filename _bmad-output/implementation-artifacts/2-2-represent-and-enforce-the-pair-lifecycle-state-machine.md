---
baseline_commit: NO_VCS
---

# Story 2.2: Represent and enforce the pair lifecycle state machine

Status: done

## Story

As an internal operator,
I want a pair to move only through valid lifecycle states,
so that the pair's status is always explicit and observable, including the transient mid-rebalance state (FR-4).

## Acceptance Criteria

**AC-1 — Only valid transitions are accepted; any other is rejected explicitly; PARTIAL is a known transient mid-rebalance state**
**Given** an `ACTIVE` pair
**When** a lifecycle transition is requested
**Then** only transitions in `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED` are accepted, and any other transition is rejected explicitly
**And** `PARTIAL` is representable as a known transient mid-rebalance state

**AC-2 — The full lifecycle can be traversed and each state observed**
**Given** a pair created at `PENDING`
**When** it is driven through the complete lifecycle
**Then** the full path `PENDING → … → CLOSED` can be traversed and each state observed (supports SM-3)

## Tasks / Subtasks

- [x] **Task 1 — Define the explicit, allowed-transitions state machine (AC: 1, 2)**
  - [x] In `src/repositories/coupled-pairs.ts`, add `COUPLED_PAIR_TRANSITIONS: Readonly<Record<CoupledPairState, readonly CoupledPairState[]>>` — the single source of truth for the legal transition set (P0 interpretation documented in Dev Notes). Add `isPairTransitionAllowed(from, to): boolean`.
  - [x] Typed errors: `IllegalPairTransitionError` (carries `pairId`, `from`, `to`) and `CoupledPairNotFoundError` (carries `pairId`).
- [x] **Task 2 — Typed application transition function (app-level guard) (AC: 1, 2)**
  - [x] `transitionPair(db, pairId, toState)`: in a transaction, locks the row (`SELECT … FOR UPDATE`), throws `CoupledPairNotFoundError` if absent, throws `IllegalPairTransitionError` if the transition is not in the allowed set, else updates `state` and advances `updated_at`. Returns the updated `CoupledPairView`. Export from `src/index.ts` (already barrel-exports the repo).
- [x] **Task 3 — DB-level backstop: state-transition trigger (non-bypassable) (AC: 1)**
  - [x] New migration `src/migrations/0004-coupled-pair-lifecycle.ts` (typed module, raw SQL `up`/`down`). `up` creates `enforce_coupled_pair_transition()` (a `BEFORE UPDATE` trigger function on `coupled_pairs` that, only when `NEW.state IS DISTINCT FROM OLD.state`, rejects any `(OLD.state, NEW.state)` not in the allowed set via `RAISE EXCEPTION … USING ERRCODE = 'check_violation'`) and the `trg_coupled_pairs_lifecycle` trigger. `down` drops the trigger then the function (exact inverse). The SQL transition set MUST mirror `COUPLED_PAIR_TRANSITIONS`.
  - [x] Register `migration0004` append-only in `src/migrations/index.ts`.
- [x] **Task 4 — Integration tests against PostgreSQL, test-first on the invariant (AC: 1, 2)**
  - [x] Full legal traversal: a pair created at `PENDING` is driven `PENDING → ACTIVE → REBALANCING → PARTIAL → SETTLING → CLOSED` via `transitionPair`, and each intermediate state is observed via `getCoupledPair` (AC-2).
  - [x] Illegal transitions rejected at the app layer with `IllegalPairTransitionError` (e.g. `PENDING → CLOSED` skip, `ACTIVE → PENDING` backward, `CLOSED → ACTIVE` resurrection, `ACTIVE → PARTIAL` direct, same-state no-op).
  - [x] `CoupledPairNotFoundError` for an unknown id.
  - [x] DB backstop via raw SQL bypass: a raw `UPDATE coupled_pairs SET state = …` performing an illegal transition is rejected by the trigger even though the app function is bypassed; a legal one succeeds; a non-state update (e.g. anchor_price) is unaffected.
  - [x] App↔DB agreement: for all 30 distinct ordered state pairs, `isPairTransitionAllowed(from,to)` agrees with whether a raw-SQL `UPDATE` is accepted by the trigger (proves the two encodings are in sync).
  - [x] `PARTIAL` is reachable and observable as a transient mid-rebalance state (entered from `REBALANCING`, can resume `REBALANCING`, return to `ACTIVE`, or proceed to `SETTLING`).
  - [x] Migration `0004` forward → down → forward reversibility.
- [x] **Task 5 — Verification gate (AC: 1, 2)**
  - [x] With docker Postgres up: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (now 4 migrations) all green; `forge test` still green.

## Dev Notes

### Scope
- IS: the lifecycle **state machine** — an explicit allowed-transitions set, a typed app-level `transitionPair` guard, and a DB-level trigger backstop (migration `0004`), with tests proving a full legal traversal and explicit rejection of illegal transitions at BOTH layers.
- IS NOT: issuance journal entries (Story 2.3), Rose Note embedding / delta-neutrality (2.4), the rebalancing/reset MATH or its threshold triggering (Epic 7), and any automatic state changes driven by price/floor. This story only governs which state changes are *legal*; nothing here decides *when* a real transition should fire.

### Design decision — where the state machine is enforced (app guard + DB backstop)
[Source: architecture.md#Integrity by construction (NFR-1); CYCLE-BRIEF "Epic 1 pattern (app guard + DB backstop)"; Story 1.5 double-entry trigger]
Mirroring the Epic 1 double-entry invariant, the state machine is enforced at **two layers**:
1. **App-level typed guard** — `transitionPair(db, pairId, toState)` reads the row under a `SELECT … FOR UPDATE` lock, validates `(from → to)` against `COUPLED_PAIR_TRANSITIONS`, and throws a typed `IllegalPairTransitionError` (clean, attributable refusal) before writing. This is the path every caller uses.
2. **DB-level backstop** — a `BEFORE UPDATE` trigger (`enforce_coupled_pair_transition`) re-checks the same allowed set on any `coupled_pairs` row whose `state` actually changes, raising `check_violation`. This makes an illegal transition **non-bypassable** even via raw SQL or a future code path that forgets the guard — the integrity-by-construction backstop. The two encodings (the TS map and the SQL `CASE`/`IN` set) MUST stay in sync; a dedicated test asserts they agree over all 30 distinct ordered state pairs.

### P0 interpretation — the exact legal transition set (documented; resolves epic ambiguity)
[Source: epics.md#Story 2.2 + FR-4 — `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED`; "PARTIAL is a known transient mid-rebalance state"]
The epic's diagram is ambiguous about whether the rebalance cluster can return to `ACTIVE` or only proceed to `CLOSED`, and how `PARTIAL` is entered. The frozen P0 interpretation (single source of truth = `COUPLED_PAIR_TRANSITIONS`):

| From | Allowed To |
| --- | --- |
| `PENDING` | `ACTIVE` |
| `ACTIVE` | `REBALANCING`, `SETTLING` |
| `REBALANCING` | `PARTIAL`, `ACTIVE`, `SETTLING` |
| `PARTIAL` | `REBALANCING`, `ACTIVE`, `SETTLING` |
| `SETTLING` | `CLOSED` |
| `CLOSED` | _(terminal — none)_ |

Rationale, each a defensible reading rather than invented scope:
- **`PENDING` activates only to `ACTIVE`** — a pair cannot skip activation.
- **`ACTIVE` enters the cluster via `REBALANCING` or begins wind-down via `SETTLING`.** `ACTIVE → PARTIAL` is deliberately **not** allowed directly: `PARTIAL` is defined as a *mid-rebalance* transient, so it is reached only from within a rebalance (`REBALANCING → PARTIAL`). This is the cleanest reading of "PARTIAL is a known transient mid-rebalance state".
- **The rebalance cluster (`REBALANCING`/`PARTIAL`) can return to `ACTIVE`** (rebalance completed — operational reality) and routes to close only **through `SETTLING`** (`SETTLING` is the single pre-close state: you settle before you close). The diagram's "cluster → CLOSED" is realized via `SETTLING → CLOSED`.
- **`CLOSED` is terminal** — no resurrection, matching a closed pair's finality.
- **Same-state updates are not transitions.** `transitionPair(x, x)` is rejected by the app as `IllegalPairTransitionError` (a transition must change state). The DB trigger guards state *changes* only (`NEW.state IS DISTINCT FROM OLD.state`), so a no-op `state = state` UPDATE is not a lifecycle transition and is left alone; the agreement test therefore compares only the 30 distinct ordered pairs.

This set supports the AC-2 traversal `PENDING → ACTIVE → REBALANCING → PARTIAL → SETTLING → CLOSED` (visits every state once) and rejects every skip/backward/resurrection transition explicitly (AC-1).

### Architecture constraints
[Source: architecture.md#Data Architecture, #Naming Patterns, #Implementation Patterns; CYCLE-BRIEF]
- Stay in `@rose/ledger` (Story 2.1 placed `coupled_pairs` + the state enum here; build on it). No new package.
- Migrations are typed modules embedding raw SQL (`up`/`down`), registered append-only in `migrations/index.ts`; Epic 1+2.1 ended at `0003`; this is `0004`. NEVER edit a DONE migration. `down` is the exact inverse (drop trigger → drop function). `pnpm check:migrations` (up→down→up over 4 migrations) must stay green.
- The trigger is a plain `BEFORE UPDATE … FOR EACH ROW` trigger (a single-row state change is immediate, not a commit-time invariant like the deferred double-entry trigger). It only acts when `state` changes, so non-state updates (e.g. a future `anchor_price` reset write) pass through untouched.
- Enum values are the exact glossary codes (already frozen in 2.1). The state machine constrains *transitions between* those codes; it does not change the enum.

### Prior-story learnings (1.4–1.6, 2.1)
- Repos validate manually + throw typed errors (no Zod at this internal layer — no external ingress until Epic 6); cf. `AccountPlacementError`, `UnbalancedEntryError`, `InvalidCoupledPairError`. `IllegalPairTransitionError`/`CoupledPairNotFoundError` follow that shape (named error, carries structured fields).
- `db.transaction(async (tx) => …)` is the established multi-statement pattern (cf. `recordJournalEntry`). Use it with a `SELECT … FOR UPDATE` row lock to make read-check-write atomic (no TOCTOU): the DB trigger is still the ultimate backstop under any race.
- Drizzle `numeric` columns read back as strings; `state` reads back as the enum union type. `updated_at` does NOT auto-advance on UPDATE — set it explicitly (`sql\`now()\``) so an observer sees the transition time move.
- Tests share ONE DB serially (`fileParallelism:false`): `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE coupled_pairs CASCADE` per test. A pair can be seeded directly into a non-`PENDING` start state with an `INSERT` (INSERT is not guarded by the `BEFORE UPDATE` trigger) to test transitions out of each state.
- The DB CHECK/trigger is the real backstop — test it by bypassing the repo with raw `pool.query` SQL (cf. 2.1's raw-SQL CHECK-backstop test).

### Testing standards
[Source: architecture.md NFR-6; CYCLE-BRIEF] — Vitest integration tests co-located in `@rose/ledger`, against the live Postgres on `:5544`. Test-first on the invariant: a full legal traversal succeeds and every illegal transition is rejected, proven at BOTH the app layer (typed error) and the DB layer (raw-SQL bypass → `check_violation`). Include the app↔DB agreement test over all 30 distinct ordered state pairs and the `0004` reversibility test.

### References
- [Source: epics.md#Story 2.2] — user story + both AC scenarios (only valid transitions accepted; PARTIAL transient; full traversal observable).
- [Source: epics.md#FR-4] — `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED`; transitions explicit; PARTIAL transient; full lifecycle traversed and observed.
- [Source: prd.md#SM-3] — full lifecycle traversed and observed (validated end-to-end in Epic 7; this story makes it representable + enforced).
- [Source: architecture.md#Integrity by construction] — DB backstop bias; mirror the Epic 1 app-guard + DB-trigger pattern.
- [Source: CYCLE-BRIEF.md] — append-only migration `0004`; keep `check:migrations` green; document a defensible P0 interpretation for ambiguous transitions.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green, docker Postgres 18 on :5544): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 9 files, 120 tests passed; `pnpm format:check` → clean; `pnpm check:regime` → OK; `pnpm check:migrations` → "Reversibility OK: up→down→up over 4 migration(s)"; `forge test` → 3 passed.

### Completion Notes List

- **AC-1 satisfied (explicit transitions, illegal rejected, PARTIAL transient):** the legal set is one reviewable map `COUPLED_PAIR_TRANSITIONS` (single source of truth) with `isPairTransitionAllowed`. `transitionPair` accepts only in-set transitions and throws the typed `IllegalPairTransitionError` (carrying `pairId`/`from`/`to`) for everything else — skips (`PENDING→CLOSED`), backward (`ACTIVE→PENDING`), resurrection (`CLOSED→ACTIVE`), direct `ACTIVE→PARTIAL`, and same-state no-ops. `PARTIAL` is reachable only mid-rebalance (`REBALANCING→PARTIAL`) and can resume/return/proceed. The DB trigger (migration 0004) enforces the same set as the non-bypassable backstop — a raw-SQL illegal `UPDATE` is rejected with `check_violation`; a dedicated test proves the app map and the DB trigger agree over all 30 distinct ordered state pairs.
- **AC-2 satisfied (full traversal observable):** a `PENDING` pair is driven `PENDING → ACTIVE → REBALANCING → PARTIAL → SETTLING → CLOSED` via `transitionPair`, visiting all six states; each state is observed via `getCoupledPair` immediately after its transition, and `updated_at` advances on each transition.
- **Two-layer enforcement (Epic 1 pattern):** app-level typed guard + DB `BEFORE UPDATE` trigger backstop, mirroring the Story 1.5 double-entry trigger. `transitionPair` runs in a transaction with `SELECT … FOR UPDATE`, so the read-check-write is atomic and race-free (concurrent transitions serialize on the row lock and re-read the latest committed state; the DB trigger backstops regardless).
- **P0 interpretation (documented):** rebalance cluster may return to `ACTIVE`; close routes only through `SETTLING`; `ACTIVE→PARTIAL` direct is disallowed (PARTIAL is mid-rebalance only); `CLOSED` is terminal; same-state is a no-op, not a transition. See Dev Notes table — a deliberate, defensible reading of the ambiguous epic diagram, not invented scope.
- **Scope discipline:** only the state machine. No issuance (2.3), no Note embedding (2.4), no rebalancing math / threshold triggering (Epic 7), no automatic state changes. The trigger guards only genuine state *changes*, leaving non-state updates (e.g. a future `anchor_price` reset) untouched.
- **Test-only consequence of the new migration:** Story 2.1's `0003` reversibility test rolled back 1 step to drop `coupled_pairs`; with `0004` appended on top, it now rolls back 2 steps. This edits a test only — no DONE migration is modified (same pattern as Story 2.1 Task 5).

### File List

- `prod/packages/ledger/src/migrations/0004-coupled-pair-lifecycle.ts` (new — `BEFORE UPDATE` lifecycle trigger + function)
- `prod/packages/ledger/src/coupled-pair-lifecycle.test.ts` (new — 14 integration tests)
- `prod/packages/ledger/src/repositories/coupled-pairs.ts` (modified — `COUPLED_PAIR_TRANSITIONS`, `isPairTransitionAllowed`, `transitionPair`, `IllegalPairTransitionError`, `CoupledPairNotFoundError`; `sql` import)
- `prod/packages/ledger/src/migrations/index.ts` (modified — register `migration0004`)
- `prod/packages/ledger/src/coupled-pairs.test.ts` (modified — `0003` reversibility test now rolls back 2 steps under the appended `0004`; test-only)

## Change Log

- 2026-06-16 — Story 2.2 drafted: explicit allowed-transitions state machine for the coupled-pair lifecycle, enforced at two layers (typed `transitionPair` app guard + a `BEFORE UPDATE` DB trigger backstop in migration `0004`), with a documented P0 transition set. Status → ready-for-dev.
- 2026-06-16 — Story 2.2 implemented (TDD on the invariant): `@rose/ledger` gains `COUPLED_PAIR_TRANSITIONS` + `isPairTransitionAllowed` + `transitionPair` (row-locked, typed errors), migration `0004` (non-bypassable `BEFORE UPDATE` lifecycle trigger, exact-inverse down), and 14 new integration tests (full traversal, illegal rejections at both layers, app↔DB agreement over 30 pairs, 0004 reversibility). Updated the 2.1 `0003` reversibility test to roll back 2 steps (test-only). All gates green (incl. `check:migrations` over 4 migrations and `forge test`). Status → review.
- 2026-06-16 — Code review (3 adversarial lenses, live Postgres 18 probed via raw-SQL bypass): both ACs independently confirmed; no scope creep. No High/Med findings — the two-layer design (row-locked app guard + DB trigger), the 30-pair app↔DB agreement test, and the reversibility test cover the invariant comprehensively. Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 adversarial lenses — Correctness, Edge cases via live-DB raw-SQL probes, Acceptance — against Postgres 18 on :5544)
**Date:** 2026-06-16
**Outcome:** Approve. Both ACs independently confirmed; no scope creep into issuance/Note/rebalancing-math.

### Acceptance verdict
- **AC-1 (only valid transitions accepted; others rejected explicitly; PARTIAL transient):** SATISFIED — `transitionPair` accepts only in-set transitions and throws the typed `IllegalPairTransitionError` otherwise; the DB `BEFORE UPDATE` trigger rejects illegal raw-SQL transitions with `check_violation`. The 30-pair app↔DB agreement test proves the two encodings are identical. `PARTIAL` is representable and reached only mid-rebalance.
- **AC-2 (full traversal observable):** SATISFIED — `PENDING → ACTIVE → REBALANCING → PARTIAL → SETTLING → CLOSED` traversed via the app guard, every state observed via `getCoupledPair`, `updated_at` advances per transition.

### Findings & resolution
- **[Correctness — confirmed good] No TOCTOU.** `transitionPair` reads under `SELECT … FOR UPDATE` inside a transaction; concurrent transitions serialize on the row lock and re-read the latest committed `state`, and the DB trigger backstops any path that skips the guard. No race can persist an illegal state.
- **[Correctness — confirmed good] Trigger scoped to state changes.** `NEW.state IS DISTINCT FROM OLD.state` means non-state updates and same-state no-ops are untouched — verified by live raw-SQL probes (anchor_price update on an ACTIVE pair passes; `state='CLOSED'` on a CLOSED pair is a no-op).
- **[Edge — confirmed good] App/DB parity.** The 30 distinct-ordered-pair test asserts `isPairTransitionAllowed` equals the DB's accept/reject for every cross pair, guaranteeing the SQL `IN`-set and the TS map cannot drift silently.
- **[Reversibility — confirmed] `0004` down** drops the trigger then the function (exact inverse); `check:migrations verify` green over 4 migrations; a dedicated test rolls back only `0004`, asserts the function+trigger are gone (an illegal raw UPDATE then succeeds), re-applies, and asserts the backstop is restored.
- **[Acceptance — accepted] Documented P0 transition set.** Rebalance cluster → `ACTIVE` allowed; close only via `SETTLING`; `ACTIVE→PARTIAL` direct disallowed; `CLOSED` terminal. A defensible, documented reading of the ambiguous epic diagram (sanctioned by the brief), not invented scope. The full lifecycle remains traversable end-to-end.

### Action Items
- None. Gate green (120 tests; 14 new); architecture-consistent (mirrors the Epic 1 app-guard + DB-trigger pattern).
