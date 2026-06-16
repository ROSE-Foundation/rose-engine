# Vision-Layer Reconciliation — ROSE Engine PRD

**Date:** 2026-06-15
**PRD under review:** `prd.md` (+ `addendum.md`), `prd-rose-engine-2026-06-15`
**Scope of reconciliation:** Engine product ONLY. The three sources are vision / pitch / impact documents; most of their content is intentionally out of scope for an Engine PRD. This note surfaces only the GENUINE, Engine-relevant gaps.

**Corpus reconciled (3 sources):**

1. *Understanding ROSE Through the Lens of a Living Cell* (.docx) — living-cell metaphor (Engine = mitochondria, coupled coins = circulating molecules).
2. *ROSE — Maximizing The Commons Allocation's Leverage V1* (.docx) — argument that Engine surplus → Commons → a Geneva-area rapid-prototype hardware/energy lab; "maximize leverage" deployment thesis.
3. *Rose Presentation — alternative story* (.pdf, 12 slides) — investor pitch: the RCCE exchange, 10 ROSE values/manifesto, coupled-coin "inherently balanced" claim, Oanda/Lykke precedents, Intraday Money Market as first step, "sprout fund" / ROSE treasury coin.

---

## Engine-Relevant Gaps

### GAP 1 — Oanda / Lykke precedent lessons are absent (genuine, actionable)
The RCCE slide states the exchange "**Is informed by successful (Oanda) and failed (Lykke) past exchange ventures.**" Neither Oanda nor Lykke appears anywhere in the PRD or addendum. The PRD draws its only precedent from **Laplace** (`laplace.digital`), which is a tokenised-note distribution precedent — not an *exchange/venue* precedent. Lykke is a **failed exchange** and is therefore a direct source of Engine-relevant risk/design lessons (why prior exchange ventures failed), and Oanda is a relevant success model for FX/intraday mechanics. This is the most material gap: a named, source-endorsed precedent set that bears directly on Engine design risk is missing from §14 (Integration & Dependencies / precedent) and §15 (Risk & Mitigations).
**Recommendation:** Add Oanda (success) and Lykke (failure) as precedent inputs alongside Laplace — at minimum a line in §14 and a risk-lesson reference in §15 — even if detailed post-mortem is deferred.

### GAP 2 — Intraday Money Market "first step" framing vs. P0 sequencing (minor)
The RCCE slide says the exchange "**Starts with Intraday Money Market (IMM) as first step to create global liquidity pool.**" The PRD references the IMM only as an undated "Beyond P0" direction (§17) and as the macro motivation in §18 ("no intraday money market exists"). The source treats IMM as the *intended first productization step of the exchange*; the PRD's P0 is instead the coupled-pair model-validation vertical slice. These are not in conflict, but the PRD does not explicitly connect the dots — i.e. that the IMM is the intended productization target the P0 slice is a precursor to.
**Recommendation:** A one-line note in §17 making IMM the explicit named "first step" post-validation (not just one direction among several) would align PRD sequencing with the source's stated intent.

### Covered / no gap (verified, not action items)
- **"Inherently balanced through coupled coins"** (RCCE slide) — captured by the PRD's delta-neutral-at-issuance framing and the issuer-neutral invariant `V_A + V_B = K` (§1, §4.2, §4.7, SM-2). Same concept, different wording.
- **Commons allocation purpose** (source 2; deck "surplus allocated to commons") — §13 does capture *why* Engine surplus matters ("Engine-first → Funding-first"; spine safety/model validity are the precondition for real-world Commons deployment). Addendum §H additionally carries the Geneva hardware/energy-lab context. Adequate for an Engine PRD; the lab itself is correctly out of scope.
- **Real-time settlement / intraday interest** (manifesto image) — captured in §1 and §18.

---

## Intentionally Out of Scope (no action)

These source elements are vision/movement/pitch material, correctly excluded from an Engine product PRD:

- The entire living-cell metaphor (source 1) — already lightly acknowledged in addendum §H as context.
- The 10 ROSE values / Manifesto and the six-domain flower (Money System, EDIN, Living Movement, Balanced Governance, Commons) — movement scope, excluded per §0 and §5.
- RCCE as a **complementary-currency ↔ stablecoin** exchange "connecting two fast-growing markets," "empowering local communities," "relational criteria for early adopters" — Money-System scope; P0 deliberately uses EUR/USD and BTC reference pairs only.
- The Geneva energy hardware lab specifics (source 2: focus on decentralized energy, lab structure, remuneration, patents, commercial offshoots) — Commons scope, out of P0.
- The **"sprout fund" / ROSE treasury coin** (deck: min 100k CHF, 3-year lock, appreciation) — a distinct *movement-level* fundraising instrument separate from the VCC Rose Note / coupled L-S tokens the Engine issues; not an Engine P0 capability.
- "Ethics first" / stewards-and-elders governance, EDIN signaling/nervous-system — Governance & EDIN scope.

---

*No changes made to `prd.md` or `addendum.md`. This note is advisory.*
