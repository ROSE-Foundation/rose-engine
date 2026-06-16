# PRD Quality Review — ROSE Engine (2026-06-15)

## Overall verdict

This is a strong, build-ready PRD that does the hard thing well: it makes its big decisions out loud (P0 widened from SPEC.md to a live testnet/paper vertical slice; greenfield over Laplace reuse; on-chain ERC-3643 compliance pulled forward from P3+ into P0), and it ties almost every FR to a testable consequence plus an explicit P0 Acceptance Criteria block with test mappings. The thesis ("make finance digital underneath," with the coupled pair as the risk-bounded mechanism) is coherent and the features, metrics, and counter-metrics all serve it. What's at risk is minor and mechanical rather than structural: one inline `[ASSUMPTION]` (securities-law eligibility) never reaches the Assumptions Index, FR-9 lacks an explicit testable-consequences block, and intra-section FR ordering is non-monotonic. None of these block a green light.

## Decision-readiness — strong

The PRD reads as a set of decisions, not a survey. The §0 "⚠️ SPEC.md is superseded" callout states plainly that P0 now includes EVM, smart contracts, live trading, and token minting that the SPEC had pushed to P3+, and closes the ambiguity with "**this PRD governs**." The greenfield call is labelled a "load-bearing decision" and names what's given up: Laplace is "precedent and proof… it is not the codebase." Open Questions (§8) are genuinely open — the two offshore jurisdictions are "not yet identified," the claim-issuer operating model is unresolved — and they are not rhetorical. SM-1 honestly refuses to invent a fundraising target: "No numeric target or deadline is set; the board will define the go/scale threshold." A stakeholder pushing back on scope-widening, model risk, or segregation would find the tension acknowledged (§15 Risk, SM-C2, §11.3 sequencing guardrail) rather than smoothed.

## Substance over theater — strong

Little here is furniture. The Vision (§1) is specific to this product — coupled pair, delta-neutral at issuance, T+2 vs. milliseconds, "the first moment at which ROSE must not only make sense, but *work*" — and could not swap into another PRD. NFRs carry product-specific thresholds, not boilerplate: NFR-2 mandates integers in smallest units, prohibits binary float in PROD, specifies `BigInt` vs. `NUMERIC` with the int64-caps-at-9-tokens rationale, and a deterministic remainder policy to preserve `V_A+V_B=K`. The differentiation (the coupled pair / issuer-neutral invariant) is real and validated by an actual falsification exercise (§4.7), not asserted.

### Findings
- **low** Five JTBD where the rubric flags four (§2.1) — Subscriber, Investment Manager, operator/steward, board member, build engineer. This is over the nominal line, but each one drives concrete requirements (Subscriber→FR-11/14, operator→FR-9/10 reconcile, board→SM-1/2/3, engineer→§11.1 regime discipline), so it is not persona theater. *Fix:* none required; flag only so a future trim is a conscious choice, not an accident.

## Strategic coherence — strong

The PRD has a thesis and bets on it. The arc — prove the loop end-to-end *and* put the coupled-coin model on trial, cheaply, before real capital — governs prioritization: the model-validation library is throwaway-regime and built for "refutation speed," while the ledger spine is PROD and "frozen before dependent work builds on it" (FR-6). Success Metrics validate the thesis rather than measuring activity: SM-2 tests the issuer-neutral invariant, SM-3 the full lifecycle on real ticks. Counter-metrics are present and pointed (SM-C1: rebalancing must stay near zero at L=1 for EUR/USD, explicitly *not* BTC; SM-C2: don't trade spine safety for velocity). MVP scope kind is clearly problem-solving/validation and the scope logic matches.

## Done-ness clarity — strong

This is the dimension the PRD invests in most. Nearly every FR carries an explicit **Consequences (testable)** block, and the standalone **P0 Acceptance Criteria** section maps nine checkable conditions back to FRs ("An unbalanced entry is rejected by the database (test). *(FR-3)*"). Vague-adjective failures ("graceful," "reasonable," "user-friendly") are essentially absent; even surface requirements are bounded ("no hard-coded `MOCKUP` placeholder surfaces in P0," FR-14). The refuse-on-absent rule for parked parameters (FR-8, NFR-4) converts a would-be silent default into a testable behavior.

### Findings
- **low** FR-9 has no Consequences (testable) block (§4.4) — unlike every other FR, "Produce the consolidated group view" states only an output format. Its verifiability is partly carried by FR-10 and the reconcile acceptance criterion, but the asymmetry is conspicuous. *Fix:* add one consequence, e.g. "the group view sums per-entity balances to a consolidated figure that an external recomputation reproduces."
- **low** FR-20's outcome "P&L ultimately accrues to the VCC via its ownership chain" (§4.5) is weaker than its siblings in a paper/testnet context where the ownership chain is simulated. *Fix:* state the observable ledger consequence (which accounts move, in which entity) rather than the economic end-state.
- **low** NFR-7 sets no latency budget ("`[ASSUMPTION: no hard latency budget set for P0; directional]`"). Acknowledged rather than hidden, so impact is low, but a chain-top PRD feeding architecture leaves the real-time bound for someone else to invent. *Fix:* none required for P0; note that architecture must close it before hot-path work.

## Scope honesty — strong

Omissions are explicit and do real work. §5 Non-Goals and §6.2 Out of Scope each name the cut *and the reason* ("General multi-asset trading venue… *reason: P0 proves the loop + model, not a venue*"). The superseded-SPEC non-objectives are called out twice (§0, §5 note) so no reader silently assumes the old boundary. Parked parameters are de-scoped honestly with a `[NOTE FOR PM]` (§6.2) and a refuse-on-absent rule, not dropped. Open-items density is appropriately *low* for a high-stakes green-light PRD: three Open Questions, a short Assumptions Index, one NOTE FOR PM — §9 notes "most earlier ones were resolved during review and removed," consistent with the `.decision-log.md` references.

### Findings
- **medium** The inline `[ASSUMPTION: specific securities-law / marketing-restriction / "sophisticated client" eligibility rules… not detailed in inputs]` at §12 (line 381) is not represented in the §9 Assumptions Index. The two index entries cover NFR-7 and the laplace.digital marketplace-integration assumption (line 393); the securities-law assumption — arguably the most consequential open legal item for a regulated offering — has no roundtrip. *Fix:* add a §9 entry pointing to §12 securities-law/eligibility, or confirm it is owned by counsel and out of PRD scope explicitly.

## Downstream usability — strong

As a chain-top PRD this matters, and it largely delivers. The Glossary (§3) is rich and disciplined, even mapping source synonyms ("coupled coin", "coupled package", "L+S unit" → Coupled pair). FR IDs 1–20 are all present, unique, and contiguous; SM-1–4 plus SM-C1/C2 and UJ-1–5 resolve cleanly, and cross-references (FR↔UJ↔SM) are internally consistent. Each section is extractable on its own. UJs carry named protagonists (Namara, a steward, an analyst, a Rose Member).

### Findings
- **low** FR ordering is non-monotonic within sections — §4.2 runs FR-6, FR-4, FR-13; §4.3 runs FR-7, FR-8, FR-5, FR-19. §0 explains IDs are "globally stable" by design, so this is intentional, but it adds friction for a reader scanning for a given FR. *Fix:* none required given the stated convention; optionally add a one-line FR index.
- **low** UJ-3's protagonist is an abstraction ("Strategy logic attempts to move…") rather than a named actor like the other UJs. Minor; the journey is still legible. *Fix:* attribute the attempt to the Investment Manager / Trading Co. actor for parallelism.

## Shape fit — strong

The shape matches the product. For regulated, multi-stakeholder fintech that is chain-top, UJs with named protagonists are load-bearing and present; constraint traceability is non-negotiable and delivered — the Model-A bright line is defined in the Glossary, enforced off-chain (FR-8) and on-chain (FR-19), reconciled (FR-10/NFR-9), and risk-mitigated (§15). The dual audience (board + build teams) is handled structurally by keeping "what/why" in the PRD and pushing "how" (stack, trigger vs. deferrable-constraint options, repo layout, coupled-coin math) into `addendum.md`. Neither over-formalized nor under-formalized.

## Mechanical notes

- **Assumptions Index roundtrip:** one gap — the §12 securities-law `[ASSUMPTION]` (line 381) is not in the §9 index (see Scope honesty, medium). The other inline assumptions (NFR-7 line 355; §14 marketplace line 393) do roundtrip.
- **ID continuity:** FR-1…FR-20 complete, unique, no gaps or duplicates; SM and UJ IDs resolve. Only issue is intra-section ordering (see Downstream, low).
- **Glossary drift:** terms are used consistently; synonym mapping is handled in §3. Minor: "treasury" is used in FR-8 / UJ-3 as a transfer destination but is not a defined Glossary term or one of the five typed accounts (`BACKING_FLOAT`, `DEPLOYED_CAPITAL`, `CLIENT_COLLATERAL`, `FEE_INCOME`, `NOTE_LIABILITY`); a reader must infer which account/entity "treasury" denotes. *Fix:* define "treasury" or map it to a typed account/entity. Likewise "Covenant Console" (§4.6) is a surface name not in the Glossary — low impact.
- **Cross-refs:** PRD↔addendum references (§0, NFR-2, §4.7) resolve; addendum sections A–I are coherent with PRD decisions.
- **Required sections:** all expected sections for the agreed stakes/product type are present (Vision, Users/JTBD, Glossary, Features/FRs, Non-Goals, MVP scope, SMs, Open Questions, Assumptions, NFRs, Constraints, Regulatory, Risks, Stakeholders, Roadmap, Acceptance Criteria).
