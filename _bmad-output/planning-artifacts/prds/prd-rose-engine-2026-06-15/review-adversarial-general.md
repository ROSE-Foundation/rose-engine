# Adversarial Review — ROSE Engine PRD (2026-06-15)

**Reviewer stance:** Cynical, skeptical, hostile to hand-waving. Goal: find what is over-claimed, unfalsifiable, internally contradictory, or smoothed-over.

**Overall verdict:** This is a well-written PRD that uses fluent, confident prose to paper over a fundamental scope incoherence and several undefined load-bearing parameters. The single biggest problem is the term **"live vertical slice"**: it is rhetorically doing the work of "we shipped something real" while every value-bearing component is testnet or paper. The second biggest problem is that the coupled-coin model — the entire thesis — is "validated" by a throwaway simulator using undefined floor parameters (`m`, `g`) and never confronts what happens economically *after* a reset to the losing holder. The PRD is honest in patches (it admits "no real capital" repeatedly) but the framing and success metrics are engineered to be passable rather than falsifiable. P0 is six hard systems wearing a trenchcoat labeled "MVP."

---

## CRITICAL findings

### C-1. "Live vertical slice" is a rhetorical sleight-of-hand
**Location:** §0, §1, §6, §6.1, SM-1, P0 Acceptance Criteria.

The PRD repeats "live in code" and "the code paths are real; the funds are test funds" like an incantation. But "live" in finance means *exposed to real consequences*. Here: Sepolia testnet (free, valueless tokens, no real custody/AML/settlement risk), paper execution (no real CEX, no slippage, no counterparty, no fill risk, no real price feed — "an example tick file suffices"), no real subscribers (curated allowlist of test identities), no real capital. **Every single thing that makes this domain hard and regulated is stubbed out.** What remains "live" is: a Postgres ledger, a Hardhat/Foundry deploy to a testnet, and a simulator reading a CSV. That is a *prototype* or *end-to-end integration demo*, not a "live vertical slice."

The danger is not pedantic. Stakeholders/board (an explicit audience, §0) will read "live, proves the whole loop end-to-end" and conclude the riskiest questions are answered. They are not. Paper execution proves *nothing* about the model under real volatility, slippage at reset, liquidity at the barrier, or whether a real CEX will even fill the rebalancing trade at the locked price. The model's entire claim ("risk-bounded," §18) lives precisely in the gap between paper and real — and P0 by construction never tests it.

**What would refute/fix:** Rename to "P0 Integration Prototype (testnet + paper)." State explicitly, in the Vision and SM-1, the list of risks P0 does NOT retire (slippage/fill at reset, real-venue liquidity, custody/AML, real subscriber onboarding, mainnet gas/MEV, real price-feed latency). If the team insists on "live," define a falsifiable bar for the word.

### C-2. The coupled-coin model's reset economics are never specified — the thesis has a hole
**Location:** §4.2, §4.7, FR-16, FR-17, addendum §D; Glossary "Floor (f)", "Anchor price".

The PRD asserts the model is "delta-neutral at issuance" and "issuer-neutral" (V_A+V_B=K), validated by proving no leg goes negative within the barrier. Fine — but that is the *easy, algebraically trivial* part. `V_A=(K/2)(1+L·r)`, `V_B=(K/2)(1−L·r)`; their sum is `K` by construction, for all prices, by elementary algebra. **Proving V_A+V_B=K is not validating the model; it is validating arithmetic.** SM-2 dresses up a tautology as a finding.

The actually hard question — what the PRD smooths into neutrality — is **what happens at and after a reset**:
- FR-16/FR-17 say "the losing holder's loss is locked" and "re-anchor P₀ to current price." But the PRD never says **who bears that locked loss, where it goes on the ledger, or what the losing holder now holds.** A short-leg holder whose leg decayed toward the floor has their loss crystallized — is their position topped back up to K/2 (by whom, with whose capital?), or do they continue with a smaller notional? "Issuer-neutral" (issuer net = 0) is being conflated with "holders are made whole," which is false: in a zero-sum coupled pair the issuer being flat means **one holder's locked loss is the other holder's locked gain.** The "delta-neutral, risk-bounded" language obscures that the *holders* carry concentrated directional risk and a path-dependent loss at every reset.
- This is the leveraged-ETF decay problem the PRD claims to avoid by going "threshold-only." But threshold-only rebalancing does not eliminate path dependency; it changes its shape. A whipsawing market that repeatedly grazes the floor will repeatedly lock losses and re-anchor — that *is* decay, just event-triggered instead of clock-triggered. The PRD asserts the trap is avoided ("never on a clock — the trap to avoid") without showing it.

**What would refute/fix:** Add an FR specifying the reset accounting: the exact journal entry at reset, which account absorbs the locked loss, what the losing holder's post-reset position is, and the counterparty of the locked gain. Add a counter-metric on *cumulative holder loss across a whipsaw tick set*, not just "no leg went negative." Until reset economics are specified, SM-2/SM-3 validate algebra and lifecycle plumbing, not the financial thesis.

### C-3. Floor parameters `m` and `g` are undefined — the one number that matters is missing
**Location:** addendum §D (`floor f = m · L · g`), Glossary "Floor (f)", FR-16, SM-C1.

The floor `f` is the trigger for every reset, and the entire claim "EUR/USD barrier ~never hit, BTC stress-tests" rides on it. Yet `f = m·L·g` where **`g` = "worst plausible gap over the reaction window"** and **`m` = "safety margin"** are both undefined. "Worst plausible gap" is a modeling judgment call worth potentially the whole result — set `g` loosely and EUR/USD never resets (SM-C1 "passes") trivially; set it tightly and even EUR/USD churns. **SM-C1 ("reset rate near zero for EUR/USD") is therefore unfalsifiable as written: the team picks `m` and `g`, then observes the reset rate those choices produce.** It is a metric whose outcome is chosen before the experiment.

**What would refute/fix:** Define `g` (e.g., max observed N-second EUR/USD gap over a named historical window) and `m` as concrete, pre-registered values *before* running the sim. Pre-commit the EUR/USD reset-rate threshold that counts as failure. Otherwise SM-C1 is theater.

### C-4. Ledger-vs-chain "source of truth" conflict is unresolved — reconciliation is a detector, not a resolver
**Location:** §1, §4.1, §4.4, FR-10, NFR-9, UJ-2.

The PRD repeatedly says the off-chain ledger is the "accounting source of truth" *and* that the chain "enforces transfer rules" and "is where the regulated instrument lives." FR-10/NFR-9 promise reconciliation "detects and reports" divergence. **Nowhere does it say who wins on conflict, or what the resolution procedure is.** This is the classic distributed-systems lie of omission: "we'll detect drift" is not a design; it's a hope plus an alert.

Concretely: an ERC-3643 compliance module *rejects* a token transfer on-chain, but the off-chain ledger already posted (or vice versa). Now ledger token-quantity ≠ on-chain balance. The "source of truth" is the ledger — but the *regulated instrument* and the *legally enforceable transfer* live on-chain. If the books say a holder owns the token and the chain says they don't, **which is legally true?** The chain. So the ledger is *not* the source of truth for token ownership; it's the source of truth for fiat accounting only — but the PRD flattens these into one "source of truth" claim. The hybrid ledger (value + quantity) makes this worse: the quantity dimension is *necessarily* subordinate to chain reality, contradicting "ledger is source of truth."

**What would refute/fix:** State the conflict-resolution rule explicitly per data dimension: chain is authoritative for token ownership/transfer legality; ledger is authoritative for fiat/value accounting; reconciliation defines a *repair* procedure (which side is corrected, by whom, with what journal entry) — not just a flag. Add an acceptance criterion that exercises *resolution*, not just *detection*.

---

## HIGH findings

### H-1. P0 is six hard systems disguised as one MVP — scope is not credible
**Location:** §6.1 (the in-scope list), §0.

In-scope for a "near-term P0" MVP: (1) a multi-entity database-enforced double-entry ledger; (2) a coupled-pair contract + lifecycle state machine; (3) an off-chain default-deny authorization chokepoint; (4) a full ERC-3643/T-REX on-chain stack (token contracts, ONCHAINID registry, trusted claim issuer, compliance modules, allowlist); (5) on-chain↔off-chain rule mirroring kept "in lockstep"; (6) live subscription/redemption + paired minting; (7) paper strategy execution; (8) ledger↔chain reconciliation; (9) four fully-functional UI surfaces ("no mockups"); (10) a throwaway model library + simulator. Across **TypeScript + Rust/Go + Solidity + Postgres**, spanning a four-entity / two-offshore-jurisdiction legal structure.

This is a 12–24 month effort for a competent team, branded "P0." The PRD even admits it widened scope "during this PRD's review" and supersedes its own SPEC's deliberately minimal P0 (which was off-chain only, no EVM, no minting, no execution). **The SPEC authors scoped P0 down for a reason; this PRD scoped it back up in a review meeting without re-justifying feasibility.** That is scope creep dressed as ambition, and §15's "scope creep" risk ironically only guards against creeping into a *trading venue* — not against the PRD's own creep from "ledger spine" to "everything at once."

The "no mockups, all four surfaces functional" decision (§4.6, FR-14) is gratuitous gold-plating for a model-validation milestone — UI does not validate the coupled-coin thesis and competes for the same engineering hours.

**What would refute/fix:** Either (a) re-justify the widened scope with a staffing/timeline estimate and an explicit risk acceptance, or (b) restore SPEC's lean P0 and push on-chain/execution/UI to P0.5/P1. At minimum, drop "all surfaces functional, no mockups" — make surfaces follow the validated spine, not lead it.

### H-2. SM-1 is unfalsifiable activity theater
**Location:** SM-1, Open Q 1, §16.

SM-1: "Subscription capability proven end-to-end (testnet/paper)... **No numeric target or deadline is set; the board will define the go/scale threshold.**" A success metric with no target, no deadline, no real capital, and no quantity is not a metric — it's a checkbox that reads "the demo ran." It cannot fail except by the code not executing at all. It tells the board nothing about whether ROSE can *actually* raise or deploy capital, which is the only question §13 says matters ("must work and generate surplus before downstream domains can be funded"). The real go/no-go decision is explicitly deferred to an undefined future board threshold — so P0's headline metric is structurally incapable of informing the decision it exists to inform.

**What would refute/fix:** Convert SM-1 to a falsifiable integration assertion ("a subscription produces N balanced entries + a reconciling Sepolia mint within T seconds, replayable") and *stop calling it a success metric for the business thesis* — it's a plumbing-works check. Move the real-capital readiness question into an explicit, separate gated milestone with criteria.

### H-3. ERC-3643 "no self-service KYC, but eligibility allowlist" is partly a dodge
**Location:** §2.2, §5, Glossary "Allowlist", "Claim issuer", §12 assumption tag.

The PRD leans hard on "no self-service KYC product flow" as a scope *reduction*. But ERC-3643 by definition requires identity-verified holders (ONCHAINID claims). Someone must KYC the allowlist members and a "ROSE-operated trusted issuer" must issue claims. **The KYC work doesn't disappear; it moves off-screen and becomes manual/curated.** Calling this a non-goal understates the operational and regulatory burden: the §12 assumption tag admits the actual "sophisticated client" eligibility rules "are not detailed in inputs" and are "for legal counsel." So the eligibility criteria — the substantive content of the allowlist — are undefined, while the PRD presents the allowlist as a clean simplification. For *testnet* P0 the claim issuer can be a stub, which is fine — but then it proves nothing about real eligibility/compliance, undercutting the "regulated instrument, on-chain compliance enforced" selling point (FR-19, §12). The distinction "allowlist not KYC funnel" is real as a *product* statement but is being used to obscure that the regulated-onboarding problem is entirely unsolved, not reduced.

**What would refute/fix:** State plainly that the allowlist defers, not removes, KYC/eligibility, and that P0's testnet claim issuer validates *mechanism* (transfer rejection for missing claims) not *eligibility policy*. Don't list it under "scope reductions" without that caveat.

### H-4. "On-chain and off-chain rules in lockstep" is asserted, not designed
**Location:** §4.3, FR-19, NFR-4/NFR-8, addendum §C.

The PRD promises the off-chain `flow_permissions` table and the on-chain ERC-3643 compliance modules encode "the same rule set," kept "in lockstep," "no rule enforced on one side and silently absent on the other." This is two separate rule engines in two languages (TS reading a SQL table; Solidity compliance modules) with two deployment lifecycles. **Keeping them provably equivalent is a hard, ongoing problem the PRD waves at with the word "lockstep."** There is no single source of rule definition, no codegen, no shared spec — just an aspiration and an acceptance test that checks one mismatch case. Drift between the two is near-inevitable and the PRD has no mechanism to prevent it, only FR-10 to *detect a quantity mismatch after the fact* (which is balance drift, not *rule* drift — a rule present off-chain but missing on-chain may never surface as a quantity mismatch until the missing rule should have fired).

**What would refute/fix:** Specify a single canonical rule definition that *generates or tests* both sides, or accept divergence explicitly and define which side governs. Add a test that asserts rule-set *equivalence*, not just one example mismatch.

---

## MEDIUM findings

### M-1. "Issuer-neutral" / "delta-neutral" overclaim
**Location:** §1, §4.2, FR-12, Glossary.

"Delta-neutral at issuance" is true only at the instant of issuance and only at the *pair* level; the moment price moves, the legs are not neutral and the *holders* are directionally exposed. The PRD uses "delta-neutral" and "risk-bounded" (§18) loosely enough that a board member could believe the *instrument* carries no directional risk. The risk is merely relocated from issuer to holders. See C-2.

**Fix:** Qualify every "delta-neutral" with "at issuance, at pair level; holders are directionally exposed."

### M-2. BTC stress test is rigged to be unfalsifiable in the other direction
**Location:** §4.7 Notes, SM-3, SM-C1.

EUR/USD: resets expected ~never (high reset = failure). BTC: resets expected (high reset = *not* failure, "deliberate stress test"). So whatever the simulator does, it confirms the model: EUR/USD quiet = good; BTC noisy = "expected stress." **There is no simulator outcome that the PRD would interpret as the model failing.** A theory that cannot fail its own test isn't being tested. What's the BTC result that *would* count as refutation? Unstated. (If "no leg goes negative" is the only real bar, that's algebra again — legs can't go negative inside the barrier by construction; resets prevent breaching it.)

**Fix:** Pre-register the BTC failure condition (e.g., cumulative holder loss > X%, or reset frequency so high the spread/cost makes the product non-viable). Define what BTC behavior kills the product.

### M-3. Polyglot stack (TS + Rust/Go + Solidity) at P0 is premature and unjustified for the milestone
**Location:** §4.5, NFR-7, addendum §A.

Rust/Go "performance hot paths" are listed as P0-relevant while §6.2 simultaneously says high-frequency/large-scale execution is *out* of P0 and execution is paper/small-scale. If execution is paper and small-scale, **there is no P0 performance requirement justifying Rust/Go** — NFR-7 even admits "no hard latency budget set for P0." Introducing a second/third systems language for a milestone with no perf requirement adds integration surface and hiring/staffing cost for zero P0 benefit. This is architecture-astronautics.

**Fix:** Defer Rust/Go to the phase that actually has a latency budget. P0 in TS + Solidity only.

### M-4. "Database guarantees integrity" oversold; trigger-based balance is not bulletproof
**Location:** §4.1, FR-3, NFR-1, addendum §B.

"Integrity guaranteed by the database, not application discipline" is repeated as a near-magical property. The proposed mechanisms (AFTER trigger or DEFERRABLE constraint, §B) are real but have well-known holes: triggers can be disabled by superusers, bypassed by `COPY`/bulk paths, constraint timing depends on transaction discipline, and "Σ debits = Σ credits per entry" does not prevent *posting to the wrong account*, sign errors, or a balanced-but-fraudulent entry. The DB enforces *balance*, a narrow invariant, not *integrity*. The PRD conflates the two.

**Fix:** Scope the claim to "the DB enforces per-entry balance"; don't generalize to "integrity." Note the bypass vectors and how they're closed (role restrictions, no direct posting writes).

### M-5. Reconciliation has no defined frequency, latency, or drift tolerance
**Location:** §4.4, FR-9/FR-10, NFR-9.

`reconcile` is an on-demand command an operator runs "before sign-off." On a system promising "real-time," "continuous" operation (§1, NFR-7), point-in-time manual reconciliation means ledger and chain can be silently divergent for arbitrary windows between runs. No max-drift-window, no automated cadence, no alerting threshold defined.

**Fix:** Define reconciliation cadence and max tolerable drift window; reconcile that against the "real-time" claim.

### M-6. Four fixed entities / two TBD offshore jurisdictions baked into P0 schema
**Location:** §3 Glossary "Entity", FR-1, §12, Open Q 2.

P0 hard-codes four entities (`VCC`, `HOLDING`, `TRADING_CO`, `ISSUER_EXCHANGE`) and "no dynamic entity creation," while §12/Open Q 2 admit the two offshore jurisdictions for two of those very entities are **not yet identified.** Hard-coding a legal structure whose jurisdictions (and therefore whose regulatory/segregation rules, account types, tax treatment) are undecided risks baking wrong assumptions into the ledger schema — the very "inter-track contract" the PRD says must be "frozen before dependent work builds on it" (FR-6). Freezing a contract on top of undecided legal facts is freezing the wrong thing.

**Fix:** Confirm whether jurisdiction choice affects entity/account modeling; if so, don't freeze the contract until §8 Q2 resolves, or make entity config data-driven rather than fixed.

---

## LOW findings

### L-1. Self-superseding SPEC creates a governance smell
**Location:** §0 warning block, §5 note, addendum §A/C/D.

A PRD that explicitly overrides its own source engineering spec on the *most consequential* axes (on-chain, minting, execution all moved into P0) — and instructs "SPEC.md must be updated to match this PRD" — inverts the normal flow where the spec constrains the PRD. It's documented honestly, but it means two source-of-truth documents now disagree until someone does the SPEC edit, and downstream readers may grab the stale SPEC. Risk of confusion.

**Fix:** Update SPEC.md immediately or mark it superseded at its top; don't leave two conflicting P0 definitions live.

### L-2. "Throwaway validates the thesis, then is thrown away" is a contradiction in trust
**Location:** §4.7, §11.1, SM-2/SM-3, SM-C2.

The model — the make-or-break thesis (§2.1 "make-or-break confidence call") — is validated entirely by *throwaway* code explicitly "optimized for refutation speed," "in-memory, no database, no auth," that "must never be a production dependency." So the board's confidence to deploy real capital rests on code the PRD says is disposable and not production-grade. If the throwaway sim has a bug, the "validation" is worthless, and by design none of its rigor carries into PROD. The two-regime discipline is sound for *isolation*, but using throwaway code as the *evidentiary basis* for a capital-deployment decision is a tension the PRD doesn't acknowledge.

**Fix:** Require the model-validation results to be independently reproduced / the sim's correctness itself tested, before SM-2/SM-3 count as board evidence.

### L-3. Glossary forbids synonyms but the docs use several
**Location:** §3 ("Synonyms anywhere in the PRD are a discipline violation"), e.g. "issuer-neutral" vs "delta-neutral" vs "market-neutral" (FR-12) used near-interchangeably; "barrier" vs "floor" vs "anchor" cluster.

The PRD declares a zero-synonym discipline and then uses "delta-neutral," "issuer-neutral," "market-neutral," and "issuer net = 0" for overlapping-but-not-identical concepts (see C-2/M-1 — they are NOT identical). Self-inflicted discipline violation that also masks a real conceptual conflation.

**Fix:** Define each precisely in the glossary and stop using them interchangeably.

---

## Summary table

| ID | Severity | One-line |
|----|----------|----------|
| C-1 | Critical | "Live vertical slice" overclaims; everything risky is testnet/paper |
| C-2 | Critical | Reset economics / who bears the locked loss is unspecified — thesis hole |
| C-3 | Critical | Floor params `m`, `g` undefined → SM-C1 unfalsifiable |
| C-4 | Critical | Ledger-vs-chain "source of truth" conflict unresolved; reconcile only detects |
| H-1 | High | Six hard systems branded as one P0 MVP; scope not credible |
| H-2 | High | SM-1 has no target/deadline → activity theater |
| H-3 | High | Allowlist "not KYC" defers rather than removes the regulated-onboarding problem |
| H-4 | High | On-chain/off-chain "lockstep" asserted, no mechanism to enforce equivalence |
| M-1 | Medium | "Delta-neutral" overclaim (only at issuance, pair-level; holders exposed) |
| M-2 | Medium | BTC stress test has no defined failure condition → model can't fail its test |
| M-3 | Medium | Rust/Go at P0 unjustified (no P0 latency budget; execution is paper) |
| M-4 | Medium | "DB guarantees integrity" oversold — it guarantees balance, not integrity |
| M-5 | Medium | Reconciliation cadence/drift-window undefined vs "real-time" claim |
| M-6 | Medium | Fixed entities frozen on top of TBD jurisdictions |
| L-1 | Low | PRD supersedes its own SPEC; two live conflicting P0 definitions |
| L-2 | Low | Throwaway code is the evidentiary basis for a capital decision |
| L-3 | Low | Zero-synonym discipline violated by the PRD itself, masking C-2/M-1 |
