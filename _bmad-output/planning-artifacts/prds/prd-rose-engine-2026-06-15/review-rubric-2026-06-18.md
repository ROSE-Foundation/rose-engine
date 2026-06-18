# PRD Quality Review — ROSE Engine (delta: §4.8 Secondary-Trading Position Layer, FR-23–FR-27)

*Scope: this review targets the 2026-06-18 update that added §4.8 + FR-23…FR-27, the supporting forward-references (§4.5/FR-20, §4.6/FR-14), scope notes (§5, §6.1, §6.2), the §14 oracle dependency, §8 Q8, §15 risks, three glossary terms, and four new P0 acceptance criteria. Broader PRD issues are noted only where the delta touches them.*

## Overall verdict

The delta is **high-quality and lands cleanly**. §4.8 is a genuinely earned addition — it documents a real design conflict (the perp-style "buy-a-naked-leg" mock vs. the atomic-coupling invariant), the four resolutions considered, the choice (Option C), and the safety rationale, then expresses the choice as five contiguous, testable FRs that preserve every existing invariant. Internal consistency with FR-6/18/19/21, §5 non-goals, §14 "no live feed", and D1/D1a is sound — no contradiction found. What remains is a small cluster of **traceability and done-ness gaps**: the leverage-pinned-to-1x decision and the FR-23 position model carry no acceptance criterion, FR-27 (position↔pair reconcile) is the kind of integrity-by-test FR that belongs in SM-4 but is not wired to any success metric, the position `lifecycle` states are referenced but never enumerated, and the interaction between an open position and a pair *reset/re-anchor* (D1a settlement boundary) is unspecified. None are blocking. Gate: **PASS-WITH-FIXES**.

## Decision-readiness — strong

The two product decisions the update hinges on are stated *as decisions*, with the trade-off surfaced, not smoothed:

- The §4.8 "Origin (sprint change 2026-06-18)" callout names all four resolutions (A order-book matching; B AMM/market-maker; C off-chain synthetic; D redefine contracts for single legs), states C was chosen, and says *why* the others were rejected (preserve invariant, no re-audit, reuse proven patterns). It even pre-commits the re-opening condition: "Any future need to alter on-chain coupling re-opens this resolution (toward Option D) with a fresh audit." This is exactly the "decision stated as a decision" the rubric wants.
- "Safety-over-UI: the invariant wins; the terminal is adapted to the model honestly, the model is not bent to the mock." — the tension is acknowledged head-on rather than dodged.
- The leverage decision is honest about what it is: modelled for forward extensibility but **pinned to 1x in P0**, with the disabled/fixed-1x terminal state spelled out (FR-23).

No findings.

## Substance over theater — strong

No furniture in the delta. §4.8 exists because Discovery (the mock conflict) surfaced it, not because a template had a slot. The three new §15 risks (synthetic-exposure/solvency, oracle trust input, position-layer scope creep) each name a real, specific failure mode with a concrete mitigation tied to an FR or guardrail — not boilerplate. The Lykke exchange-collapse precedent is reused as a named review input for the solvency risk rather than as decoration.

No findings.

## Strategic coherence — strong

The position layer serves the PRD's stated thesis rather than bolting on a capability. The thesis bet is the atomic coupled pair as a risk/invariant device; §4.8 is explicitly the *derived* product surface that lets users see directional exposure **without** breaking that bet, and it is the thing that makes the Exchange/Trading surface (FR-14) honestly functional. It is positioned as a derived layer over the existing source-of-truth (chain + ledger), reusing the FR-10 reconcile-and-correct pattern (FR-27) and the `postTransfer` chokepoint — so it inherits the spine's safety posture instead of inventing a parallel one.

No findings.

## Done-ness clarity — adequate

Each of FR-23…FR-27 carries a "Consequences (testable)" block, and four of the five are mirrored in P0 acceptance criteria. The gaps are real but fixable:

### Findings
- **medium** Position `lifecycle` referenced but states never enumerated (§4.8 / FR-23) — FR-23 lists `lifecycle` as a stored field, but unlike FR-4 (which enumerates the pair states `PENDING → ACTIVE → … → CLOSED`), the position lifecycle states are never defined. An engineer cannot know what "done" looks like for position state transitions. *Fix:* enumerate the position lifecycle states (e.g. `OPEN → CLOSED`, plus any settlement/partial state implied by D1a) in FR-23, or explicitly defer to §8 Q8 if the state set is part of the unresolved claim/assignment semantics.
- **medium** Interaction between an open position and a pair reset/re-anchor (D1a) is unspecified (§4.8 vs §4.2/§8 Q1 D1a) — FR-23 fixes `entry = anchor P₀`, and §4.2/§8 D1a establish that at each reset the pair *re-anchors P₀* and *re-bases both legs symmetrically* as a settlement boundary. The PRD never says what happens to an open position's `entry`/realized-vs-unrealized P&L when the underlying pair resets beneath it. This is the seam where the new layer meets the most subtle settled decision in the PRD. *Fix:* add one consequence to FR-23 or FR-25 stating how a reset on the underlying pair maps onto an open position (e.g. position P&L crystallises at the reset boundary mirroring the leg settlement), or explicitly fold it into §8 Q8 as part of the claim/assignment mechanism.

## Scope honesty — strong

Omissions are explicit and thorough. §5 gained a dedicated non-goal paragraph for §4.8 ("not a venue … not a matching engine/CLOB/AMM"), restated the real-capital/real-venue secondary market as board-gated (§11.3), and named leveraged positions (>1x) as out. §6.1 lists the layer as in-scope with the 1x pin and CSV/testnet adapter; §6.2 mirrors the out-of-scope side (real-capital secondary market, >1x leverage, on-chain single-leg/contract redefinition). §8 Q8 honestly parks the claim/assignment semantics for architecture rather than silently assuming them. The single new open question on a green-light-to-build PRD is proportionate.

No findings.

## Downstream usability — adequate

IDs are clean: FR-23, FR-24, FR-25, FR-26, FR-27 are contiguous and sit correctly after the prior maximum FR-22 (the PRD numbers FRs globally-stable, not section-sequential, so contiguity-after-max is the right test and it holds). The three new glossary terms (Position (synthetic), Price oracle, Mark-to-market) are defined and used consistently in §4.8, §14, and §15. Forward-references resolve:

- §4.5 FR-20 → "§4.8, FR-23–FR-27" (directional per-holder view) ✔
- §4.6 FR-14 → "§4.8, FR-23–FR-27" + the "no price feed" empty-state ✔
- §14 oracle-port bullet cross-links FR-24 ✔
- §8 Q8 added and back-referenced from §4.8 and the Assumptions Index ✔

### Findings
- **medium** FR-23 has no acceptance criterion, and the leverage-pin is not test-covered (§4.8 / FR-23 vs P0 Acceptance Criteria) — the four new acceptance criteria cover FR-24, FR-25, FR-26, FR-27, but **FR-23 has none**. The "leverage field exists but is pinned to 1x in P0" is a stated product *and* safety-relevant decision (it prevents leveraged synthetic exposure in P0), yet nothing verifies the pin or the disabled terminal control. *Fix:* add a P0 acceptance criterion for FR-23 — e.g. "An attempt to open a position with leverage > 1x is rejected / the leverage control is fixed at 1x (test)" — and a check that a persisted position references an issued pair with no single-leg artifact.
- **medium** FR-27 (position↔pair reconciliation) is not wired to any success metric (§4.8 / FR-27 vs §7 SM-4) — SM-4 ("Spine + compliance integrity proven by test") enumerates FR-3, FR-5, FR-7, FR-8, FR-10, FR-19. FR-27 is the same *kind* of integrity-by-test, reconcile-and-correct guarantee as FR-10 and directly mitigates the new §15 solvency risk, but it is named in no SM. It has an acceptance criterion, so it is not untested — but the success-metric traceability is incomplete relative to its safety weight. *Fix:* extend SM-4's validated-FR list to include FR-27 (and optionally FR-25 for the atomic-pair guarantee). *(Note: FR-23/24/26 lacking SM coverage is consistent with the PRD's existing loose FR→SM mapping — e.g. FR-1/2/9/14/22 also map to no SM — so the SM gap is flagged only for the integrity-class FR-27.)*

## Shape fit — fine (n/a as a primary concern for the delta)

The PRD is a chain-top, multi-stakeholder financial-infrastructure spec; downstream usability is correctly the load-bearing dimension and the delta respects it. The §4.8 addition does not over- or under-formalize — it adds exactly the FRs needed to make the terminal honest, no persona/UJ inflation. No new UJ was added for the position layer; given UJ-5 already covers the Subscriber viewing a coupled pair, a dedicated position-view UJ would be reasonable but is not required.

No findings.

## Mechanical notes

- **ID continuity:** FR-23–FR-27 contiguous and unique, correctly following FR-22. No gaps or duplicates introduced. (The PRD's FRs remain globally-stable / non-section-sequential by design — pre-existing, not a delta issue.)
- **Glossary:** Position (synthetic), Price oracle, Mark-to-market added and used consistently. No drift detected in the new terms.
- **Assumptions Index roundtrip:** the new §8 Q8 and the "Resolved 2026-06-18" block in §9 are consistent; the Option-C / 1x-pin / oracle-in-P0 resolutions are recorded. No orphaned inline `[ASSUMPTION]` introduced by the delta.
- **Cross-refs:** all delta forward-references (§4.5→§4.8, §4.6→§4.8, §14→FR-24, §15→FR-27/FR-24) resolve.
- **Minor (low):** FR-26 specifies API money "as decimal strings" while NFR-2 prohibits binary float and FR-23 stores integer-smallest-units / `NUMERIC` / `decimal(18,8)`. These are consistent (decimal-string serialization is the correct way to avoid float at the API boundary), but a one-clause note that "decimal strings" is the *serialization* form, not storage, would remove any apparent tension with NFR-2.

---

### Findings table

| Severity | Dimension | Finding | Location |
|---|---|---|---|
| MEDIUM | Downstream usability | FR-23 has no acceptance criterion; leverage-1x pin not test-covered | §4.8 FR-23 / P0 Acceptance Criteria |
| MEDIUM | Downstream usability | FR-27 (integrity-class reconcile) wired to no success metric | §4.8 FR-27 / §7 SM-4 |
| MEDIUM | Done-ness | Position `lifecycle` field referenced but states never enumerated | §4.8 FR-23 |
| MEDIUM | Done-ness | Open-position vs. pair reset/re-anchor (D1a) interaction unspecified | §4.8 FR-23/FR-25 vs §4.2/§8 D1a |
| LOW | Mechanical | "decimal strings" (FR-26) should be marked as serialization vs NFR-2 storage | §4.8 FR-26 vs NFR-2 |

*No CRITICAL or HIGH findings. No internal contradiction found between the delta and FR-6/18/19/21, §5, §14, or D1/D1a.*
