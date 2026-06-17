---
baseline_commit: 89b15b61a546e9776f5525ea2fe476ba53a5b94c
---

# Story 7.2: Simulate threshold-only rebalancing over historical ticks

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an analyst,
I want a **throwaway** simulator that replays historical ticks (CSV `timestamp,price`) and rebalances (resets) a coupled pair **only** when a losing leg breaches the floor `f`,
so that resets are **event-driven (intrinsic time)** — never clock/interval-driven — avoiding the leveraged-ETF volatility-decay trap that clock-based rebalancing would import (FR-16).

## Acceptance Criteria

1. **Tick replay from CSV (`timestamp,price`).** The simulator ingests ticks in the format `timestamp,price` (one tick per line, decimal-string prices — never JS `number`, NFR-2). A header row, blank lines, and `#` comment lines are tolerated/skipped. Both a EUR/USD and a BTC tick fixture exist (`throwaway/simulator/fixtures/`) and replay at `L = 1`.
2. **Threshold-only reset — fires only on a floor breach.** Replaying the ticks, a reset fires **only** when the **losing** leg's remaining buffer (`1 − |L·r|`) drops to/below the floor `f = m·L·g` (reusing `@throwaway/coupled-math` `floorBreached`/`evaluate`). The reset decision **never** consults the timestamp or any elapsed-time/interval signal.
3. **Never reset on a time interval (the key consequence).** Given a tick set where the price stays within the floor buffer, **zero** resets fire regardless of how much wall-clock time the timestamps span (including a long, flat series and identical price series with arbitrarily different timestamps). EUR/USD at `L = 1` (barrier ~100% away, floor far) ⇒ near-zero resets with a plausible floor; BTC (higher-vol stress of the **same** invariant) ⇒ at least one reset when the configured floor is crossed.
4. **Reset event — lock, re-anchor, lock loss.** When a reset fires it records a reset event capturing: (a) the **current dollar values are locked** (the integer leg values at the breaching price, via `@throwaway/coupled-math` `legValues`/`evaluate`); (b) **P₀ re-anchors** to the current (breaching) price; (c) the **losing holder's loss is locked** (`lockedLoss = K/2 − lockedLosingLegValue`, where each leg started the neutral cycle at `K/2`); and the losing leg is identified (`long` when `L·r < 0`, `short` when `L·r > 0`).
5. **Re-base to a fresh neutral cycle (D1a).** After a reset the pair re-bases symmetrically to the residual pool at the new anchor (a fresh `K/2 : K/2` split at the new P₀, no carried P&L), so subsequent ticks are evaluated against the **new** anchor. (Per D1a RESOLVED: crystallised & withdrawable, then symmetric re-base.)
6. **Two example tick sets — crossed and not-crossed.** Tests include (a) a tick set where the floor is **not** crossed ⇒ `resets.length === 0`, and (b) a tick set where the floor **is** crossed ⇒ a reset at exactly the breaching tick with the correct new anchor and locked loss.
7. **Regime.** All new code lives under `/throwaway` (`throwaway/simulator/`). `/throwaway` may import `/prod` and `@throwaway/coupled-math`; `/prod` must **never** import `/throwaway` (`pnpm check:regime` stays green). The simulator package is **not** a pnpm-workspace member (regime defense) and not part of the `/prod` build graph.

### Scope boundary (P0, this story only)

- **IN:** the threshold-only rebalancing **simulator** — CSV `timestamp,price` ingestion, tick replay against `@throwaway/coupled-math`, floor-breach-only reset firing (never clock/interval), the reset event (lock current values + re-anchor P₀ + lock losing-holder loss + symmetric re-base), and EUR/USD + BTC fixtures with crossed / not-crossed tests.
- **OUT (Story 7.3):** the **formal no-negative-leg proof** + gap-breach (issuer-neutrality break) reporting over a full tick set; **journal-every-reset** as the audit artifact (price, locked values, new anchor) consumed as evidence; the **full pair lifecycle traversal** (`PENDING → … → CLOSED`); the stated, defensible **method for choosing `m`/`g` before observing the reset rate** (SM-C1 falsifiability). 7.2 produces the reset *events*; 7.3 turns them into the *proof + journal + lifecycle*.
- **OUT:** any change under `/prod` source other than the root `vitest.config.ts` include (already covers `throwaway/**/*.test.ts` from 7.1 — likely **no** change needed). No DB, no auth, no network, no real feed — pure in-memory replay of CSV fixtures.

## Tasks / Subtasks

- [x] Task 1 — Stand up the throwaway `simulator` package (AC: #1, #7)
  - [x] Create `throwaway/simulator/` with `package.json` (`@throwaway/simulator`; private; **NOT** a pnpm-workspace member — preserves the regime defense; mirror `@throwaway/coupled-math`'s package.json shape, `main: ./src/index.ts`, `typecheck` script), `tsconfig.json` (typecheck-only, `noEmit`, extends base; `include` the simulator `src` + the cross-regime sources it imports), `src/`, `fixtures/`, `README.md`.
  - [x] Reuse `@throwaway/coupled-math` via relative import (`../../coupled-math/src/index.js`) — both are throwaway, so this is intra-throwaway; do **not** copy/re-implement the math. `@rose/shared` `splitInTwo` imported via `../../../prod/packages/shared/src/money.js` (tolerated `/throwaway → /prod`) for the exact neutral K/2 baseline.
- [x] Task 2 — CSV tick ingestion (AC: #1)
  - [x] `parseTicks(csv: string): Tick[]` where `Tick = { timestamp: string; price: string }`. Skips blanks, `#` comments, and an optional header (first content line whose price field is not a positive decimal). Each `price` validated as a strictly-positive decimal string (rejects JS `number` / non-decimal / NaN / negative / zero — NFR-2). Order preserved; malformed lines fail loud.
  - [x] `loadTicksFromFile(path: string): Tick[]` (thin `readFileSync` + `parseTicks`) for the fixtures.
- [x] Task 3 — Threshold-only replay engine (AC: #2, #3, #4, #5)
  - [x] `simulate(ticks, config): SimResult` where `config = { initialAnchorPrice, leverage, collateralPool /* K */, floorParams }`.
  - [x] For each tick (in order): evaluate against the **current** anchor using `@throwaway/coupled-math` `evaluate(...)`. Fire a reset **iff** `floorBreached`. The reset condition reads **price only** — `tick.timestamp` is never passed to the decision.
  - [x] On reset, build a `ResetEvent`: lock current legs (`evaluate(...).legs`; if `legs === null` clamp losing leg to `0`, winner to `K`, set `gapPastFloor = true`); identify the losing leg (`L·r ≥ 0 ⇒ short`, `< 0 ⇒ long`); compute `lockedLoss = neutralLosingLeg − lockedLosingLegValue`; set `newAnchorPrice = tick.price`.
  - [x] Re-anchor: set current anchor `= tick.price`; the fresh symmetric `K/2 : K/2` re-base is implicit (r = 0 at the new anchor ⇒ next `evaluate` yields the neutral legs).
  - [x] Return `{ resets, ticksProcessed, finalAnchorPrice }`.
- [x] Task 4 — Fixtures: EUR/USD + BTC (AC: #1, #3, #6)
  - [x] `fixtures/eurusd.csv` — EUR/USD ticks staying within a plausible floor at `L = 1` ⇒ **zero** resets.
  - [x] `fixtures/btc.csv` — BTC ticks with a ~73% bear-market drawdown crossing the same floor at `L = 1` ⇒ **1** reset.
- [x] Task 5 — Tests (consequences testable) (AC: #2, #3, #4, #6)
  - [x] **No clock resets:** flat series spanning years ⇒ `0` resets; identical prices under 1-second vs 600-year timestamp spreads ⇒ **identical** resets (engine ignores time).
  - [x] **Threshold crossed:** breach at the exact breaching tick; `newAnchorPrice` = breaching price, locked legs sum to K, losing leg correct, `lockedLoss = neutral K/2 − lockedLosingLegValue` (exact bigint).
  - [x] **Re-base after reset:** the repeated post-reset tick does **not** re-fire; a later breach vs the **new** anchor fires a second reset.
  - [x] **Fixtures:** EUR/USD ⇒ `0`; BTC ⇒ `≥ 1` (losing long, anchorBefore 60000, breach at 16000).
  - [x] **Floor refuse-if-absent passthrough:** `loadFloorParams({})` throws (reuses 7.1, no defaulting).
- [x] Task 6 — Wire into the gate & validate (AC: #7)
  - [x] Root `vitest.config.ts` already matches `throwaway/**/*.test.ts` (added in 7.1) — **no** config change; the new tests run under `pnpm test`.
  - [x] Full gate green; `pnpm check:regime` stays green (`/prod` ↮ `/throwaway`); `pnpm exec tsc -p throwaway/simulator/tsconfig.json --noEmit` clean.

## Dev Notes

### Reuse from Story 7.1 — `@throwaway/coupled-math` (DO NOT re-implement)

The reference math is **done** and is the simulator's engine. Consume these exact exports (from `throwaway/coupled-math/src/index.ts`):

- `evaluate(params, price, floorParams) → Evaluation` — one-shot report: `{ r, leveragedDeviation, withinBarrier, barrierCrossed, legWouldBeNegative, legs, invariantHolds, buffer, floor, floorBreached }`. **This is the per-tick call.** `floorBreached` is the **only** reset trigger.
- `legValues(params, price) → { long, short }` — exact integer split (`long + short === K`); throws `RangeError` when `|L·r| > 1`. Prefer `evaluate(...).legs` (it returns `null` instead of throwing past the barrier — handle the gap case from there).
- `floorBreached(price, { anchorPrice, leverage }, floorParams)` — buffer `1 − |L·r| ≤ f`.
- `floor(leverage, floorParams)`, `buffer(price, anchorPrice, leverage)`, `withinBarrier(...)`.
- `loadFloorParams(env) → FloorParams` / `FloorParamRefusalError` — refuse-if-absent, strictly-positive `m`/`g` (never defaults). `FloorParams = { m: string; g: string }`.
- `PairParams = { anchorPrice: string; leverage: string; collateralPool: bigint }`; `Rational` core (`parseDecimal`, `cmp`, `mul`, ...) for any local decimal logic.

[Source: throwaway/coupled-math/src/coupled-math.ts; throwaway/coupled-math/src/floor-params.ts; throwaway/coupled-math/src/index.ts; 7-1 Completion Notes "Interfaces for 7.2/7.3"]

### Math & model semantics (addendum §D — follow exactly)

- `r = (P − P₀)/P₀`; `V_A = (K/2)(1 + L·r)` (long); `V_B = (K/2)(1 − L·r)` (short); invariant `V_A + V_B = K` ⇒ issuer net = 0 (SM-2). At the start of each neutral cycle (issuance and after every reset) the split is symmetric `K/2 : K/2` (P = P₀ ⇒ r = 0). [Source: _bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md#D]
- **Losing leg:** `L·r > 0` ⇒ price up ⇒ **short** is the losing (shrinking) leg; `L·r < 0` ⇒ price down ⇒ **long** is losing. The floor protects the **losing** leg; `floorBreached` already keys off `1 − |L·r|` (the losing-leg buffer), so direction does not change the trigger, only which holder's loss is locked.
- **Barrier vs floor:** a leg reaches zero at `|L·r| = 1` (barrier ~100% away at `L = 1`). The floor `f = m·L·g` fires the reset **before** the barrier (buffer `1 − |L·r| ≤ f`). A single **gap past the floor** that also crosses the barrier (`|L·r| ≥ 1`) is the issuer-neutrality-break condition — 7.2 records it (clamp + `gapPastFloor` flag); 7.3 formally proves/reports it. [Source: addendum.md#D; epics.md#Story 7.2/7.3]
- **Why threshold-only, never a clock (the whole point of FR-16):** clock/interval rebalancing of a leveraged position imports leveraged-ETF **volatility decay** ("intrinsic time" trap). Resets must be **event-driven on a floor breach only**. The engine must therefore never branch on `timestamp`, elapsed time, tick index cadence, or any interval. [Source: epics.md#Story 7.2 "event-driven (intrinsic time), never clock-driven"; architecture.md:43]

### D1 / D1a (reset settlement — RESOLVED, the model for the reset event)

- D1 RESOLVED: separate L/S, directional; the **losing-leg holder bears the locked loss**, the winning-leg holder is the counterparty funded from pool K. D1a RESOLVED: **crystallised & withdrawable** — each reset realizes the winner's gain (withdrawable) and settles the loser's loss, then both legs **re-base to a fresh symmetric split** of the residual pool (new neutral cycle, no carried P&L). For 7.2 the simulator **records** the lock + re-anchor + locked loss and re-bases symmetrically; the balanced settlement **journal entry / cash movement** as an auditable artifact is 7.3 (journal-every-reset). [Source: architecture.md:74, :395]

### Exact-arithmetic policy (reuse, never float)

- Prices/leverage/`m`/`g` are decimal **strings**; leg values and K are smallest-unit `bigint`. Never `Number()`/`parseFloat` on any money/price path. The locked values, `lockedLoss`, and the `K/2` neutral split are `bigint` (use `@throwaway/coupled-math` `legValues`/`allocate`-backed splits; for `K/2` use the same exact split, e.g. `legValues(params, anchorPrice)` at `r = 0` or an exact halve with deterministic residual). Assertions on values are over exact `bigint`. [Source: 7-1 Dev Notes "Exact-arithmetic policy"; prod/packages/shared/src/money.ts]

### Regime notes (mirror 7.1 exactly)

- `/throwaway` is deliberately **not** a pnpm-workspace member ("first line of regime-boundary defense"). So neither `@throwaway/coupled-math` nor `@rose/shared` resolves by package name from the simulator — import coupled-math by relative path (`../../coupled-math/src/index.js`) and (if needed) `@rose/shared` via `../../../prod/packages/shared/src/...js`. The regime guard scans only `/prod` and tolerates `/throwaway → /prod`. [Source: tools/check-regime-boundary.mjs; pnpm-workspace.yaml; 7-1 Dev Notes "Regime notes"]
- Root `tsconfig.json` references `/prod` packages only — do **not** add the simulator to the prod build graph. Typecheck via the package's own `tsconfig.json` (`noEmit`). [Source: tsconfig.json; throwaway/coupled-math/tsconfig.json]
- Root `vitest.config.ts` already includes `throwaway/**/*.test.ts` (added in 7.1) and excludes only `node_modules`/`dist`/`prod/contracts` — so the new simulator tests are picked up by `pnpm test` with no config change expected. [Source: vitest.config.ts]

### Testing standards summary

- Vitest, hermetic, in-memory. Tests co-located as `*.test.ts` under `throwaway/simulator/src/`. Use inline CSV strings for engine/parser logic; read the two fixtures via `loadTicksFromFile` for the EUR/USD-zero / BTC-≥1 assertions.
- The **threshold-only** guarantee is proven by consequence: (1) flat/within-buffer long series ⇒ `0` resets; (2) identical price series with different timestamp columns ⇒ identical resets (engine ignores time). Assert reset values over exact `bigint`.

### Project Structure Notes

- New: `throwaway/simulator/` with `src/` and `fixtures/` — exactly the architecture tree ("`simulator/` FR-16, FR-17 — threshold-only rebalancing; `fixtures/` EUR/USD + BTC tick CSVs (timestamp,price)"). [Source: architecture.md:329-332, :359]
- Modified: expected **none** under `/prod`. (`vitest.config.ts` already wired in 7.1; only touch it if the new tests are somehow not collected.)

### Anti-patterns to avoid (disaster prevention)

- **Any** clock/interval/elapsed-time branch in the reset decision (defeats FR-16 — the single most important constraint here). Float money/price math. Re-implementing the coupled-math (reuse `@throwaway/coupled-math`). Defaulting an absent `m`/`g` to 0 (use `loadFloorParams` — it refuses). Hard-coding `L` (read from `config.leverage`). `/prod` importing `/throwaway`; making the simulator a pnpm-workspace/prod build dependency. Doing 7.3 work here: the **formal** no-negative-leg proof, journal-every-reset audit artifact, full lifecycle (`PENDING → … → CLOSED`), or the `m`/`g`-selection method.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 7.2 / #Story 7.3]
- [Source: _bmad-output/planning-artifacts/architecture.md:43, :329-332, :359, :74, :395-396]
- [Source: _bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md#D]
- [Source: throwaway/coupled-math/src/coupled-math.ts; floor-params.ts; index.ts (7.1 — done)]
- [Source: _bmad-output/implementation-artifacts/7-1-implement-the-coupled-coin-reference-math-with-the-issuer-neutral-invariant.md (Completion Notes / Interfaces for 7.2/7.3)]
- [Source: tools/check-regime-boundary.mjs; pnpm-workspace.yaml; vitest.config.ts; tsconfig.json]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `pnpm exec tsc -p throwaway/simulator/tsconfig.json --noEmit` → clean (after fixing two relative-import depths: coupled-math is `../../coupled-math/src/index.js` from `src/`, and `FloorParams`/`loadFloorParams` are pulled from coupled-math, not re-exported by the simulator index).
- `pnpm exec vitest run throwaway/simulator` → 17/17 (2 files).
- Full gate: `pnpm test` 684 → **701** (+17); `pnpm typecheck` (tsc -b) clean; `pnpm lint` clean; `pnpm format:check` clean; `pnpm check:regime` ✅ (`/prod` has no imports from `/throwaway`); `pnpm check:migrations` reversibility OK. No Solidity touched ⇒ `forge test` unchanged (171).

### Completion Notes List

- **AC-1 (CSV `timestamp,price` replay):** `parseTicks`/`loadTicksFromFile` ingest `timestamp,price` (decimal-string prices — never JS `number`, NFR-2), tolerating a header row, blank lines, and `#` comments; a malformed or non-positive-decimal price after the header fails loud (a tick is never silently dropped). EUR/USD + BTC fixtures replay at `L = 1`.
- **AC-2 (threshold-only reset):** `simulate` fires a reset **iff** `@throwaway/coupled-math` `evaluate(...).floorBreached` (buffer `1 − |L·r| ≤ f = m·L·g`). The decision passes **only** `tick.price` into `evaluate` — `tick.timestamp` is never read by it.
- **AC-3 (NEVER on a time interval — the FR-16 invariant):** proven by consequence — (a) a flat series across timestamps spanning 2000→2099 fires `0` resets; (b) the same price series under 1-second vs 600-year timestamp spreads yields **identical** resets (all reset *drivers* equal; only the reporting-only `timestamp` differs). EUR/USD fixture ⇒ `0` resets under a plausible floor; BTC fixture ⇒ `1` reset (higher-vol stress of the same invariant).
- **AC-4 (lock + re-anchor + lock loss):** each `ResetEvent` locks the exact integer legs at the breaching price (`lockedLong + lockedShort === K`), re-anchors `newAnchorPrice = breaching price`, identifies the losing leg (`L·r > 0 ⇒ short`, `< 0 ⇒ long`), and locks `lockedLoss = neutralLosingLeg(K/2) − lockedLosingLegValue` — all exact `bigint`. Worked example asserted: P₀=100, K=1000, f=0.05, P=196 → short losing, legs {980, 20}, lockedLoss 480, new anchor 196.
- **AC-5 (re-base to a fresh neutral cycle, D1a):** after a reset the anchor moves to the breaching price; the symmetric `K/2 : K/2` re-base is implicit (r = 0 at the new anchor). Tested: a repeated tick immediately after a reset does **not** re-fire, and a later move vs the **new** anchor fires a second reset (`anchorBefore` = the post-reset anchor).
- **AC-6 (crossed / not-crossed):** not-crossed inline set ⇒ `resets === []` (anchor unmoved); crossed set ⇒ reset at the exact breaching tick. BTC fixture crosses; EUR/USD fixture does not — under the **same** floor.
- **AC-7 (regime):** all code under `throwaway/simulator/`. The package is **not** a pnpm-workspace member; it reuses `@throwaway/coupled-math` (intra-throwaway) and `@rose/shared` `splitInTwo` via the tolerated `/throwaway → /prod` relative import. `pnpm check:regime` green; no `/prod` source changed; root `vitest.config.ts` already wired the throwaway glob in 7.1 (no change).
- **Gap-past-floor (recorded, not proven):** a single jump past the barrier (P=250 ⇒ `legs === null`) is recorded with `gapPastFloor = true` and the losing leg clamped to 0 (`lockedLoss = K/2`). The **formal** no-negative-leg proof + issuer-neutrality-break reporting, journal-every-reset, and full lifecycle traversal are deliberately **out of scope** here — they are Story 7.3.
- **Scope held:** the threshold-only SIMULATOR + tick replay only. No formal proof / journal-as-audit-artifact / lifecycle / `m`-`g` selection method (all 7.3). No DB, auth, or network — pure in-memory replay of CSV fixtures.
- **No new dependency, no secret, no placeholder.** Reuses existing `@throwaway/coupled-math`, `@rose/shared`, `vitest`, `typescript`, and Node stdlib (`node:fs`, `node:url`).
- **Interfaces for 7.3:** `simulate(ticks, config) → SimResult`, the `ResetEvent` shape (`tickIndex`, `timestamp`, `price`, `anchorBefore`, `losingLeg`, `lockedLong/Short`, `lockedLoss`, `newAnchorPrice`, `gapPastFloor`), `parseTicks`/`loadTicksFromFile`, and the fixtures — these are exactly the inputs 7.3 turns into the journal-every-reset audit artifact, the no-negative-leg/gap-breach proof, and the full lifecycle traversal.

### File List

**New — `throwaway/simulator/`:**

- `package.json` (`@throwaway/simulator`; private; NOT a pnpm-workspace member; no new deps)
- `tsconfig.json` (typecheck-only, `noEmit`, extends base; includes coupled-math src + `@rose/shared` money source for cross-package typecheck)
- `README.md`
- `src/index.ts` (public surface re-exports)
- `src/ticks.ts` (`Tick`, `parseTicks`, `loadTicksFromFile` — CSV `timestamp,price` ingestion, header/blank/comment tolerant, strictly-positive-decimal prices)
- `src/ticks.test.ts` (8 tests)
- `src/simulator.ts` (`simulate`, `SimConfig`, `SimResult`, `ResetEvent`, `LosingLeg` — threshold-only replay; reset price-only, never on a clock)
- `src/simulator.test.ts` (9 tests)
- `fixtures/eurusd.csv` (EUR/USD ticks ⇒ 0 resets at L=1)
- `fixtures/btc.csv` (BTC ticks ⇒ 1 reset at L=1)

Total: 17 throwaway tests (8 + 9).

**Modified:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (7-2 backlog → ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/7-2-...md` (this story: frontmatter `baseline_commit`, tasks, Dev Agent Record, status)

## Change Log

| Date       | Version | Description                                                                                                                                                                                                                                                                                              | Author |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-17 | 0.1     | Story drafted (create-story), ready-for-dev                                                                                                                                                                                                                                                             | Amelia |
| 2026-06-17 | 0.2     | Implemented `@throwaway/simulator` — CSV `timestamp,price` ingestion + threshold-only replay reusing `@throwaway/coupled-math`. Resets fire ONLY on a floor breach (price-only decision), never on a clock; each reset locks values, re-anchors P₀, locks the losing-holder loss, and re-bases symmetric. EUR/USD fixture ⇒ 0 resets, BTC ⇒ 1. Vitest 684 → 701 (+17); full gate green; status → review | Amelia |
| 2026-06-17 | 0.3     | Code review (3 adversarial layers). 2 patches applied (parseTicks now fails loud on a malformed FIRST data row instead of swallowing it as a header; `simulate` refuses a degenerate floor f = m·L·g ≥ 1 that would fire phantom resets at r = 0) + 1 doc fix (`gapPastFloor` is `>1`, not `≥1`); +2 tests. 2 dismissed. Vitest 701 → 703; forge 171 unchanged; full gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] `parseTicks` silently dropped a malformed FIRST data row (swallowed as a "header") [throwaway/simulator/src/ticks.ts] — flagged by Blind Hunter + Edge Case Hunter (Med). The header heuristic treated any first content line with a non-decimal price as a header, so a header-less file whose first row had a digit-bearing corrupt price (`-5`, `0`, `1.2.3`, `1,000`) was dropped instead of throwing — contradicting the module's own "fail loud" contract. Fix: a header is tolerated only when the price column is a non-numeric label (no digits); a first row with digits that fails strict positive-decimal validation now throws. New test covers all four corruption shapes + the still-tolerated `timestamp,price` header.
- [x] [Review][Patch] `simulate` fired phantom resets (and mislabeled the losing leg) when floor f = m·L·g ≥ 1 [throwaway/simulator/src/simulator.ts] — flagged by Edge Case Hunter + Blind Hunter (Med). With f ≥ 1 (reachable at high L or g = 1), buffer `1 − |L·r| ≤ 1 ≤ f` breaches on EVERY tick including the neutral point r = 0 (no leg actually losing), and the `cmp(L·r, 0) >= 0` tiebreak arbitrarily labels `short` — corrupting the falsifiability-critical reset-rate metric (SM-C1). Fix: refuse f ≥ 1 up front (`RangeError`, fail-closed) — which also makes the r = 0 tiebreak genuinely unreachable. New test asserts the refusal.
- [x] [Review][Patch] `gapPastFloor` doc said `|L·r| ≥ 1` but the flag fires only at `|L·r| > 1` (legs `null`) [throwaway/simulator/src/simulator.ts] — Edge Case Hunter (Low, comment-vs-behavior). At exactly `|L·r| = 1` the losing leg is 0, legs exist, and the flag is correctly false. Doc comment corrected.
- [Review][Dismiss] Acceptance Auditor: `ResetEvent.leveragedDeviationApprox` is an extra field beyond the spec's "Interfaces for 7.3" list — it is explicitly documented in code as lossy, human-reporting-only, and never asserted; harmless, no AC violation.
- [Review][Dismiss] Blind Hunter: `price = line.slice(comma + 1)` captures everything after the first comma, so an extra-column row (`ts,1.08,extra`) is rejected with an "invalid price" error — acceptable strictness (malformed multi-column rows fail loud; after the first-row patch this is now consistent across all rows).

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-17 · **Outcome:** Approve (3 patches applied incl. 1 doc; 0 deferred; 2 dismissed — no unresolved High/Med)

Three parallel adversarial layers ran against the 7.2 diff (~491 new lines under `throwaway/simulator/`). **Blind Hunter** (diff only) confirmed the core is sound: the reset decision never reads `tick.timestamp` (the sole gate is `floorBreached` derived from `buffer = 1 − |L·r|`), the losing-leg sign mapping matches `V_A=(K/2)(1+L·r)` / `V_B=(K/2)(1−L·r)`, the gap-past-barrier clamp + `lockedLoss` are conservation-consistent and exact for odd K (`splitInTwo` residual cancels), and no binary float touches any decision path. **Edge-Case Hunter** (project access) verified time/clock independence, the gap clamp, regime isolation (`/throwaway` not a workspace member; no `/prod` import of `/throwaway`; tolerated `/throwaway → /prod` relative imports), and surfaced the two Med holes — the f ≥ 1 phantom-reset and the malformed-first-row swallow — both patched. **Acceptance Auditor** (diff + spec) returned **PASS on AC-1…AC-7** (CSV replay; threshold-only reset; never-on-a-clock proven by the flat-series-0-resets + timestamp-invariance tests; lock/re-anchor/lock-loss; symmetric re-base; crossed/not-crossed sets; regime) and confirmed **no Story 7.3 leakage** (no formal proof, no journal-as-audit-artifact, no lifecycle, no m/g-selection method — only deferral comments) and no new dependency / secret / placeholder. After the patches: Vitest 701 → **703** (+2), forge 171 unchanged, `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` green. No residual High/Med risk.
