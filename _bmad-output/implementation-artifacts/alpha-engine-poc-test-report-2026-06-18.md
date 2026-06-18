% Alpha Engine PoC — Test Report
% ROSE Engine · `@throwaway/alpha-engine`
% 2026-06-18

# 1. Executive summary

The Alpha Engine Proof of Concept — a closed, agent-based market simulation whose price emerges from a Dutch auction — was implemented as the THROWAWAY TypeScript package `@throwaway/alpha-engine` and validated through the BMAD quick-dev workflow (plan → implement → adversarial review → spec loopback → re-derive → re-review).

All verification gates pass: the package type-checks cleanly, **21 automated tests pass**, the two-regime boundary guard is green (`/prod` does not import `/throwaway`), and the default-parameter run produces the required Section-18 output series.

The defining outcome of the review was the discovery that the first implementation — although faithful to the approved specification and fully green on tests — produced a **degenerate model**: a one-way "ratchet" price that could only rise. An adversarial acceptance review flagged that the artifact, while spec-correct, could not exhibit any of the emergent behaviour the PoC exists to study. The auction clearing rule was corrected to a two-sided crossing price, after which the model de-degenerated: the price now oscillates in both directions and the capital pool drains as intended.

This report documents the test environment, the verification results, the full test inventory, the behavioural validation evidence, the review-driven correction, and the known limitations.

# 2. Scope and classification

- **Artifact:** `throwaway/alpha-engine/` (TypeScript, ESM/NodeNext).
- **Regime:** THROWAWAY / R&D. The package is deletable with no impact on `/prod`, is not a member of the production pnpm workspace, and `/prod` must never import it. Binary floating-point arithmetic is permitted here (the production exact-arithmetic rule, NFR-2, binds `/prod` only).
- **Relationship to ROSE:** disjoint from the coupled-coin instrument model and from P0. It is positioned as a market-level validation of the *intrinsic-time* thesis, complementary to the instrument-level `@throwaway/simulator`.
- **Source specification:** `docs/alpha_engine_poc_v1.pdf` (The Alpha Engine — POC Specification v1.0).
- **Implementation specification:** `_bmad-output/implementation-artifacts/spec-alpha-engine-poc.md`.

# 3. What was built

The package implements exactly the v1 scope of the source specification:

- A population of `2n` agents (`n` longs, `n` shorts) with Pareto-distributed initial capital; the "lane model" fixes each agent's side for life.
- Carry-cost pressure as an internal clock (`phi_i += c` each tick); an agent fires an order when `phi_i >= d_i`, where the firing threshold `d_i` scales with the agent's initial capital so larger agents fire proportionally less often.
- A two-regime order size: a fractional `K_i / q` above the baseline capital, an all-in order below it (the mortality mechanism).
- A rolling-window order queue (orders live `W` ticks).
- A per-tick Dutch auction that produces the endogenous internal price `p_int`.
- A zero-sum capital transfer at the clearing price, plus a proportional carry deduction (the only non-zero-sum leak — value drained to "the house").
- Bankruptcy removal: an agent whose capital falls to or below `epsilon` is removed and its queued orders are purged; the run ends when all agents are dead or `T` ticks elapse.
- The Section-18 output series (`p_int`, `queue_depth`, `alive_count`, `total_capital`, `matched_volume`) emitted to CSV and JSON via a runnable entry point.

Deferred items from the source spec's Part X (external price feed and traders, spread/bid-ask, bilateral yield curves, capital replenishment, risk warehousing, partial pressure reset, power-law thresholds) are explicitly out of scope and were not built.

# 4. Test environment

- **Runtime:** Node.js (repository targets Node ≥ 24; tests executed under the local toolchain).
- **Language/build:** TypeScript with `tsc` type-checking (`noEmit`), ESM modules.
- **Test runner:** Vitest 4.1.9.
- **Determinism:** all stochastic behaviour is driven by a seedable `mulberry32` PRNG, so runs and tests are fully reproducible.

How to run, from the repository root:

- Type-check: `pnpm exec tsc -p throwaway/alpha-engine/tsconfig.json --noEmit`
- Tests: `pnpm exec vitest run throwaway/alpha-engine`
- Regime guard: `pnpm check:regime`
- Simulation (writes `throwaway/alpha-engine/out/series.{csv,json}`): `pnpm exec tsx throwaway/alpha-engine/src/run.ts`

# 5. Verification results

All four verification commands pass.

| # | Command | Result |
|---|---------|--------|
| 1 | `tsc --noEmit` | PASS — clean, no type errors |
| 2 | `vitest run throwaway/alpha-engine` | PASS — 21/21 tests, 3 files |
| 3 | `pnpm check:regime` | PASS — `/prod` has no imports from `/throwaway` |
| 4 | `tsx src/run.ts` | PASS — writes `out/series.{csv,json}` (10,000 ticks) |

# 6. Test inventory

21 tests across three suites. Each test and the property it validates is listed below.

## 6.1 Initialisation — `init.test.ts` (4 tests)

- Creates `2n` agents (`n` per side).
- Rescales each side to sum to exactly `K/2` in EUR terms.
- Opens balances so that `eur + btc·x0 = K0` (longs EUR-heavy, shorts BTC-heavy).
- Scales the firing threshold with capital: `d_i ∝ K0_i`, so larger agents fire proportionally rarer.

## 6.2 Dutch auction — `auction.test.ts` (7 tests)

Crossing found:

- Clears at the two-sided crossing `p_int = D/Btot` with an exact zero-sum transfer.
- Price RISES above the previous price when long demand dominates (`D = 2·Btot` ⇒ `p = 2`).
- Price FALLS below the previous price when short supply dominates (`p = 0.5`) — confirming there is no ratchet floor.
- Caps a single offer at the agent's current home inventory (balances cannot go negative).
- Caps two or more same-side orders against REMAINING inventory: the agent never oversells and never goes negative.

No crossing:

- One empty side ⇒ price holds at the previous value and there are no fills.
- Orders from dead agents are ignored (purged-order behaviour).

## 6.3 Simulation loop — `simulation.test.ts` (10 tests)

Default-params dynamics:

- Emits the initial `p_int(0)` row at tick 0, with `total_capital = K` and no trade.
- `p_int` both RISES and FALLS over the run (two-sided crossing, not a ratchet).
- The carry mechanism drains the pool over the run (`total_capital` strictly falls end to end).
- Deterministic: the same seed yields an identical series.

No-trade tick carry drain:

- On a tick where no trade clears, `total_capital` drops by exactly the summed carry — isolating the carry mechanism from price revaluation.

Bankruptcy removal and termination:

- Removes agents whose capital `K ≤ epsilon` and terminates when all are dead.
- Alive count is monotone non-increasing (no resurrection).

Partial mortality with a live order queue:

- Queues orders, removes agents that hit `epsilon`, and never resurrects them.

Parameter validation:

- Throws on non-positive `x0`, `xMin`, `alpha`, or `q`.
- Accepts the shipped defaults without throwing.

# 7. Behavioural validation (default-parameter run)

The default run uses the source spec's Part VIII parameters (`n=50`, `K=1,000,000`, `x0=1.0`, `alpha=1.5`, `x_min=K/(n·10)`, `f=0.9`, `c=0.001`, `d_base=1.0`, `q=16`, `W=5`, `epsilon=0.01·x_min`, `T=10,000`), seed `12345`.

The table below contrasts the first (degenerate) implementation with the corrected two-sided auction.

| Metric (10,000 ticks) | First implementation (ratchet) | Corrected (two-sided crossing) |
|---|---|---|
| Distinct `p_int` values | 6 | 25 |
| Strictly-decreasing price ticks | 0 (price never fell) | 12 (12 rises, 12 falls) |
| `p_int` range | monotone up | 0.800 – 4.497 |
| `total_capital` (carry drain) | drained | 1,000,000 → ~119,645 |
| Zero-sum conservation per trade | held | held (Σ ΔEUR = 0, Σ ΔBTC = 0) |

Conservation was verified analytically and by test: at the clearing price `p = D/Btot`, longs surrender `D` EUR and receive `D/p = Btot` BTC; shorts surrender `Btot` BTC and receive `Btot·p = D` EUR. Net EUR change and net BTC change across the matched set are both exactly zero. The only non-zero-sum flow is the carry deduction, which monotonically drains the pool — confirmed by the no-trade-tick test (exact carry equality) and by the end-to-end drain figure above.

# 8. Review-driven correction

The implementation was reviewed by three independent adversarial reviewers without conversation context (a blind correctness hunter, an edge-case hunter, and an acceptance auditor). Their findings drove one specification-level loopback and a set of patches.

**Specification-level defect (corrected):** the original auction reading clamped the clearing price with a `max(previous, …)` floor (seeded by the source spec's literal "sweep upward from the previous price" wording). This made `p_int` a one-way ratchet, which in turn made agents effectively immortal (upward revaluation) and rendered the Section-19 study questions — price oscillation, liquidity crises, mortality — unanswerable. The fix clears at the unfloored two-sided crossing `p_int = D/Btot`, which is precisely the frozen requirement ("the lowest price at which short supply meets long demand") and reuses the previous price only in the genuine no-crossing case.

**Correctness patches (corrected):**

- A conservation bug whereby an agent holding two or more live same-side orders had each offer capped against its full balance rather than its remaining balance — allowing oversell, a negative balance, and currency creation. Fixed by tracking each agent's remaining inventory within the auction.
- Carry pressure (`phi`) was reset even when no order was placed (a spent-out agent silently lost its accumulated pressure). Fixed to reset only on an actual order.
- Missing parameter validation that allowed non-positive inputs to poison the run with NaN/Infinity. Fixed with a fail-loud `validateParams`.
- The initial `p_int(0)` row was not emitted in the output series. Fixed.
- A one-sided test assertion was strengthened to pin the sign of the cleared amount.

After re-derivation, all four verification gates pass and the model is no longer degenerate (Section 7).

# 9. Coverage against the source specification

| Source spec part | Implemented | Tested |
|---|---|---|
| §3–4 Agent structure & initial capital | Yes | Yes (init suite) |
| §5 Lane model | Yes | Yes (via init/sides) |
| §6 Carry pressure | Yes | Yes (sim) |
| §7 Firing threshold scales with capital | Yes | Yes (init: `d_i ∝ K0_i`) |
| §8 Firing and reset | Yes | Yes (sim; reset-only-on-order) |
| §9 Order size two-regime | Yes | Indirect (sim/mortality) |
| §10 Rolling-window queue | Yes | Yes (auction/no-crossing) |
| §11–12 Dutch auction & price formation | Yes (two-sided crossing) | Yes (auction suite) |
| §13 Zero-sum capital update | Yes | Yes (conservation) |
| §14 Carry deduction | Yes | Yes (no-trade drain) |
| §15 Bankruptcy & death | Yes | Yes (sim mortality) |
| §16 Main loop | Yes | Yes (sim dynamics) |
| §18 Required outputs | Yes (CSV+JSON) | Yes (`p_int(0)` row) |
| §19 "What we are looking for" | Partially (see §10) | Price dynamics: yes; mortality: scenario-only |

# 10. Known limitations and deferred work

All items below are recorded in `deferred-work.md`; none block the deliverable.

- **No bankruptcies at default parameters.** After the auction fix the price de-degenerated and the pool drains, but no agent reaches `epsilon` within 10,000 ticks at `c=0.001, f=0.9`. The Section-19 mortality questions ("do small agents die first?") therefore require a parameter sweep (higher carry, lower home fraction, longer horizon). The mortality logic itself is correct and is exercised by dedicated partial-mortality and forced-death test configurations.
- **Full-clear consequence.** At the crossing price `p = D/Btot` both sides clear entirely on each trading tick, so the largest-first / partial-fill / residual machinery is exercised only on one-sided (no-crossing) carry-forward. This is correct but means `queue_depth` mostly reflects one-sided accumulation.
- **Minor cosmetics.** `queue_depth` counts a partially-filled order's residual size; an `n=0` configuration would mislabel as "all-dead". Both are harmless at the shipped defaults.
- **No web interface.** The PoC is a CLI/Throwaway artifact that emits CSV/JSON; it is intentionally not wired into the ROSE web surfaces (the regime boundary forbids `/prod`, including the web app, from importing `/throwaway`).

# 11. Conclusion

The Alpha Engine PoC is implemented, fully type-checked, regime-compliant, and covered by 21 passing tests spanning initialisation, the Dutch auction (including the corrected two-sided price formation and inventory-conservation invariants), the simulation loop, carry drain, bankruptcy, and parameter validation. The adversarial review caught and corrected a degenerate price model that the tests alone would not have surfaced. The corrected model exhibits the two-sided, oscillating, pool-draining behaviour the PoC was built to study, with agent mortality available under appropriate parameters. The artifact is ready for exploratory parameter studies as a Throwaway R&D tool, disjoint from ROSE P0.
