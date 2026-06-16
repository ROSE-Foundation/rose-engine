# PRD Reconciliation — Source: ROSE_Real_Time_Finance_Intro.docx

**Date:** 2026-06-15
**PRD reconciled:** prd-rose-engine-2026-06-15/prd.md (+ addendum.md)
**Source input:** `docs/ROSE_Real_Time_Finance_Intro.docx` — the product's public-facing positioning / intro deck.
**Purpose:** Surface qualitative ideas (positioning, problem framing, distinctive concepts, "why now", credibility) present in the source but missing or weak in the FR-structured PRD — for a board/stakeholder audience.

---

## What the source already carries through well (no action)

- **"Digital on the surface, digital underneath"** — present verbatim in PRD §1 Vision.
- **T+2 / settlement lag / overnight-trapped liquidity / batch infrastructure** — present in §1 and §18 Why Now.
- **Delta-balanced coupled pair** — central to §1 and §4.2.
- **Swiss non-profit + surplus to the commons** — present in §12, §13, addendum §H (though framed as out-of-P0 context, which is correct).

---

## GAP 1 — "Intrinsic Time" (event-based vs clock-based market time) — MISSING as a named concept

**Source:** "Intrinsic Time — Traditional finance measures markets according to the clock. ROSE measures markets according to meaningful events. When markets are calm, financial time slows down. When volatility accelerates, financial time accelerates with it."

**PRD status:** The *concept* is absent by name, yet the PRD's design **operationally embodies it**: threshold-only rebalancing that fires on price events, "**never on a clock**" (FR-16, FR-17, §4.7, addendum §D). The PRD currently sells this only as a technical guard against leveraged-ETF volatility decay — it never connects it to the intrinsic-time thesis that gives it intellectual weight and provenance (this is James Glattfelder / Olsen-lineage research; see GAP 4).

**Why it matters (board audience):** This is the single most distinctive, defensible idea in the source and the PRD silently drops the framing while keeping the mechanism. Naming it turns an implementation detail ("we don't rebalance on a timer") into a positioning pillar ("ROSE runs on intrinsic, event-based time — and here is the first concrete proof of it"). It also makes the BTC vs EUR/USD stress test legible: time accelerates with volatility.

**Suggested PRD home:** Add a short paragraph to **§1 Vision** introducing intrinsic time as a founding premise, and a one-line cross-reference in **§4.7** / FR-16 noting that threshold-only rebalancing *is* the P0 realization of intrinsic time. Optionally add the term to **§3 Glossary**.

---

## GAP 2 — "Real-Time Lending" / continuous intraday money market — DEMOTED to roadmap, weak in Vision

**Source:** "Real-Time Lending — ROSE introduces continuous intraday money markets where liquidity can be borrowed or lent instantly while capital remains dynamically active at all times." Presented as a first-class pillar of the product, not a future direction.

**PRD status:** The intraday money market appears only in **§17 Roadmap** as a post-P0 "direction, not commitment" ("the first step to a global liquidity pool"). §1/§18 mention that "no genuine intraday money market exists" as the *problem*, but the *product answer* (real-time lending, continuously active capital) is not stated as part of the vision.

**Why it matters:** A board reading the source expects intraday/real-time lending to be a core ROSE proposition; the PRD frames the problem but withholds the headline solution, making the vision feel narrower than the positioning. The asymmetry (problem in §18, solution only in roadmap) reads as scope retreat rather than deliberate sequencing.

**Suggested PRD home:** One sentence in **§1 Vision** naming continuous intraday lending / dynamically-active capital as the destination the Engine's real-time spine is built toward, explicitly flagged as post-P0 to preserve scope discipline. Tighten the **§17** line so it reads as "the named pillar, sequenced later" rather than a loose direction.

---

## GAP 3 — "Coupled Infrastructure" as liquidity *recycling* — framing weaker than source

**Source:** "Coupled Infrastructure — paired financial structures designed to remain delta-balanced while **recycling liquidity internally across the system**. Instead of leaving collateral dormant, liquidity continuously circulates through the infrastructure itself."

**PRD status:** Partially present — §1 says the coupled pair keeps "collateral continuously active instead of dormant." But the **systemic** claim (liquidity recycled/circulating *across the infrastructure*, not just non-dormant per pair) is lost. The PRD frames the coupled pair almost entirely as a *risk-bounding* device (delta-neutral → directional risk from strategy only), which is correct but is only half of the source's claim. The other half — coupled pairs as a *liquidity-recycling* mechanism — is the link between the coupled pair and the intraday-money-market vision (GAP 2).

**Why it matters:** Without the recycling framing, §1 and §13's "Engine generates the surplus" story lacks its mechanism-level "how the money keeps working." It is the conceptual bridge from "coupled pair" to "real-time liquidity infrastructure," and it strengthens the board's understanding of why coupling is structural rather than merely a hedging trick.

**Suggested PRD home:** Extend the coupled-pair sentence in **§1 Vision** (and/or the Glossary entry for *Coupled pair* / *Collateral pool K*) to state both properties: delta-neutral at issuance **and** liquidity-recycling (collateral stays in continuous circulation rather than dormant).

---

## GAP 4 — Named contributors / credibility roster — MISSING

**Source:** "Selected Contributors — James Glattfelder (complexity researcher and author), Fabrice Croiseaux (CEO of InTech), Rémy Klammers (CEO of Namara Wealth Advisors), Annie-Laure (systems architecture), Thibault Verbiest (Founding Partner of AUSIA), Theo Helfenstein (financial architecture), Ryan Anderson (systems engineering)."

**PRD status:** Only *organizations* appear (InTech, Namara Wealth Advisors, AUSIA in §12/§16). No individuals are named. Notably, **James Glattfelder** — a complexity researcher — is the intellectual provenance for intrinsic time (GAP 1), and the PRD captures neither the person nor the lineage.

**Why it matters (board audience):** A board/stakeholder PRD is partly a credibility document. The contributor roster is the source's signal that serious, named domain experts stand behind ROSE — especially Glattfelder anchoring the intrinsic-time thesis, Klammers (the licensed IM already cited as Namara), and Verbiest (AUSIA, already cited as legal counsel). Dropping the names removes the "why trust this" substance.

**Suggested PRD home:** Add a brief **Contributors / Key People** note in **§16 Stakeholders & Approvals** (or a short subsection), mapping named individuals to their organizations and roles, and tie Glattfelder to the intrinsic-time concept where GAP 1 is addressed.

---

## Summary table

| Gap | Source concept | PRD location to strengthen |
|-----|----------------|----------------------------|
| 1 | Intrinsic time (event- vs clock-based) | §1 Vision; cross-ref §4.7/FR-16; §3 Glossary |
| 2 | Real-time lending / intraday money market as a pillar | §1 Vision; tighten §17 |
| 3 | Coupled infrastructure as liquidity recycling | §1 Vision; §3 Glossary |
| 4 | Named contributors (incl. Glattfelder) | §16 Stakeholders |
