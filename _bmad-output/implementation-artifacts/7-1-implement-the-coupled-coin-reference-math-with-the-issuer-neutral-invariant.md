# Story 7.1: Implement the coupled-coin reference math with the issuer-neutral invariant

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a stakeholder / board member,
I want a reference-math library (in the **throwaway** regime) proving the issuer-neutral invariant `V_A + V_B = K` within the barrier and detecting floor breaches,
so that I have cheap, falsifiable evidence the coupled-coin model holds before any production weight rests on it (FR-15, SM-2).

## Acceptance Criteria

1. **Leg values from price (issuance/active state).** The throwaway `coupled-math` library computes leg values from price as `V_A = (K/2)(1 + L·r)` (long leg) and `V_B = (K/2)(1 − L·r)` (short leg), where `r = (P − P₀)/P₀` is the deviation from the anchor and `L` is the **per-pair** leverage (read per call, never hard-coded).
2. **Issuer-neutral invariant — exact.** Across a price grid **within the barrier**, the posted integer leg values satisfy `V_A + V_B == K` **exactly** (issuer net = 0 ⇒ SM-2). Model math may compute the proportions at higher precision, but the asserted equality is over exact smallest-unit integers under the deterministic remainder/rounding policy — no binary float in the invariant assertion. The exact split reuses the `@rose/shared` largest-remainder primitive (`allocate`/`splitInTwo`).
3. **No negative leg within the barrier.** While `P` stays within the barrier (`|L·r| < 1`), neither leg becomes negative.
4. **Floor `f = m · L · g`, refuse-if-absent.** The floor is computed as `f = m · L · g` (g = worst plausible gap over the reaction window; m = safety margin) with `m` and `g` read from config. When `m` or `g` is absent the library **refuses** (raises an explicit error, never defaults / never 0); when present, a **floor breach is detected**.
5. **Gap past the floor (the key model risk).** There is an explicit test for a price gap **past** the floor — the condition under which a leg would go negative and issuer-neutrality can break — and the library reports that breach condition (`floorBreached` and the barrier-cross / would-be-negative-leg flag).
6. **Regime.** All new code lives under `/throwaway` (regime). `/throwaway` may import `/prod` (e.g. `@rose/shared`); `/prod` must never import `/throwaway` (`pnpm check:regime` stays green).

### Scope boundary (P0, this story only)

- IN: the reference math (`r`, leg values), the exact issuer-neutral invariant check, barrier test, floor (`f = m·L·g`) computation with refuse-if-absent, and floor-breach / gap-past-floor detection.
- OUT (later epic-7 stories): the historical-tick **simulator** and threshold-only reset/re-anchor mechanics (7.2); the no-negative-leg proof + journal-every-reset + full lifecycle traversal over a tick set (7.3). No CSV ingestion, no reset/lock/re-anchor here.
- OUT: any change under `/prod` source (other than the root `vitest.config.ts` test wiring so the throwaway tests run in the `pnpm test` gate). No DB, no auth, no network — pure in-memory math.

## Tasks / Subtasks

- [ ] Task 1 — Stand up the throwaway `coupled-math` package (AC: #6)
  - [ ] Create `throwaway/coupled-math/` with `package.json` (private, not a pnpm-workspace member — preserves the regime defense), `tsconfig.json` (typecheck-only, extends base), `src/`, `README.md`.
  - [ ] Reuse `@rose/shared` exact-money primitive (`allocate`/`splitInTwo`) for the leg split (import from `/prod` source — throwaway→prod is allowed by the regime rule).
- [ ] Task 2 — Exact rational core (AC: #1, #2)
  - [ ] Implement a minimal exact `Rational` (bigint num/den) and `parseDecimal` for prices/leverage/`m`/`g` (decimal strings, never JS `number`).
  - [ ] `referenceDeviation(price, anchor)` → `r`; `leveragedDeviation(price, anchor, leverage)` → `L·r`.
  - [ ] `legValues({ anchorPrice, leverage, collateralPool }, price)` → `{ long, short }` smallest-unit bigints using `allocate(K, [b+a, b-a])` so `long + short === K` by construction.
- [ ] Task 3 — Barrier + invariant + no-negative-leg (AC: #2, #3)
  - [ ] `withinBarrier(price, anchor, leverage)` (`|L·r| < 1`); `invariantHolds(legs, K)` (`long + short === K`).
  - [ ] Tests: a price **grid within the barrier** asserting `long + short === K` exactly and `long >= 0 && short >= 0`, for `L = 1` (EUR/USD, BTC P0) and a non-unit `L` (per-pair, not hard-coded).
- [ ] Task 4 — Floor + breach detection, refuse-if-absent (AC: #4, #5)
  - [ ] `loadFloorParams(env)` reads `MODEL_FLOOR_M` / `MODEL_FLOOR_G` and **refuses** (explicit error naming the offender) when either is absent/invalid — never defaults.
  - [ ] `floor(leverage, floorParams)` → `f = m·L·g`; `floorBreached(price, params, floorParams)` (buffer `1 − |L·r| <= f`).
  - [ ] `evaluate(...)` one-shot report: `{ r, leveragedDeviation, withinBarrier, legs, invariantHolds, buffer, floor, floorBreached, barrierCrossed }`.
  - [ ] Tests: floor refusal (m absent / g absent / both); floor breach detected just inside the floor; **explicit gap-past-floor** test where `|L·r| >= 1` ⇒ `barrierCrossed`/would-be-negative-leg ⇒ issuer-neutrality break condition is reported.
- [ ] Task 5 — Wire throwaway tests into the gate (AC: #6)
  - [ ] Extend root `vitest.config.ts` `include` with `throwaway/**/*.test.ts` and drop `throwaway/**` from `exclude` so the story tests run under `pnpm test`. (The regime defense is the import rule, enforced by `pnpm check:regime`/eslint — unchanged.)
  - [ ] Run the full gate; confirm `pnpm check:regime` stays green (`/prod` ↮ `/throwaway`).

## Dev Notes

### Math (from the addendum — follow exactly)

- `r = (P − P₀)/P₀`; `V_A = (K/2)(1 + L·r)`; `V_B = (K/2)(1 − L·r)`; **INVARIANT** `V_A + V_B = K` for all P ⇒ issuer net = 0 (SM-2). [Source: _bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md#D]
- **Barrier:** a leg reaches zero at `|L·r| = 1`; beyond that a leg would be negative. At `L = 1` the barrier is ~100% away (EUR/USD almost never triggers; BTC is the higher-volatility stress test of the same invariant). [Source: addendum.md#D, #Simulator rationale]
- **Floor:** `f = m · L · g` (g = worst plausible gap over the reaction window; m = safety margin). Floor breach when the losing leg's remaining buffer `1 − |L·r|` drops to/below `f`. A **gap past the floor** (a single jump taking `|L·r| ≥ 1`) is the condition under which a leg goes negative and issuer-neutrality can break — the key model risk to test explicitly. [Source: addendum.md#D]

### Exact-arithmetic policy (reuse, don't reinvent)

- Money is integer smallest units (`bigint`), never binary float (NFR-2). Reuse `@rose/shared` `allocate(total, weights)` / `splitInTwo(total)` — the largest-remainder method that makes integer splits sum to the total **exactly** (it is documented there as "the `V_A + V_B = K` primitive"). Split with weights `[b + a, b − a]` where `L·r = a/b` (b > 0): the parts are proportional to `(1 + L·r) : (1 − L·r)` and sum to `K` exactly. [Source: prod/packages/shared/src/money.ts (allocate/splitInTwo)]
- Model proportions are computed with exact `Rational` (bigint num/den) — higher precision than the integer posting — and the asserted equality is over the integer parts. No `Number()`/`parseFloat` on money paths.

### Refuse-if-absent pattern to mirror

- The parked floor params already exist as `MODEL_FLOOR_M` / `MODEL_FLOOR_G` in `@rose/config` and `.env.example` (blank). Mirror the fail-closed pattern (refuse, name the offender, never default — NFR-4, §11.2) in a focused `loadFloorParams` so the throwaway lib is self-contained and the m/g-absence test is isolated. [Source: prod/packages/config/src/config.ts; .env.example]

### Regime notes

- `/throwaway` is deliberately **not** a pnpm-workspace member (pnpm-workspace.yaml comment: "first line of regime-boundary defense"). So `@rose/shared` is not resolvable by package name from throwaway — import the primitive via a relative path into `/prod` source (`../../../prod/packages/shared/src/money.js`). The regime guard only scans `/prod` and tolerates `/throwaway → /prod`. [Source: tools/check-regime-boundary.mjs; pnpm-workspace.yaml]
- Root `tsconfig.json` references `/prod` packages only; do **not** add throwaway to the prod build graph. Typecheck the throwaway package via its own `tsconfig.json` (noEmit) during dev validation. [Source: tsconfig.json]

### Testing standards summary

- Vitest, hermetic, in-memory (no DB/network/secret). Tests co-located as `*.test.ts` under `throwaway/coupled-math/src/`.
- Invariant assertions are over exact `bigint` equality (`long + short === K`); never assert on a float.

### Full gate (must all pass before review)

- `pnpm test` (throwaway tests now included), `pnpm typecheck`, `pnpm lint`, `pnpm check:regime` (CRITICAL — `/prod` must not import `/throwaway`), `pnpm check:migrations`, `pnpm format:check`. No Solidity touched ⇒ `forge test` unchanged (171). Baseline Vitest 656.

### Project Structure Notes

- New: `throwaway/coupled-math/` (per architecture tree — "FR-15 — reference math + issuer-neutral invariant"). [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure]
- Modified: root `vitest.config.ts` only (test wiring). No `/prod` source change.

### Anti-patterns to avoid (disaster prevention)

- Float money math; asserting the invariant on floats; defaulting an absent floor param to 0; hard-coding `L`; `/prod` importing `/throwaway`; making `/throwaway` a pnpm-workspace/prod build dependency; implementing the simulator/reset/lifecycle here (that is 7.2/7.3).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 7.1]
- [Source: _bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md#D]
- [Source: prod/packages/shared/src/money.ts]
- [Source: prod/packages/config/src/config.ts]
- [Source: tools/check-regime-boundary.mjs]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `pnpm exec vitest run throwaway/coupled-math` → 28/28 (3 files). First run had a brittle "message not contain '0'" assertion; reworked to assert "refuses instead of returning" (no permissive default produced).
- `pnpm exec tsc -p throwaway/coupled-math/tsconfig.json --noEmit` clean — the relative `.js`→`.ts` import of `@rose/shared` `allocate` from `/prod` source resolves under NodeNext; `noEmit` relaxes the rootDir constraint for the cross-regime (throwaway→prod) source import.
- Full gate: Vitest 656→684 (+28), `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` all green. `forge test` not run — no Solidity touched (stays 171).
- `pnpm check:regime` green: `/prod` has no imports from `/throwaway` (the throwaway→prod relative import is the tolerated direction; only `/prod` is scanned).

### Completion Notes List

- **AC-1 (leg values from price):** `referenceDeviation` (`r=(P−P₀)/P₀`), `leveragedDeviation` (`L·r`), and `legValues` compute `V_A=(K/2)(1+L·r)` / `V_B=(K/2)(1−L·r)`. `L` is read per call from `leverage` (never hard-coded); covered for `L=1` (EUR/USD, BTC P0) and a non-unit `L=2`. Worked example asserted: P₀=100, P=150, L=1, K=1000 → {long 750, short 250}.
- **AC-2 (issuer-neutral invariant, EXACT):** the split reuses `@rose/shared` `allocate(K, [b+a, b−a])` (where `L·r=a/b`, b>0) — weights proportional to `(1+L·r):(1−L·r)`, parts sum to K **by construction**. Asserted over a price grid within the barrier (`L=1`: P∈[1,199]; `L=2`: P∈[51,149]) across K = 1e6, 999_999 (odd), 7 (tiny), 1e18 (token magnitude) — `long+short === K` exactly, every time, over `bigint` (no binary float in the assertion). SM-2 ⇒ issuer net = 0.
- **AC-3 (no negative leg within the barrier):** asserted `long>=0 && short>=0` across the whole grid. The odd-K/r=0 case proves the deterministic residual policy (long absorbs the +1 unit; sum stays exact). At the boundary `|L·r|=1` the losing leg is exactly 0 (not negative) and the invariant still holds.
- **AC-4 (floor `f=m·L·g`, refuse-if-absent):** `floor(leverage, {m,g})` computes the exact floor; `loadFloorParams(env)` reads `MODEL_FLOOR_M`/`MODEL_FLOOR_G` and **refuses** (naming every offender) on absence/invalidity — never defaults. `floorBreached` detects buffer `1−|L·r| ≤ f`.
- **AC-5 (gap PAST the floor — key model risk):** explicit test of a single jump to P=250 (`L·r=1.5`): `evaluate` reports `barrierCrossed=true`, `legWouldBeNegative=true`, `legs=null` (no non-negative integer split exists ⇒ V_A+V_B=K cannot be posted), `invariantHolds=false`, `floorBreached=true`, negative buffer. This is exactly the condition under which issuer-neutrality breaks. `legValues` throws (RangeError) past the barrier.
- **AC-6 (regime):** all code under `throwaway/coupled-math/`. `/throwaway` is NOT a pnpm-workspace member (preserves the regime defense), so `@rose/shared` is reached by a relative import into `/prod` source — the tolerated `/throwaway → /prod` direction. `pnpm check:regime` green.
- **Scope held:** reference MATH + invariant + floor detection only. NO simulator/CSV/tick replay (7.2), NO reset/lock/re-anchor or full-lifecycle/journal-every-reset over a tick set (7.3). No DB, auth, or network — pure in-memory.
- **No `/prod` source change** beyond the root `vitest.config.ts` test-include wiring (so the throwaway suite runs in the `pnpm test` gate). `.env.example` already had blank `MODEL_FLOOR_M`/`MODEL_FLOOR_G`; no secret/placeholder added; no new dependency declared (reuses existing `@rose/shared`, `vitest`, `typescript`).
- **Interfaces for 7.2 / 7.3:** `legValues`, `evaluate` (full report incl. `barrierCrossed`/`legWouldBeNegative`/`floorBreached`/`buffer`), `withinBarrier`, `floorBreached`, `floor`, `buffer`, `loadFloorParams`, and the exact `Rational` core — these are the primitives the threshold-only simulator (7.2) and the no-negative-leg / journal-every-reset proof (7.3) consume.

### File List

**New — `throwaway/coupled-math/`:**

- `package.json` (`@throwaway/coupled-math`; private; NOT a pnpm-workspace member; no new deps)
- `tsconfig.json` (typecheck-only, `noEmit`, extends base; includes the `@rose/shared` money source for cross-regime typecheck)
- `src/index.ts` (public surface re-exports)
- `src/rational.ts` (exact BigInt `Rational`: parse/add/sub/mul/div/cmp/abs + lossy `toApproxString` for reporting only)
- `src/rational.test.ts` (7 tests)
- `src/floor-params.ts` (`loadFloorParams`, `FloorParamRefusalError` — refuse-if-absent + strictly-positive m/g)
- `src/floor-params.test.ts` (7 tests)
- `src/coupled-math.ts` (`referenceDeviation`, `leveragedDeviation`, `withinBarrier`, `legValues`, `invariantHolds`, `floor`, `buffer`, `floorBreached`, `evaluate`)
- `src/coupled-math.test.ts` (14 tests)

Total: 28 throwaway tests (7 + 7 + 14).

**Modified:**

- `vitest.config.ts` (root — added `throwaway/**/*.test.ts` to `include`; removed `throwaway/**` from `exclude`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (epic-7 → in-progress; 7-1 backlog → ready-for-dev → in-progress → review → done)

## Change Log

| Date       | Version | Description                                                                                                                                                                                                                                                                                            | Author |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-17 | 0.1     | Story drafted (create-story), ready-for-dev                                                                                                                                                                                                                                                             | Amelia |
| 2026-06-17 | 0.2     | Implemented `@throwaway/coupled-math` — exact `Rational` core, `r`/`L·r`/leg values via `@rose/shared` `allocate` (issuer-neutral invariant `V_A+V_B=K` exact over a price grid within the barrier), barrier + no-negative-leg, `floor f=m·L·g` with refuse-if-absent, and gap-past-floor detection. Vitest 656→683; full gate green; status → review | Amelia |
| 2026-06-17 | 0.3     | Code review (3 adversarial layers). 1 patch applied (refuse non-positive m/g — a zero/negative margin or gap would mask the model risk; +1 test); 0 deferred; rest dismissed. Vitest 683→684; forge 171 unchanged; full gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] `loadFloorParams` accepted non-positive `m`/`g` (`"0"`, `"-1"`, `"0.0"`) [throwaway/coupled-math/src/floor-params.ts] — a zero/negative safety margin or worst-gap yields a floor that never (or perversely) breaches, silently masking the very model risk this harness exists to surface. `validDecimal` now requires a strictly positive decimal; refusal names every offender. New test covers zero, negative, and the both-offenders case. (Edge + Acceptance, Med)
- [Review][Dismiss] `evaluate` recomputes `referenceDeviation`/`leveragedDeviation` a few times — acceptable for a throwaway harness (pure, microsecond-scale); clarity over micro-optimization.
- [Review][Dismiss] `toApproxString` truncates rather than rounds — documented as lossy and for human reporting ONLY; never used in any assertion or posting (the invariant is asserted over exact `bigint`).
- [Review][Dismiss] Throwaway TS is outside the root `tsconfig`/`eslint`/`format` globs (so not in those gates) — by design (regime isolation: throwaway is not a prod build dependency). Typecheck is run via the package's own `tsconfig` (`noEmit`); tests ARE in the `pnpm test` gate. No prod build-graph coupling introduced.
- [Review][Dismiss] At the exact boundary `|L·r|=1`, `withinBarrier` is `false` yet `legValues` still returns (short leg = 0) — intentional and documented: the boundary leg is zero (not negative) and the invariant still holds; "within" is the strict open interval.

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-17 · **Outcome:** Approve (1 patch applied; 0 deferred; 4 dismissed — no unresolved High/Med)

Three parallel adversarial layers ran against the 7.1 diff. **Blind Hunter** (diff only) confirmed the issuer-neutral invariant is genuinely exact — leg values are produced by `@rose/shared` `allocate` (the documented "V_A+V_B=K primitive"), so `long+short===K` holds by construction over `bigint`, never via float — and that `parseDecimal` rejects JS `number` (NFR-2). **Edge-Case Hunter** (project access) verified the barrier semantics (zero leg at `|L·r|=1`, RangeError past it), the odd-K residual policy (one leg absorbs the unit, sum stays exact), and the gap-past-floor report; it surfaced the non-positive-`m`/`g` hole — patched (a zero/negative margin or gap would mask the model risk). It also confirmed `pnpm check:regime` stays green: the throwaway→prod relative import is the tolerated direction and `/prod` is never made to depend on `/throwaway`. **Acceptance Auditor** (diff + spec) returned **PASS on AC-1…AC-6**: leg-value math, exact invariant across the within-barrier grid (incl. odd/tiny/1e18 K), no-negative-leg, floor `f=m·L·g` refuse-if-absent, the explicit gap-past-floor key-risk case, and regime isolation; it confirmed scope was held (no simulator/reset/lifecycle — those are 7.2/7.3), no secret/placeholder/default, and no new dependency. After the patch: Vitest 684/684 (+28), forge 171/171 unchanged, `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` green. No residual High/Med correctness risk.
