# Gap Analysis — Alpha Engine PoC vs ROSE Engine

**Date:** 2026-06-18
**Inputs:** `docs/alpha_engine_poc_v1.pdf` (*The Alpha Engine — POC Specification v1.0*) vs the ROSE Engine PRD (`_bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/prd.md`, updated 2026-06-18).
**Comparison baseline:** the PRD — primarily §1 (Vision / *intrinsic time*), §4.7 (Coupled-Coin Model Validation), and §17 (Roadmap). Architecture/epics not used as baseline.
**Confirmed intent (user, 2026-06-18):** the PoC is positioned as **(b) an alternative validation of the *intrinsic-time* thesis** — *not* a P0 deliverable and *not* (primarily) an Intraday-Money-Market brick.

---

## 1. What the Alpha Engine PoC is

A **closed, agent-based market-making simulation**:

- **2n agents** (n=50/side, 100 total) in two fixed populations — *longs* (EUR-heavy, want BTC) and *shorts* (BTC-heavy, want EUR). **Lane model:** an agent never flips side.
- **No programmed price.** `p_int` **emerges** from a **Dutch auction** that clears the order queue each tick (sort by size descending, sweep price upward until cumulative short supply ≥ cumulative long demand).
- **Carry-cost pressure** as an internal clock: `phi_i(t) = phi_i(t-1) + c`; an agent fires when `phi_i ≥ d_i`; the firing threshold `d_i = d_base·(K0_i/K0_min)` **scales with initial capital** (large agents fire rarely → power-law firing frequency).
- **Two-regime order size:** above baseline `K0_min` → fractional `K_i/q`; below → **all-in** (the mortality mechanism).
- **Mortality:** capital below `epsilon` → agent dies, orders purged, **no replenishment**; the pool shrinks monotonically (drained by carry toward "the house").
- **Zero-sum trading**, P&L not tracked; system health measured by `total_capital(t)`.
- **Capital ~ Pareto(x_min, α=1.5)** — many small agents, few large.
- **Success criterion (explicit):** *"Success is not a correct price. It is interesting, legible emergent behaviour"* — stability, oscillation, liquidity crises, agent mortality.
- **Deferred to future versions:** external price feed `p_ext` + external traders; spread/bid-ask; bilateral yield curves; capital replenishment / wealth recycling; risk warehousing.

---

## 2. Central finding

**The Alpha Engine PoC and the ROSE P0 coupled-coin model are two different simulations answering two different questions.** The PoC does **not** validate, replace, or implement any P0 requirement, and it is **not** the §4.7 validation simulator.

| | Alpha Engine PoC | ROSE P0 (§4.7) |
|---|---|---|
| **Question** | How does a price **emerge** from a closed internal market, and when does the pool collapse? | Does the **instrument model** hold: `V_A+V_B=K`, no negative leg? |
| **Price** | **Endogenous** (Dutch auction) | **Exogenous** (historical EUR/USD & BTC ticks) |
| **Unit of analysis** | Populations of long/short agents | One **coupled pair** (L+S legs of an instrument) |
| **Success** | Interesting emergent behaviour | Invariant proven / falsified |

> ⚠️ **Do not misread the name.** Despite "Engine", the PoC shares almost nothing with P0 mechanics (ledger, ERC-3643, compliance, coupled pair, floor-breach reset). **It does not advance P0.**

---

## 3. Reframed against intent (b): the intrinsic-time thesis

Both artifacts probe the **same thesis from two altitudes** — *financial time measured by meaningful events, not the wall clock* (§1; James Glattfelder). They are **complementary lenses**, not duplicates:

| Lens | Mechanism | Altitude |
|---|---|---|
| **ROSE §4.7** — intrinsic time *in the instrument* | **Threshold-only rebalancing**: a reset fires only when a losing leg breaches the floor, never on a clock (clock-based would import leveraged-ETF decay) | **Micro** — one coupled instrument vs exogenous price |
| **Alpha Engine** — intrinsic time *in the market* | **Carry-pressure firing**: each agent's internal clock (`phi_i`) accumulates pressure; trading fires by threshold, scaled by capital — emergent, event-paced, no wall clock | **Macro** — a population of agents producing an endogenous price |

**This is the strongest point of alignment.** Both replace clock-time with event/pressure-time. The PoC is a credible *macro/market-level* demonstration that the same intrinsic-time principle that governs the instrument's resets can govern an entire market's price formation.

---

## 4. Gap analysis

### A. PoC concepts that are MISSING from ROSE (net / forward-looking)

| PoC concept | Status in ROSE PRD | Gap |
|---|---|---|
| **Endogenous price formation** (Dutch auction) | Absent — ROSE reads exogenous ticks (§4.7; §14 "no live feed in P0") | ROSE has **no internal price model**. This is exactly the `p_ext`↔`p_int` coupling the PoC defers to V2, and the kernel of "intraday money market" (§17 beyond-P0). |
| **Liquidity dynamics / crises** (queue depth, one-sided imbalance) | Absent | No notion of market depth or liquidity crisis in ROSE. |
| **Agent mortality, Pareto capital, carry-drain pool health** | Absent | ROSE models neither a participant population nor pool sustainability. |
| **Carry pressure as an internal clock** | Conceptual cousin of "intrinsic time" but a different mechanism | The link between *agent-level carry-pressure firing* and *instrument-level floor-breach reset* is **unformalized** (see §6). |

### B. ROSE requirements the PoC does NOT cover (gaps for any ROSE use)

| ROSE requirement | PoC | Gap |
|---|---|---|
| **Coupled pair L+S, delta-neutral, `V_A+V_B=K`, floor, D1/D1a reset** (§4.2/§4.7) | None — long/short are *agent populations*, not the two legs of one instrument | **Fundamental** — the PoC does not test the ROSE instrument at all. |
| **Double-entry ledger, DB invariant** (FR-1/2/3) | Capital = plain floats per agent | Absent. |
| **Exact arithmetic; binary float prohibited in PROD** (NFR-2) | Everything in **`float`** (eur_i, btc_i, K_i…) | **Direct conflict with NFR-2** — acceptable *only* if the PoC stays Throwaway (§11.1), like the §4.7 simulator. |
| **On-chain ERC-3643, compliance, ONCHAINID** (§4.3/§4.5) | None | Absent (expected — pure internal market). |
| **Reconciliation ledger↔chain, position↔pair** (FR-10/FR-27) | None | Absent. |
| **Per-user position layer §4.8** (entry/mark/P&L) | Agents carry positions, but it is a *sim*, not a per-user product; **P&L explicitly not tracked** | Weak conceptual overlap; opposite purposes. |
| **Regulated entities, Model-A segregation** (§12) | None | Absent. |

---

## 5. Decisions acted (per user-approved recommendations)

1. **Classification — Throwaway / R&D artifact.** The Alpha Engine PoC sits at the same regime as the §4.7 validation simulator: **exploratory, disposable, and `/prod` must never depend on it** (§11.1). Its use of binary `float` is acceptable *only* under this Throwaway status.
2. **Roadmap anchor — intrinsic-time thread (intent b), not P0.** It belongs to the §1 / §4.7 *intrinsic-time / complexity-science* thread as a macro-level validation lens, alongside (but distinct from) the §17 beyond-P0 "Intraday Money Market" direction.
3. **Conceptual reconciliation flagged (see §6).**

---

## 6. Open conceptual reconciliation (to trace)

The PoC's *longs/shorts* are **not** the *L/S legs* of a coupled pair — they are independent agents in a population. Two unformalized links remain:

- **(i)** Could the PoC's emergent `p_int` later serve as a **price source** for the coupled-coin model (replacing exogenous §4.7 ticks)? That would be a **major product/architecture decision**, currently undecided; today the two models are disjoint.
- **(ii)** Is carry-pressure firing (`phi_i ≥ d_i`) formally the *same* intrinsic-time principle as floor-breach rebalancing, or merely analogous? Worth a short formal note before either is treated as validating the other.

Neither is needed now; both should be revisited if the PoC graduates from "intrinsic-time validation" toward feeding the instrument or the intraday-money-market end-state.

---

## 7. PRD linkage (APPLIED 2026-06-18, user-confirmed)

A minimal cross-reference was added to the PRD, classifying the PoC as a Throwaway, macro-level intrinsic-time validation:

- **§1 Vision** — parenthetical after the threshold-only sentence pointing to the market-scale exploration (→ §17).
- **§4.7 note** — a "Related exploration (Throwaway, not P0)" block describing the Alpha Engine as the same intrinsic-time thesis at market level, disjoint from the instrument and P0, with a link to this gap analysis.
- **§17 Roadmap** — a "Intrinsic-time research thread (Throwaway R&D)" direction, complementary to §4.7's instrument-level validation, with the future link (emergent `p_int` → coupled-coin model, or → Intraday Money Market) marked undecided.

Recorded in `prds/prd-rose-engine-2026-06-15/.decision-log.md` (entry 2026-06-18).
