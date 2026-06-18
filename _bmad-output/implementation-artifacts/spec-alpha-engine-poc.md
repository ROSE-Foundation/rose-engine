---
title: 'Alpha Engine PoC — agent-based emergent-price simulation (@throwaway/alpha-engine)'
type: 'feature'
created: '2026-06-18'
status: 'done'
baseline_commit: '729219d4d2f438d12ebd7c80ecdd285c0a7194ea'
context:
  - '{project-root}/docs/alpha_engine_poc_v1.pdf'
  - '{project-root}/_bmad-output/implementation-artifacts/gap-analysis-alpha-engine-poc-2026-06-18.md'
  - '{project-root}/throwaway/simulator'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Alpha Engine PoC (`docs/alpha_engine_poc_v1.pdf`) — a closed agent-based market where price emerges from a Dutch auction — exists only as a spec. It is a Throwaway/R&D validation of the *intrinsic-time* thesis at the **market** level, and has no implementation.

**Approach:** Build a new THROWAWAY TypeScript package `@throwaway/alpha-engine` (sibling of `@throwaway/simulator`), implementing exactly the spec's v1 scope: 2n long/short agents, Pareto capital, carry-pressure firing, rolling-window order queue, Dutch-auction clearing producing endogenous `p_int`, zero-sum capital transfer, proportional carry drain, and bankruptcy. Emit the section-18 per-tick series as CSV+JSON via a runnable entrypoint.

## Boundaries & Constraints

**Always:**
- THROWAWAY regime: lives under `/throwaway`, never imported by `/prod` (CI guard `tools/check-regime-boundary.mjs`); disjoint from the coupled-coin model and P0.
- Match `@throwaway/simulator` conventions: ESM/NodeNext (`.js` import suffixes), `tsconfig.json` extending `../../tsconfig.base.json` (noEmit), `@throwaway/alpha-engine` name, FR/PoC-referencing header comments, `src/index.ts` re-export surface, vitest `.test.ts`.
- Conserve value per trade: a match moves V EUR long→short and exactly V/`p_int` BTC short→long (zero-sum; the only leak is carry).
- Orders capped at the agent's **home-currency** inventory (long offers EUR, short offers BTC) → balances never go negative.
- Determinism: a seedable PRNG so runs/tests reproduce.

**Ask First:**
- Any departure from the Part VIII default parameters as the shipped defaults.
- Implementing anything from the spec's Part X deferred list.

**Never:**
- External price feed/traders, spread/bid-ask, bilateral yield curves, capital replenishment, risk warehousing, partial pressure reset, power-law `d_i` (all Part X — out).
- No DB, no chain, no network, no `/prod` import. Binary floats are allowed here (Throwaway only; NFR-2 binds `/prod`, not this).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Crossing found | queue with long EUR demand met by short BTC supply at some price | `p_int(t)` = lowest swept price where cumulative short supply (BTC·p) ≥ cumulative long demand (EUR); cleared volume transacts, largest orders first | N/A |
| No crossing | one side empty / no overlap | `p_int(t) = p_int(t-1)`; queue carries forward | N/A |
| Firing | `phi_i ≥ d_i` | place home-currency order sized `K_i/q` (above baseline) or full home balance (all-in, below `K0_min`); reset `phi_i=0` | order capped at inventory |
| Carry drain | each tick, alive agents | home balance `-= c·home`; recompute `K_i`; `total_capital` strictly decreases while agents alive | N/A |
| Bankruptcy | `K_i ≤ epsilon` | agent removed, its queued orders purged | N/A |
| Termination | all agents dead OR `t = T` | loop stops; series returned | N/A |

</frozen-after-approval>

## Code Map

- `throwaway/alpha-engine/package.json` -- `@throwaway/alpha-engine`, typecheck script, PoC/Throwaway description.
- `throwaway/alpha-engine/tsconfig.json` -- extends base, noEmit, includes own `src` + (typecheck-only) sibling refs if needed.
- `throwaway/alpha-engine/README.md` -- what/why, intrinsic-time-at-market-level framing, how to run, Throwaway+disjoint caveat, float-allowed note.
- `throwaway/alpha-engine/src/params.ts` -- `Params` + `DEFAULT_PARAMS` (Part VIII table verbatim).
- `throwaway/alpha-engine/src/rng.ts` -- seedable PRNG (mulberry32) + Pareto sampler.
- `throwaway/alpha-engine/src/agent.ts` -- `Agent` record (id, side, eur, btc, K, K0, phi, d, alive) + helpers (`capital`, regime).
- `throwaway/alpha-engine/src/init.ts` -- Pareto draw, per-side rescale to K/2, balance init (§4), `d_i`, `K0_min`.
- `throwaway/alpha-engine/src/auction.ts` -- queue type, window expiry, Dutch-auction clearing (§10–12) returning `{ price, matchedVolumeEur, fills }`.
- `throwaway/alpha-engine/src/simulation.ts` -- main loop (§16): carry accumulation → firing → expiry → auction → capital update (§13) → carry deduction (§14) → bankruptcy (§15) → record series.
- `throwaway/alpha-engine/src/outputs.ts` -- `SeriesRow`, `toCsv`, `toJson` (§18 series).
- `throwaway/alpha-engine/src/run.ts` -- entrypoint: run defaults, write CSV+JSON under `throwaway/alpha-engine/out/`.
- `throwaway/alpha-engine/src/index.ts` -- re-export public surface.
- `throwaway/alpha-engine/src/{auction,simulation,init}.test.ts` -- vitest.

## Tasks & Acceptance

**Execution:**
- [x] `throwaway/alpha-engine/{package.json,tsconfig.json}` -- scaffold the Throwaway package mirroring `@throwaway/simulator`.
- [x] `src/params.ts` -- encode the Part VIII defaults; derive `x_min=K/(n*10)`, `epsilon=0.01*x_min`.
- [x] `src/rng.ts` -- mulberry32 + `paretoSample(xMin, alpha, u)`.
- [x] `src/agent.ts` + `src/init.ts` -- agent model + Pareto/rescale/balance/threshold initialisation (§3–4, §7).
- [x] `src/auction.ts` -- rolling-window queue + Dutch auction (§10–12) with largest-first fills and partial-fill residuals.
- [x] `src/simulation.ts` -- the §16 loop wiring §6–9, §13–15; returns the §18 series.
- [x] `src/outputs.ts` + `src/run.ts` -- serialize series to CSV/JSON; runnable via `tsx`.
- [x] `src/index.ts` + `README.md` -- public surface + docs.
- [x] `src/{auction,simulation,init}.test.ts` -- cover the I/O matrix + the AC below.

**Acceptance Criteria:**
- Given a queue with overlapping long EUR demand and short BTC supply, when the auction runs, then the clearing price is the two-sided crossing `p_int = D/Btot` (no `max(prev,…)` floor) and cleared EUR-out-of-longs equals EUR-into-shorts (zero-sum).
- Given a queue with one empty side / `Btot=0` / `D=0`, when the auction runs, then `p_int` is unchanged and orders carry forward.
- Given a run where short demand dominates on some ticks and long demand on others, when the sim runs, then `p_int` both **rises and falls** over the run (it is not a monotonic ratchet) — assert at least one strictly-decreasing tick.
- Given two agents with `K0` differing by 4×, when the sim runs, then the larger fires ~4× less often (`d_i ∝ K0_i`).
- Given an agent whose `K_i` falls to ≤ `epsilon`, when the bankruptcy check runs, then it is removed and its queued orders no longer appear in the auction.
- Given an agent holding ≥2 live same-side orders whose total exceeds its home inventory, when the auction fills them, then its home balance never goes negative and aggregate currency is conserved (no creation).
- Given a tick on which **no trade clears** (price unchanged), when the tick completes, then `total_capital(t) < total_capital(t-1)` by exactly the summed carry drained that tick — the carry mechanism strictly drains the pool. (Across trading ticks, EUR-denominated `total_capital` may move either way due to BTC revaluation; the drain invariant is asserted on no-trade ticks, stated explicitly — not silently.)
- Given non-positive `x0`, `xMin`, `alpha`, or `q`, when params are validated at startup, then the run throws a clear error rather than producing NaN/Infinity.
- Given default params, when `tsx src/run.ts` runs, then CSV+JSON files with the five §18 series (including the initial `p_int(0)` row) are written and `pnpm exec vitest run throwaway/alpha-engine` passes.

## Spec Change Log

**2026-06-18 #1 — loopback iteration 2 (bad_spec).**
- **Triggering findings:** acceptance audit F1/F2/F3/F7 + blind/edge HIGH. The original Design-Notes auction reading ("sweep **up** from `p_int(t-1)`", clearing at `max(prev, D/Btot)`) made `p_int` a one-way ratchet → 6 distinct prices in 10k ticks, zero bankruptcies (immortal agents), AC5 violated (test silently restricted to flat-price ticks), liquidity inert. The deliverable could answer **none** of the PoC Part IX questions. Separately, the inventory cap was computed per-order against the full balance → same-side multi-order oversell → negative balance / currency creation.
- **Amended (non-frozen only — frozen intent untouched; the frozen I/O matrix already said "lowest price where supply ≥ demand" = `D/Btot`):** Design Notes now clear at the **two-sided crossing `p_int = D/Btot`** with **no `max(prev,…)` floor** (prev reused only when a side is empty / `Btot=0` / `D=0`); inventory cap must track **remaining** per-agent inventory within the auction. AC block: AC1 reworded to the crossing price; added two-sided-movement AC, multi-order non-negativity AC, no-trade-tick carry-drain AC (replacing the silently-restricted monotone AC5), param-validation AC, and `p_int(0)` emission. Patches folded: param validation (x0/xMin/alpha/q > 0), reset `phi` only when an order is actually placed, sign-pinned test assertion.
- **Known-bad avoided:** a degenerate ratchet model that cannot exhibit oscillation/mortality/liquidity crises; a conservation break under `d_i/c ≤ W`.
- **KEEP (must survive re-derivation):** the package scaffold (package.json/tsconfig mirroring `@throwaway/simulator`, NodeNext `.js` imports, regime compliance — `check:regime` green); `mulberry32` + `paretoSample`; `init.ts` (Pareto draw, per-side rescale to K/2, §4 balance init, `d_i ∝ K0_i`, `k0Min`); `params.ts` Part VIII defaults; home-currency order denomination; largest-first fill with pro-rata allocation and partial-fill residuals; zero-sum trade application; CSV/JSON `outputs.ts`; the vitest harness layout (auction/init/simulation suites). The single `c` serving both pressure (`+c`) and drain (`·home`) stays. Only the auction clearing price, the inventory cap, the `phi` reset condition, param validation, `p_int(0)` emission, and the AC5/sign tests change.

## Design Notes

The spec is loose on order **denomination**; the frozen reading (documented in README): orders are in the agent's **home currency** — a long offers EUR `e_i`, a short offers BTC `b_j` (= EUR order-size `/ p` at firing, capped at `btc_i`). **long demand** `D` (EUR) is price-independent; **short supply** in EUR terms is `Σ b_j·p` (rises with `p`).

**Clearing price = the two-sided crossing, NOT floored at the previous price.** The clearing price is `p_int(t) = D / Btot`, where `Btot = Σ b_j` is total BTC offered — i.e. the price at which short EUR-supply exactly meets long EUR-demand. This is precisely the frozen I/O-matrix's "lowest price where cumulative short supply ≥ cumulative long demand": since supply `Σb·p` is increasing in `p`, the lowest `p` satisfying `Σb·p ≥ D` is `D/Btot`. **Do NOT clamp to `max(prev, …)`** — clamping makes `p_int` a one-way ratchet that defeats the PoC's whole purpose (see Spec Change Log 2026-06-18 #1). The previous price is reused **only** in the genuine no-crossing case: one side empty, `Btot = 0`, or `D = 0`. Both `D` falling (shorts fire more) and rising (longs fire more) must move `p_int` in both directions.

Clearing volume `V = min(D, Btot·p_int)` EUR (with `p_int = D/Btot` this is `V = D`); longs filled largest-first up to `V` EUR (each receives pro-rata `V/p` BTC), shorts filled largest-first up to `V/p` BTC (each receives pro-rata EUR) — aggregate conservation exact, marginal order partially fills, residual stays queued.

**Inventory cap across multiple same-side orders:** an agent may hold >1 live order on its side (when `d_i/c ≤ W`). The fill loop MUST cap each fill against the agent's **remaining** home inventory *as it is decremented within the auction*, never re-against the full starting balance — otherwise an agent oversells and a balance goes negative (currency created from nothing), breaking zero-sum.

The single `c` (=0.001) serves both pressure accumulation (`phi += c`, flat) and capital drain (`-= c·home`, proportional) exactly as the spec's §6 and §14 state.

## Verification

**Commands:**
- `pnpm exec tsc -p throwaway/alpha-engine/tsconfig.json --noEmit` -- expected: typecheck clean.
- `pnpm exec vitest run throwaway/alpha-engine` -- expected: all tests pass.
- `pnpm check:regime` -- expected: no `/prod`→`/throwaway` violation introduced.
- `pnpm exec tsx throwaway/alpha-engine/src/run.ts` -- expected: writes CSV+JSON series under `throwaway/alpha-engine/out/`.

## Suggested Review Order

**Price formation (the heart — start here)**

- Entry point: the Dutch auction producing endogenous `p_int`; read the header contract first.
  [`auction.ts:83`](../../throwaway/alpha-engine/src/auction.ts#L83)
- The load-bearing fix: two-sided crossing `p_int = D/Btot`, **no** `max(prev,…)` ratchet floor.
  [`auction.ts:116`](../../throwaway/alpha-engine/src/auction.ts#L116)
- Remaining-inventory cap across same-side orders — prevents oversell / negative balance / currency creation.
  [`auction.ts:91`](../../throwaway/alpha-engine/src/auction.ts#L91)
- No-crossing branch (one side empty / `Btot=0` / `D=0`) is the only place `prevPrice` is reused.
  [`auction.ts:110`](../../throwaway/alpha-engine/src/auction.ts#L110)

**Simulation loop**

- The §16 tick order: pressure → firing → expiry → auction → carry drain → bankruptcy → record.
  [`simulation.ts:59`](../../throwaway/alpha-engine/src/simulation.ts#L59)
- `phi` resets only when an order is actually placed (spent-out agents keep their pressure).
  [`simulation.ts:117`](../../throwaway/alpha-engine/src/simulation.ts#L117)
- Carry drain (the only non-zero-sum leak) + bankruptcy `K ≤ ε ⇒ dead + purge`.
  [`simulation.ts:142`](../../throwaway/alpha-engine/src/simulation.ts#L142)
- Initial `p_int(0)` row emitted at tick 0.
  [`simulation.ts:72`](../../throwaway/alpha-engine/src/simulation.ts#L72)

**Initialisation & parameters**

- Pareto draw, per-side rescale to K/2, §4 balances, `d_i ∝ K0_i`.
  [`init.ts:31`](../../throwaway/alpha-engine/src/init.ts#L31)
- `validateParams` — fail loud on non-positive `x0`/`xMin`/`alpha`/`q` (no NaN/Infinity).
  [`params.ts:68`](../../throwaway/alpha-engine/src/params.ts#L68)
- Part VIII default parameter table.
  [`params.ts:61`](../../throwaway/alpha-engine/src/params.ts#L61)

**Outputs & entry point (peripherals)**

- §18 series → CSV/JSON serialisation.
  [`outputs.ts:23`](../../throwaway/alpha-engine/src/outputs.ts#L23)
- Default-params runnable entrypoint (writes `out/series.{csv,json}`).
  [`run.ts:21`](../../throwaway/alpha-engine/src/run.ts#L21)

**Tests**

- Auction: crossing `=D/Btot`, price rises AND falls, multi-order non-negativity + conservation, sign-pinned delta.
  [`auction.test.ts:1`](../../throwaway/alpha-engine/src/auction.test.ts#L1)
- Sim: `p_int(0)` row, two-sided movement on defaults, no-trade-tick exact carry drain, param-validation throws, determinism, mortality scenarios.
  [`simulation.test.ts:1`](../../throwaway/alpha-engine/src/simulation.test.ts#L1)
