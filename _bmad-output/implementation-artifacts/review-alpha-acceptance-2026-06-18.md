# Acceptance Audit — Alpha Engine PoC (`@throwaway/alpha-engine`)

**Date:** 2026-06-18
**Auditor role:** Acceptance auditor (spec letter + original intent)
**Baseline commit:** 729219d (all reviewed files NEW)
**Inputs audited:**
- Implementation diff `/tmp/alpha-engine-review.txt` + live files under `throwaway/alpha-engine/`
- SPEC `_bmad-output/implementation-artifacts/spec-alpha-engine-poc.md`
- Original PoC `docs/alpha_engine_poc_v1.pdf` (Parts V §10–12, IX §18–19)
- Gap analysis `_bmad-output/implementation-artifacts/gap-analysis-alpha-engine-poc-2026-06-18.md`

**Verification run (all green):**
- `pnpm exec vitest run throwaway/alpha-engine` → 3 files, 17 tests pass.
- `pnpm exec tsc -p throwaway/alpha-engine/tsconfig.json --noEmit` → exit 0.
- `pnpm check:regime` → "✅ Regime boundary OK: /prod has no imports from /throwaway."
- `pnpm exec tsx throwaway/alpha-engine/src/run.ts` already produced `out/series.csv` (10 000 ticks) + `out/series.json`.

**Empirical default-run facts (seed 12345, from `out/series.csv`):**
- `p_int`: starts 1.0, ends 4.497, **never decreases**, takes only **6 distinct values** in 10 000 ticks (jumps at t=1430, 1615, 1721, 2239, 3000, then flat forever).
- **Zero bankruptcies**: alive count is 50L/50S for the entire run; min alive total = 100.
- `total_capital` **increases** on 3 ticks (t=1430 +131; t=2239 +99 942; t=3000 **+189 572**, a ~19% one-tick jump) — i.e. it is *not* monotone non-increasing.
- `matched_volume` > 0 on only **28 of 10 000 ticks**; cumulative cleared = **6 174 EUR out of K = 1 000 000** (~0.6% of capital ever trades).

---

## 1. Acceptance Criteria — verdicts

| # | AC (abridged) | Verdict | Evidence |
|---|---------------|---------|----------|
| 1 | Crossing → clearing price is lowest swept price satisfying supply≥demand; EUR-out-of-longs = EUR-into-shorts (zero-sum) | **MET** | `auction.ts` `runAuction` computes `crossing=demandEur/supplyBtc`, `price=max(prevPrice,crossing)`, fills largest-first; `auction.test.ts` "clears at the LOWEST swept price…" + zero-sum `eurSum/btcSum ≈ 0`. |
| 2 | One empty side → `p_int` unchanged, orders carry forward | **MET** | `runAuction` early-return `{price: prevPrice, …, fills: []}`; `auction.test.ts` "one empty side ⇒ price holds and no fills" asserts queue size untouched. |
| 3 | `K0` differing 4× → larger fires ~4× less (`d_i ∝ K0_i`) | **MET** | `init.ts` `d = dBase*(K0/min)`; `init.test.ts` asserts `d_i == dBase*(K0_i/K0_min)` and `dRatio ≈ k0Ratio`. |
| 4 | `K ≤ ε` → agent removed, its queued orders gone | **MET (code path only; see F2)** | `simulation.ts` step 6 marks dead + filters queue; `auction.ts` `purgeConsumed` skips dead; `simulation.test.ts` "removes agents whose K ≤ ε" — **but only under forced params** (`dBase=1e9`, `f=1`, `c=0.5`). The default run never triggers it. |
| 5 | Any run, ≥1 alive, no replenishment → `total_capital(t) ≤ total_capital(t-1)` | **NOT MET** | Default run violates it on 3 ticks (max +189 572). The test (`simulation.test.ts`) silently restricts the assertion to flat-price ticks (`if (cur.pInt === prev.pInt)`), so the violation passes unobserved. See F1/F3. |
| 6 | `tsx src/run.ts` writes CSV+JSON with the five §18 series; vitest passes | **MET** | `out/series.csv` + `out/series.json` exist with all five series (long/short split); 17/17 tests pass. |

**Tally: 5 met (AC4 with a material caveat), 1 not met (AC5).**

---

## 2. Findings

### F1 — [HIGH] The frozen auction reading makes `p_int` a one-way ratchet → the PoC cannot exhibit its target behaviour (Part IX)
**Relates to:** PoC §11–12 (price formation), §19 ("What We Are Looking For"); SPEC frozen I/O matrix "Crossing found" row + non-frozen Design Notes.
**Met/not-met:** Spec-faithful but **defeats original intent.**

The PoC exists to observe whether `p_int` is "stable, noisy, or oscillatory," whether "liquidity crises appear… sudden price gaps," and "how long the pool survives before mortality collapses the dynamics" (§19). §12 explicitly anticipates a price that can **trend in either direction**: "Persistent imbalance… will cause p_int to trend. Symmetric flow produces a stable or noisy price."

The implementation's frozen reading clears at `price = max(p_int(t-1), D/Btot)` (`auction.ts:351-352`). Because short supply is modelled as `S(p)=Btot·p` (monotone increasing) against price-independent EUR demand `D`, the equilibrium is always `D/Btot`, and the `max(prev, …)` floor turns it into a **non-decreasing ratchet**. Empirically the default run produces a step function with 6 distinct values that never falls. Oscillation, noise, downward gaps, and "calm vs volatile" regimes are **structurally impossible** — none of the §19 questions can be answered.

**Root of the floor:** the genuine crossing price `D/Btot` *does* oscillate (rises when longs fire more, falls when shorts fire more). The degeneracy comes **entirely from the `max(prev,…)` floor** ("we never sweep below the previous price"), which originates in the PoC §11 wording "Sweep price upward from p_int(t-1)" and was carried into the **non-frozen Design Notes**. The **frozen** I/O matrix only mandates the supply/demand *formula* (`supply = BTC·p ≥ demand = EUR`); "lowest price where `Btot·p ≥ D`" is exactly `p = D/Btot` and is fully satisfiable **without** flooring at `prev`.

**Remediation (does NOT require renegotiating frozen intent):** in the non-frozen Design Notes + `auction.ts`, clear at the unfloored equilibrium `p_int(t) = D/Btot` (the lowest price where cumulative supply meets demand, evaluated globally, not as a one-way sweep from the previous price), retaining the "no crossing ⇒ hold prev" rule only for the genuinely one-sided book. This restores a two-sided, oscillating endogenous price consistent with §12/§19 while staying inside the frozen matrix's supply/demand definition. If the human reads the frozen matrix phrase "lowest **swept** price" as binding the upward-only sweep, then this becomes a frozen-intent renegotiation — but it must be done regardless, because the deliverable currently cannot produce the phenomena the PoC was commissioned to study.

**Decisive call:** this is a **SPEC-level defect** (the I/O matrix + Design Notes chose a degenerate auction reading), fixable in the **non-frozen** layer; the underlying `D/Btot` price already oscillates, so no change to the frozen *intent* is needed — only to the frozen-adjacent *reading*.

### F2 — [HIGH] Zero mortality in the default run → the central PoC question ("when does the pool collapse, who dies first?") is unanswerable
**Relates to:** PoC §15, §19; SPEC I/O matrix "Bankruptcy"/"Termination" rows; AC4.
**Met/not-met:** AC4 code path met; **PoC mortality phenomenon absent.**

Direct consequence of F1. Because `p_int` ratchets **up**, every agent's accumulated BTC is revalued upward, so `K_i = eur_i + btc_i·p_int` never approaches `ε`. The default run records **zero deaths** across 10 000 ticks (alive = 100 throughout). The all-in "mortality regime" (§9, `K_i < K0_min`) therefore **never fires**. §19's questions — pool survival time, small-vs-large death order, self-organising behaviour before collapse — cannot be studied with the shipped defaults.

The bankruptcy/purge **code** is correct and is exercised, but only via **forced, non-default parameters** (`simulation.test.ts` "bankruptcy" block uses `dBase=1e9`, `f=1`, `c=0.5` to manufacture deaths). This confirms the code works yet simultaneously confirms the default scenario exhibits none of the intended dynamics.

**Remediation:** primarily resolved by F1 (a two-sided price lets losing-side agents lose EUR-terms value and die). No frozen-intent change required beyond F1.

### F3 — [HIGH] AC5 monotone-drain test is weakened to pass, masking a real AC violation
**Relates to:** AC5; PoC §13 ("informative measure of pool health is total_capital(t)").
**Met/not-met:** **NOT MET** (test integrity).

AC5 states unconditionally: "when a tick completes, then `total_capital(t) ≤ total_capital(t-1)`." The default run violates this on 3 ticks (up to +189 572 EUR, a ~19% jump) when `p_int` ratchets up and revalues BTC inventory. `simulation.test.ts` ("total_capital is monotone non-increasing across flat-price ticks") guards the assertion with `if (cur.pInt === prev.pInt)`, so the rising-price ticks — exactly where the AC fails — are never checked. The test passes by construction, not because the AC holds.

This is also evidence that the AC and the chosen auction reading are **mutually incoherent**: a ratcheting EUR-denominated price cannot keep an EUR-denominated aggregate monotone. (No conservation law is broken — trades are zero-sum; the aggregate rises purely because the numéraire price moved.)

**Remediation:** once F1 is fixed (price free to fall), re-state AC5 honestly. Either (a) keep the monotone-drain claim only for the *carry component* (e.g. assert `total_capital` net of revaluation is non-increasing, or track a separate cumulative-carry-to-house series), or (b) restrict AC5 in the SPEC to flat-price ticks explicitly rather than letting the test do it silently. This touches the **non-frozen** Tasks & Acceptance / Design Notes, not the frozen intent.

### F4 — [LOW] Carry-deduction ordering differs from PoC §16, but matches the SPEC Code Map
**Relates to:** PoC §16 step 1 vs SPEC ## Code Map / ## Design Notes.
**Met/not-met:** consistent with SPEC, minor deviation from PoC pseudocode.

PoC §16 deducts carry inside step 1 (before firing/auction); the implementation accrues pressure in step 1 but defers the balance drain to **after** the auction (`simulation.ts` step 5), exactly as the SPEC's non-frozen Code Map prescribes ("…auction → capital update → carry deduction → bankruptcy"). Materially negligible (shifts the drained base by one fill), and it is a deliberate SPEC choice, so **acceptable** — noted only for traceability.

### F5 — [INFO] Order-size baseline uses `K0_min`, resolving the PoC §9-vs-§16 ambiguity
**Relates to:** PoC §9 (`K0_min`) vs §16 pseudocode (`x_min`); SPEC I/O matrix.
The PoC is internally inconsistent: §9 gates the all-in regime on `K_i ≥ K0_min` while the §16 loop writes `K_i ≥ x_min`. The SPEC I/O matrix chose `K0_min`, and `simulation.ts` uses `baselineK0 = k0Min(agents)` accordingly. Faithful to the SPEC; no action. (Note: with default `f=0.9`, `xMin=2000`, `K0_min ≤ xMin`, so the distinction is minor and currently moot given F2 — the all-in branch never executes.)

### F6 — [INFO] "Never" boundaries honoured; "Always" honoured
- **/prod import:** none — `check:regime` passes; no references to `alpha-engine` outside its own dir / bmad docs.
- **Workspace:** `pnpm-workspace.yaml` globs only `prod/packages/*`; the package is deliberately excluded — confirmed.
- **No deps added:** `package.json` declares no dependencies; uses Node stdlib + repo-level `tsx`/`vitest` only.
- **Part X deferred features:** none present (no `p_ext`, spread, yield curves, replenishment, risk warehousing, power-law `d_i`).
- **Conservation / non-negativity:** per-trade zero-sum enforced (fills sum to 0); orders capped at current home inventory in `runAuction` and at firing (`Math.min(rawSize, home)`), so balances cannot go negative.
- **Determinism:** mulberry32 seeded; "same seed ⇒ identical series" test passes.
- **Float use:** permitted (Throwaway; NFR-2 binds /prod only) — correctly documented.

No "Never" violated; no "Always" unmet.

### F7 — [LOW] Liquidity / queue-depth signal is near-dead in the default run
**Relates to:** PoC §18 (`queue_depth` "reveals imbalance and liquidity crises"), §19.
Queue depth is 0 on essentially every recorded tick and only 28 ticks ever clear volume (0.6% of capital). With `W=5` and sparse firing, orders mostly expire unmatched or clear instantly, so the `queue_depth` series carries almost no information about imbalance/liquidity crises — another §19 lens rendered inert. Largely downstream of F1/F2; revisit after the auction fix.

---

## 3. Summary judgement

The package is clean, well-documented, deterministic, regime-compliant, and **literally spec-faithful** — but the SPEC froze a **degenerate auction reading** (price-independent EUR demand vs `Btot·p` supply, cleared by an upward-only sweep floored at the previous price). That reading collapses the simulation into a monotone price ratchet with zero mortality and almost no trading, so the artifact **cannot exhibit any of the emergent phenomena (oscillation, liquidity crises, mortality, self-organisation) that the PoC exists to study (Part IX).** Two ACs are effectively undermined by this: AC4's mortality path never runs in the default scenario, and AC5 is literally false in the default run and passes only because its test was narrowed to flat-price ticks.

**This is a spec defect, not merely an implementation choice — and it is fixable without renegotiating the frozen *intent*:** clear at the genuine two-sided equilibrium `p_int = D/Btot` (which already oscillates) instead of `max(prev, D/Btot)`. The fix lives in the non-frozen Design Notes / `auction.ts` and cascades to restore mortality (F2), make AC5 honest (F3), and revive the queue-depth/liquidity signal (F7).
