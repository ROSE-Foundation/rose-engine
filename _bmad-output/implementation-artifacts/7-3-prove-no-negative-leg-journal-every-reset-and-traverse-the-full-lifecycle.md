---
baseline_commit: 89b15b61a546e9776f5525ea2fe476ba53a5b94c
---

# Story 7.3: Prove no-negative-leg, journal every reset, and traverse the full lifecycle

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a stakeholder / board member,
I want the **throwaway** harness to run a coupled pair over a full tick set and produce, as auditable evidence, (a) a **no-negative-leg** verdict that flags any leg that would go negative and any **gap past the floor** (the issuer-neutrality-break condition — the key model risk), (b) a **journal of every reset** (price, locked values, new anchor), and (c) a traversal of the **full pair lifecycle** (`PENDING → … → CLOSED`), with the floor parameters `m`/`g` fixed by a **stated, defensible method before observing the reset rate**,
so that I can judge the coupled-coin model — confirm or refute conditional issuer-neutrality within the barrier — on real ticks, cheaply and falsifiably, before any production weight rests on it (FR-17, SM-2, SM-3, SM-C1).

## Acceptance Criteria

1. **No-negative-leg verdict over a full tick set (consequence of SM-2).** A trial over a tick set reports, by consequence, whether **any leg went negative**. The proof obligation: while price stays **within the barrier** (`|L·r| < 1`), every per-tick evaluation has non-negative legs and `V_A + V_B = K` exactly (reusing `@throwaway/coupled-math` `evaluate(...)`: `legs !== null`, `invariantHolds`, `!legWouldBeNegative`). The report states the strongest observed deviation (closest approach to the barrier) so a near-miss is visible, not just a boolean.
2. **Gap-past-floor / issuer-neutrality-break report (the key model risk).** The trial explicitly reports whether **any gap breached the floor in a way that crosses the barrier** (`|L·r| > 1` ⇒ a leg would be negative ⇒ issuer-neutrality breaks). Each such break is reported with its tick index, price, anchor, and the leveraged deviation — this is the condition the model is on trial for. A breach that stops **at or before** the barrier (a normal floor-triggered reset, `|L·r| ≤ 1`) is **not** an issuer-neutrality break and is reported as a clean reset.
3. **Journal every reset (the audit artifact).** Every reset produced by `@throwaway/simulator` `simulate(...)` is journaled into a deterministic, serializable audit artifact. Each journal entry captures at minimum: tick index, timestamp (reporting-only), **breaching price**, **anchor before** (the breached P₀), **locked leg values** (`lockedLong`, `lockedShort` — summing to K, exact `bigint`), **locked loss** of the losing holder, **losing leg**, **new anchor P₀**, and the `gapPastFloor` flag. The journal is consumed from the 7.2 `ResetEvent` list (do **not** re-run or re-derive the reset logic). A run with zero resets yields an empty journal (a valid audit artifact, not an error).
4. **Full lifecycle traversal, observable end-to-end (SM-3).** A pure in-memory lifecycle state machine drives a pair through `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED`, mirroring the **FR-4 single-source transition set** (the same allowed transitions as `/prod` `COUPLED_PAIR_TRANSITIONS`). The trial: issues `PENDING`, activates to `ACTIVE` on first tick, enters `REBALANCING` (optionally `PARTIAL`) on each reset and returns to `ACTIVE`, then `SETTLING` and `CLOSED` at end-of-run. The **ordered transition log is observable** and every transition is legal (illegal transitions are refused). A run where at least one reset fires must exercise the rebalance cluster (`REBALANCING`/`PARTIAL`); every run reaches `CLOSED`. `CLOSED` is terminal.
5. **`m`/`g` chosen by a stated, defensible method BEFORE observing the reset rate (SM-C1 falsifiability).** The floor parameters are fixed as **pre-registered constants** with a documented rationale: `g` = a stated worst-plausible-gap over the reaction window, `m` = a stated fixed safety margin — **both committed in code/comments before the reset rate is observed**, never tuned after the fact to manufacture a low rate. A **pre-committed EUR/USD failure threshold** is stated (the reset rate that would count as the model failing SM-C1). Under this pre-registered floor: EUR/USD at `L = 1` ⇒ reset rate **near zero** (passes); BTC at `L = 1` ⇒ resets **expected** (the deliberate stress test — SM-C1 does **not** apply to BTC). The trial reports the observed reset rate against the pre-committed threshold.
6. **End-to-end trial over both fixtures (SM-2 + SM-3 + SM-C1 together).** A single `runTrial(...)` over the EUR/USD fixture produces: no-negative-leg = clean, zero issuer-neutrality breaks, an **empty** reset journal, reset rate near zero (passes the pre-committed threshold), and a full lifecycle traversal to `CLOSED`. The same over the BTC fixture produces: at least one journaled reset, the lifecycle exercising `REBALANCING`, and a no-negative-leg verdict + gap report consistent with the 7.2 reset semantics (a normal floor reset within the barrier ⇒ no issuer-neutrality break).
7. **Regime.** All new code lives under `/throwaway` (`throwaway/simulator/`). `/throwaway` may import `/prod` and `@throwaway/coupled-math`; `/prod` must **never** import `/throwaway` (`pnpm check:regime` stays green). The simulator package stays **not** a pnpm-workspace member and **not** part of the `/prod` build graph. No DB, no auth, no network — pure in-memory replay of the CSV fixtures.

### Scope boundary (P0, this story only)

- **IN:** turning the 7.2 reset *events* into *evidence* — (a) the **no-negative-leg verdict + gap-past-floor / issuer-neutrality-break report** over a full tick set, (b) the **journal-every-reset** audit artifact, (c) the **full lifecycle traversal** (`PENDING → … → CLOSED`) via a pure in-memory state machine mirroring the FR-4 transition set, (d) the **pre-registered `m`/`g` selection method** with a pre-committed EUR/USD failure threshold (SM-C1), and (e) an end-to-end `runTrial(...)` over both fixtures tying it together.
- **OUT:** any change to `@throwaway/coupled-math` (7.1, done) or to `simulate(...)`/`ResetEvent`/`parseTicks`/the fixtures (7.2, done) — they are **consumed**, never re-implemented. No new tick fixtures unless an existing one cannot exercise an AC (prefer inline CSV for crafted lifecycle/break cases). The **reset economics / balanced ledger settlement entry** (who funds the locked gain, where the locked loss posts in the double-entry ledger) is a `/prod` concern (Epics 2/5) and a deferred D1 product decision — **not** modeled here; this story journals the reset *facts* (locked values, anchor) as a throwaway audit artifact, not a `/prod` journal entry.
- **OUT:** any change under `/prod` source. (`vitest.config.ts` already matches `throwaway/**/*.test.ts` from 7.1 — **no** config change expected.) No real price feed; no clock-driven anything (the 7.2 FR-16 guarantee is inherited, not re-litigated).

## Tasks / Subtasks

- [x] Task 1 — Pre-registered floor-parameter method (SM-C1 falsifiability) (AC: #5)
  - [x] Add `throwaway/simulator/src/floor-method.ts` exporting a **pre-registered** `FloorParams` constant (`m`, `g` as decimal strings via `@throwaway/coupled-math` `FloorParams`) with a documented rationale: `g` = stated worst-plausible-gap over the reaction window (cite the basis — e.g. the EUR/USD fixture's largest single-tick move is sub-1%, so a plausible reaction-window gap is bounded well under the L=1 barrier), `m` = stated fixed safety margin. The constant and its rationale are committed **before** any reset-rate observation.
  - [x] Export a pre-committed `EURUSD_MAX_PLAUSIBLE_RESET_RATE` threshold (the EUR/USD reset rate that counts as SM-C1 failure) with rationale. Reuse the **same** floor `f = m·L·g < 1` already validated by 7.2 (`fpWide = { m: '1', g: '0.30' }` fires 0 EUR/USD resets, ≥1 BTC reset) as the pre-registered default unless a stronger documented basis is chosen; whatever is chosen is fixed in advance and never tuned to the observed rate.
- [x] Task 2 — Pure in-memory lifecycle state machine (FR-4, SM-3) (AC: #4)
  - [x] Add `throwaway/simulator/src/lifecycle.ts`: a `CoupledPairState` union (`'PENDING' | 'ACTIVE' | 'REBALANCING' | 'PARTIAL' | 'SETTLING' | 'CLOSED'`) and a `LIFECYCLE_TRANSITIONS` table **mirroring** the `/prod` single source of truth (`PENDING→[ACTIVE]`, `ACTIVE→[REBALANCING,SETTLING]`, `REBALANCING→[PARTIAL,ACTIVE,SETTLING]`, `PARTIAL→[REBALANCING,ACTIVE,SETTLING]`, `SETTLING→[CLOSED]`, `CLOSED→[]`). Cite `prod/packages/ledger/src/repositories/coupled-pairs.ts` `COUPLED_PAIR_TRANSITIONS` as the source of truth (mirror, don't import — keep the DB-coupled module out of the throwaway typecheck graph; a comment must note the mirror and the duplication risk).
  - [x] Provide a `Lifecycle` driver that records an **ordered transition log** and refuses any transition not in the table (throws). Expose `current`, `history`, and helpers `activate()`, `beginRebalance()`, `partial()`, `completeRebalance()`, `settle()`, `close()`.
- [x] Task 3 — No-negative-leg verdict + gap / issuer-neutrality-break report (FR-17, SM-2) (AC: #1, #2)
  - [x] In `throwaway/simulator/src/trial.ts`, walk every tick against the current anchor (reuse `simulate(...)` for resets and re-anchoring; for the **per-tick proof** evaluate against the running anchor that `simulate` would use, or have `simulate` already encode it — prefer deriving the verdict from the `SimResult` + a per-tick `evaluate` pass that re-uses the same anchor progression to avoid drift). Produce a `NoNegativeLegVerdict`: `anyLegNegative: boolean`, `closestApproachToBarrier` (max observed `|L·r|` while within barrier, as a lossy decimal for reporting), and the list of `IssuerNeutralityBreak`s (each reset/tick where `|L·r| > 1` ⇒ `legWouldBeNegative`).
  - [x] Distinguish a **clean floor reset** (`|L·r| ≤ 1`, legs exist) from an **issuer-neutrality break** (`|L·r| > 1`, `gapPastFloor === true`). Reuse the 7.2 `ResetEvent.gapPastFloor` flag as the break signal; do not recompute it differently.
- [x] Task 4 — Journal every reset (audit artifact) (AC: #3)
  - [x] In `trial.ts`, `buildResetJournal(resets: ResetEvent[]): ResetJournalEntry[]` maps each `ResetEvent` to a serializable journal entry (tick index, timestamp, price, anchorBefore, lockedLong, lockedShort, lockedLoss, losingLeg, newAnchorPrice, gapPastFloor). `bigint` fields serialize as decimal strings for the artifact (never JS `number`). Empty resets ⇒ empty journal. Provide a `journalToText(...)` (or NDJSON) deterministic renderer for the human/audit artifact.
- [x] Task 5 — End-to-end `runTrial(...)` tying it together (AC: #1–#6)
  - [x] `runTrial(ticks, config): TrialReport` where `TrialReport = { resetJournal, noNegativeLeg, issuerNeutralityBreaks, lifecycle: { final, history }, resetRate, ticksProcessed, finalAnchorPrice }`. It: runs `simulate`, builds the journal + verdict, drives the lifecycle (PENDING→ACTIVE→…→CLOSED, entering REBALANCING per reset), computes `resetRate = resets.length / ticksProcessed`, and returns the consolidated evidence. Re-export the public surface from `src/index.ts`.
- [x] Task 6 — Tests (consequences testable) (AC: #1–#7)
  - [x] **No-negative-leg / gap:** a within-barrier tick set (incl. EUR/USD fixture) ⇒ `anyLegNegative === false`, `issuerNeutralityBreaks === []`; a crafted inline gap-past-barrier set (e.g. P₀=100 → 250 at L=1, `|L·r| = 1.5 > 1`) ⇒ `anyLegNegative === true` and one `IssuerNeutralityBreak` with the right tick/price; a reset that stops exactly at the barrier (`|L·r| = 1`) is **not** flagged as a break.
  - [x] **Journal:** BTC fixture ⇒ a non-empty journal whose first entry matches the 7.2 reset (`anchorBefore '60000'`, `price '16000'`, `losingLeg 'long'`, `lockedLong + lockedShort === K`); EUR/USD fixture ⇒ empty journal; journal values are exact (bigint→string) and deterministic.
  - [x] **Lifecycle:** a full traversal reaches `CLOSED` with a legal ordered history; a run with ≥1 reset includes `REBALANCING` in `history`; an illegal transition (e.g. `PENDING → CLOSED`, or any move out of `CLOSED`) throws; `history` order matches the FR-4 set.
  - [x] **SM-C1 (pre-registered floor):** EUR/USD `runTrial` ⇒ `resetRate` at/below the pre-committed `EURUSD_MAX_PLAUSIBLE_RESET_RATE` (near zero), empty journal, clean verdict, lifecycle to `CLOSED`; BTC `runTrial` ⇒ `resetRate > 0`, journaled reset(s), lifecycle exercises `REBALANCING`. Assert the floor constant is the pre-registered one (the test reads it, never redefines a looser floor to pass).
  - [x] **Regime passthrough:** `loadFloorParams({})` still throws (no defaulting); the trial refuses a degenerate floor `f ≥ 1` (inherited from `simulate`).
- [x] Task 7 — Wire into the gate & validate (AC: #7)
  - [x] Root `vitest.config.ts` already matches `throwaway/**/*.test.ts` (7.1) — **no** config change; new tests run under `pnpm test`.
  - [x] Full gate green; `pnpm check:regime` stays green (`/prod` ↮ `/throwaway`); `pnpm exec tsc -p throwaway/simulator/tsconfig.json --noEmit` clean.

## Dev Notes

### Reuse from Stories 7.1 / 7.2 (DO NOT re-implement)

- **`@throwaway/coupled-math` (7.1, done)** — consume `evaluate(params, price, floorParams) → Evaluation` (`r`, `leveragedDeviation`, `withinBarrier`, `barrierCrossed`, `legWouldBeNegative`, `legs`, `invariantHolds`, `buffer`, `floor`, `floorBreached`), `floor`, `loadFloorParams`/`FloorParamRefusalError`, `FloorParams`, `PairParams`, and the `Rational` core (`cmp`, `abs`, `toApproxString`, `ONE`, `ZERO`, `gte`). The **issuer-neutrality break** signal is `evaluate(...).legWouldBeNegative` (`|L·r| > 1`); at exactly `|L·r| = 1` the losing leg is 0 (not negative) and `legs` exist — **not** a break. [Source: throwaway/coupled-math/src/coupled-math.ts:41-62, :141; index.ts]
- **`@throwaway/simulator` (7.2, done)** — consume `simulate(ticks, config) → SimResult` (`resets`, `ticksProcessed`, `finalAnchorPrice`) and the `ResetEvent` shape (`tickIndex`, `timestamp`, `price`, `anchorBefore`, `leveragedDeviationApprox`, `losingLeg`, `lockedLong`, `lockedShort`, `lockedLoss`, `newAnchorPrice`, `gapPastFloor`), plus `parseTicks`/`loadTicksFromFile` and the EUR/USD + BTC fixtures. The journal is **built from `SimResult.resets`** — never re-run the reset decision. [Source: throwaway/simulator/src/simulator.ts:38-89, :97; ticks.ts]

### The proof obligations (FR-17 / SM-2 / SM-3 / SM-C1) — exactly what to demonstrate

- **No-negative-leg (SM-2):** within the barrier, `V_A = (K/2)(1+L·r)`, `V_B = (K/2)(1−L·r)`, `V_A + V_B = K` and both ≥ 0. Proven **by consequence** over the tick set: for every tick while `withinBarrier`, `evaluate(...).legs !== null && invariantHolds && !legWouldBeNegative`. Report the closest approach (max `|L·r|`) so a near-miss is visible. [Source: epics.md#Story 7.3 AC; prd.md:348 SM-2; addendum.md#D]
- **Issuer-neutrality break (the KEY model risk, not an edge case):** `V_A+V_B=K` holds *within the barrier*; a price **gap past the floor** that crosses the barrier (`|L·r| > 1`) breaks it and leaves a leg short. The trial must **explicitly test for and report** this condition — it is what the model is on trial for. [Source: prd.md:433 "Model risk — conditional issuer-neutrality"; epics.md#Story 7.3 "the issuer-neutrality break condition"]
- **Journal-every-reset (SM-3 audit):** each reset is journaled (price, locked values, new anchor) as the auditable artifact. [Source: epics.md#Story 7.3 AC; prd.md:298-303 FR-17]
- **Full lifecycle (SM-3):** drive `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED` and make the traversal observable. [Source: prd.md:152, :303, :349 SM-3; architecture.md:38]
- **SM-C1 falsifiability:** pick `m`/`g` by a stated method *before* observing the reset rate; pre-commit the EUR/USD failure threshold. Do **not** tune `m`/`g` to manufacture a low rate. EUR/USD near-zero ⇒ pass; BTC resets ⇒ expected (SM-C1 does not apply to BTC). [Source: prd.md:355 SM-C1; addendum.md:43; architecture.md:396; review-adversarial-general.md M-3/M-4]

### FR-4 lifecycle transition set (mirror the /prod single source of truth — do NOT import)

The `/prod` allowed-transitions set is the single source of truth (FR-4). Mirror it exactly in throwaway (importing `prod/packages/ledger/src/repositories/coupled-pairs.ts` would pull `drizzle-orm` and DB types into the throwaway typecheck graph — keep it out; mirror with a comment noting the mirror + drift risk):

```
PENDING:     [ACTIVE]
ACTIVE:      [REBALANCING, SETTLING]
REBALANCING: [PARTIAL, ACTIVE, SETTLING]
PARTIAL:     [REBALANCING, ACTIVE, SETTLING]
SETTLING:    [CLOSED]
CLOSED:      []            # terminal
```

`PARTIAL` is a *mid-rebalance* transient reached only from `REBALANCING`/`PARTIAL` (never directly from `ACTIVE`). You settle (`SETTLING`) before you close. `CLOSED` is terminal (no resurrection). [Source: prod/packages/ledger/src/repositories/coupled-pairs.ts:215-230 `COUPLED_PAIR_TRANSITIONS`/`isPairTransitionAllowed`; epics.md#Story 2.2 / FR-4; architecture.md:38]

### Pre-registered floor (SM-C1) — concrete basis

7.2 already validated that `f = m·L·g < 1` with `{ m: '1', g: '0.30' }` (⇒ `f = 0.30`, barrier breach when `|L·r| ≥ 0.70`) fires **0** EUR/USD resets and **≥1** BTC reset under the **same** floor, at `L = 1`. The defensible reading: at `L = 1` the barrier is ~100% away; EUR/USD single-tick moves are sub-1% (worst-plausible reaction-window gap `g` bounded well under the barrier), so a margin `m` that keeps `f` comfortably below 1 leaves EUR/USD effectively never resetting while still firing on a BTC-scale drawdown. Fix `m`/`g` as named constants with this rationale **before** observing the rate; state the EUR/USD failure threshold (e.g. any non-zero EUR/USD reset over the fixture would warrant re-examination — near-zero is the SM-C1 bar). Whatever values are chosen, they are pre-registered and not retuned to the observed rate. [Source: 7-2 simulator.test.ts:16-21, :116-143; prd.md:355 SM-C1; addendum.md:43]

### Exact-arithmetic policy (reuse, never float)

Prices/leverage/`m`/`g` are decimal **strings**; leg values, K, locked values, and `lockedLoss` are smallest-unit `bigint`. Journal serialization renders `bigint` as decimal **strings** (never `Number()`/`parseFloat`). `|L·r|` for reporting (closest-approach, break detail) uses `Rational` + `toApproxString` (lossy, reporting-only — never asserted as an equality on money). [Source: 7-1/7-2 Dev Notes "Exact-arithmetic policy"; throwaway/coupled-math/src/rational.ts:114 `toApproxString`]

### Regime notes (mirror 7.1/7.2 exactly)

- `/throwaway` is deliberately **not** a pnpm-workspace member (first line of regime-boundary defense). Import `@throwaway/coupled-math` by relative path (`../../coupled-math/src/index.js`); `@rose/shared` (if needed) via `../../../prod/packages/shared/src/...js` (tolerated `/throwaway → /prod`). The regime guard scans only `/prod` and tolerates `/throwaway → /prod`. Do **NOT** import the DB-coupled `prod/packages/ledger` module — mirror its transition table instead. [Source: tools/check-regime-boundary.mjs; pnpm-workspace.yaml; 7-2 Dev Notes "Regime notes"]
- Root `tsconfig.json` references `/prod` packages only — do **not** add the simulator to the prod build graph; typecheck via the package's own `tsconfig.json` (`noEmit`). Root `vitest.config.ts` already includes `throwaway/**/*.test.ts` (7.1) — expect **no** config change. [Source: tsconfig.json; throwaway/simulator/tsconfig.json; vitest.config.ts]

### Testing standards summary

- Vitest, hermetic, in-memory. Tests co-located as `*.test.ts` under `throwaway/simulator/src/`. Use inline CSV strings for crafted lifecycle/gap-break cases; read the two fixtures via `loadTicksFromFile` for the EUR/USD-zero / BTC-≥1 end-to-end assertions. Assert money over exact `bigint`; assert `|L·r|`/closest-approach only as reporting strings.
- The proofs are **by consequence**: within-barrier ⇒ no negative leg + invariant holds on every tick; the gap-past-barrier inline case ⇒ a reported issuer-neutrality break; every reset ⇒ a journal entry; the run ⇒ a legal `PENDING → … → CLOSED` history; EUR/USD ⇒ near-zero reset rate under the pre-registered floor.

### Project Structure Notes

- New files under the existing `throwaway/simulator/src/`: `floor-method.ts`, `lifecycle.ts`, `trial.ts` (+ co-located `*.test.ts`), re-exported from `src/index.ts`. No new package, no new fixture expected (prefer inline CSV for crafted cases; reuse `fixtures/eurusd.csv` + `fixtures/btc.csv`). [Source: architecture.md:329-332, :359 "`simulator/` FR-16, FR-17"]
- Modified: expected **none** under `/prod`. (`vitest.config.ts` already wired in 7.1.)

### Anti-patterns to avoid (disaster prevention)

- Re-implementing or re-running the 7.2 reset decision (consume `SimResult.resets`). Re-implementing the 7.1 math (consume `evaluate`). Importing the DB-coupled `/prod` ledger module into throwaway (mirror the transition table). Float money/price/`|L·r|` math on any asserted path. **Tuning `m`/`g` to the observed reset rate** (defeats SM-C1 falsifiability — pre-register them). Treating a `|L·r| = 1` reset as an issuer-neutrality break (it is not — the break is `> 1`). Building a lifecycle that allows an illegal transition (e.g. `ACTIVE → PARTIAL` directly, or any move out of `CLOSED`). `/prod` importing `/throwaway`; making the simulator a pnpm-workspace/prod build dependency. Modeling `/prod` reset *economics* / ledger settlement here (out of scope — throwaway audit artifact only).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 7.3 (AC) / #Story 2.2 (FR-4 lifecycle)]
- [Source: _bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/prd.md:62, :152, :298-303 (FR-17), :348-349 (SM-2/SM-3), :355 (SM-C1), :433 (model risk)]
- [Source: _bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md#D (:43 m/g parked, SM-C1)]
- [Source: _bmad-output/planning-artifacts/architecture.md:38 (lifecycle), :43, :329-332, :359, :396 (floor-parameter method)]
- [Source: throwaway/coupled-math/src/coupled-math.ts; floor-params.ts; index.ts (7.1 — done)]
- [Source: throwaway/simulator/src/simulator.ts; ticks.ts; fixtures/ (7.2 — done)]
- [Source: prod/packages/ledger/src/repositories/coupled-pairs.ts:215-230 (COUPLED_PAIR_TRANSITIONS — mirror, do not import)]
- [Source: _bmad-output/implementation-artifacts/7-2-simulate-threshold-only-rebalancing-over-historical-ticks.md (Completion Notes / Interfaces for 7.3)]
- [Source: tools/check-regime-boundary.mjs; pnpm-workspace.yaml; vitest.config.ts; tsconfig.json]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `pnpm exec vitest run throwaway/simulator` → 42/42 (5 files): 17 from 7.2 + 25 new (lifecycle 8, floor-method 3, trial 14).
- `pnpm exec tsc -p throwaway/simulator/tsconfig.json --noEmit` → clean (the new modules import only `@throwaway/coupled-math` + sibling 7.2 modules; no `/prod` ledger import — the lifecycle table is mirrored, not imported, keeping `drizzle-orm`/DB types out of the throwaway typecheck graph).
- `pnpm exec prettier --write throwaway/simulator/src/trial.ts` (import block reflow only) — re-ran simulator tests after: 42/42 still green.
- Full gate: `pnpm test` 726 passing (86 files); `pnpm typecheck` (tsc -b) clean; `pnpm lint` clean; `pnpm check:regime` ✅ (`/prod` has no imports from `/throwaway`); `pnpm check:migrations` reversibility OK (7 migrations); `pnpm format:check` clean. No Solidity touched ⇒ `forge test` unchanged (171).

### Completion Notes List

- **AC-1 (no-negative-leg verdict):** `runTrial` walks every tick against the reconstructed anchor timeline and builds a `NoNegativeLegVerdict` — `anyLegNegative`, `invariantHeldWithinBarrier` (true ⇒ on every within-barrier tick `legs !== null && invariantHolds`), and `closestApproachToBarrier` (max `|L·r|` as a lossy decimal, so a near-miss is visible). Proven by consequence: the EUR/USD fixture and a `100→105→98→102→99` set ⇒ `anyLegNegative === false`, `invariantHeldWithinBarrier === true`.
- **AC-2 (issuer-neutrality-break report):** a gap past the barrier (`P₀=100 → 250`, `|L·r| = 1.5 > 1`) ⇒ `anyLegNegative === true` + one `IssuerNeutralityBreak` (tick 0, price 250, anchor 100); a reset that stops **exactly** at the barrier (`P₀=100 → 200`, `|L·r| = 1`) ⇒ **not** a break (`gapPastFloor === false`, `closestApproachToBarrier === '1.00000000'`) yet a reset still fired. The break signal reuses `evaluate(...).legWouldBeNegative` (`|L·r| > 1`), consistent with the 7.2 `ResetEvent.gapPastFloor`.
- **AC-3 (journal every reset):** `buildResetJournal(sim.resets)` maps each 7.2 `ResetEvent` to a serializable `ResetJournalEntry` (bigint → decimal string, never float); `journalToText` renders deterministic NDJSON. BTC ⇒ first entry `anchorBefore '60000'`, `price '16000'`, `losingLeg 'long'`, `gapPastFloor false`, `BigInt(lockedLong)+BigInt(lockedShort) === K`; EUR/USD ⇒ empty journal (`journalToText === ''`). Resets come **solely** from `simulate` — never re-derived.
- **AC-4 (full lifecycle traversal):** `Lifecycle` mirrors the FR-4 `COUPLED_PAIR_TRANSITIONS` set exactly (pinned by a test). `runTrial` drives `PENDING → ACTIVE → (REBALANCING → PARTIAL on the first reset →) ACTIVE → … → SETTLING → CLOSED`; `history` is observable and ordered. BTC (≥1 reset) exercises `REBALANCING` **and** `PARTIAL` and reaches `CLOSED`; EUR/USD (0 resets) ⇒ `['PENDING','ACTIVE','SETTLING','CLOSED']`. Illegal moves throw `IllegalLifecycleTransitionError` (e.g. `PENDING→CLOSED`, any move out of terminal `CLOSED`, `ACTIVE→PARTIAL` direct).
- **AC-5 / SM-C1 (pre-registered `m`/`g`):** `PRE_REGISTERED_FLOOR = { m:'1', g:'0.30' }` committed in `floor-method.ts` with the stated method (`g` = worst-plausible 30% reaction-window gap at L=1; `m` = fixed margin 1 ⇒ `f = 0.30 < 1`), and `EURUSD_MAX_PLAUSIBLE_RESET_RATE = 0` pre-committed. Values are the SAME floor 7.2 already validated — adopted as the pre-registered method, **not** searched for after observing the rate. Tests pin both constants so any change is a visible, deliberate edit.
- **AC-6 (end-to-end both fixtures):** EUR/USD `runTrial` ⇒ `resetCount 0`, `resetRate '0.00000000'` (≤ pre-committed threshold), empty journal, clean no-negative-leg verdict, lifecycle to `CLOSED`. BTC `runTrial` ⇒ `resetCount > 0`, `resetRate > 0`, journaled reset(s), lifecycle exercises `REBALANCING`, and the single floor reset is **within the barrier** (no issuer-neutrality break) — consistent with 7.2.
- **AC-7 (regime):** all new code under `throwaway/simulator/src/`; reuses `@throwaway/coupled-math` + sibling 7.2 modules only; `pnpm check:regime` green; no `/prod` source changed; `vitest.config.ts` already wired the throwaway glob in 7.1 (no change). Pure in-memory — no DB/auth/network.
- **Scope held:** evidence layer only (verdict + journal + lifecycle + pre-registered floor). The `/prod` reset **economics** / balanced ledger settlement entry (deferred D1 product decision) is deliberately NOT modeled — the journal records reset *facts*, not a `/prod` journal entry. No change to 7.1 math or 7.2 simulate/ResetEvent/fixtures (consumed, not modified).
- **No new dependency, no secret, no placeholder.** Reuses existing `@throwaway/coupled-math`, `vitest`, `typescript`, Node stdlib (`node:url` in tests). No `@rose/shared` import needed in 7.3.
- **Model verdict (this validation):** the coupled-coin model is **confirmed under its stated condition** — issuer-neutrality (`V_A+V_B=K`, no negative leg) holds within the barrier on both tick sets, and the one risk that breaks it (a gap past the barrier, `|L·r|>1`) is detected and reported rather than hidden. EUR/USD at L=1 under the pre-registered plausible floor fires **zero** resets (SM-C1 passes); BTC at L=1 resets as expected (stress test) and does so **within** the barrier (a clean floor reset, no issuer-neutrality break over this fixture). The model is **conditionally issuer-neutral within the barrier**, exactly as the PRD frames the key model risk (prd.md:433) — not refuted by this trial.

### File List

**New — `throwaway/simulator/src/`:**

- `floor-method.ts` (`PRE_REGISTERED_FLOOR`, `EURUSD_MAX_PLAUSIBLE_RESET_RATE` — SM-C1 pre-registration)
- `floor-method.test.ts` (3 tests)
- `lifecycle.ts` (`CoupledPairState`, `LIFECYCLE_TRANSITIONS`, `isTransitionAllowed`, `IllegalLifecycleTransitionError`, `Lifecycle` — pure FR-4 state machine mirroring `/prod`)
- `lifecycle.test.ts` (8 tests)
- `trial.ts` (`runTrial`, `buildResetJournal`, `journalToText`, `TrialReport`, `NoNegativeLegVerdict`, `IssuerNeutralityBreak`, `ResetJournalEntry` — the model trial)
- `trial.test.ts` (14 tests)

Total new throwaway tests: 25 (simulator package 17 → 42).

**Modified:**

- `throwaway/simulator/src/index.ts` (re-export `lifecycle`, `floor-method`, `trial`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (7-3 backlog → ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/7-3-...md` (this story: tasks, Dev Agent Record, status)

## Change Log

| Date       | Version | Description                                | Author |
| ---------- | ------- | ------------------------------------------ | ------ |
| 2026-06-17 | 0.1     | Story drafted (create-story), ready-for-dev | Amelia |
| 2026-06-17 | 0.2     | Implemented the model trial in `@throwaway/simulator` — `runTrial` produces the no-negative-leg verdict + issuer-neutrality-break report (FR-17/SM-2), the journal-every-reset audit artifact (SM-3), and a full `PENDING → … → CLOSED` lifecycle traversal (SM-3) via a pure state machine mirroring the FR-4 `/prod` transition set; `m`/`g` pre-registered with a stated method + pre-committed EUR/USD failure threshold (SM-C1). EUR/USD ⇒ 0 resets / empty journal / clean; BTC ⇒ journaled reset within the barrier. Vitest 703 → 726 (+25 in package); full gate green; status → review | Amelia |
