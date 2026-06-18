# Adversarial Domain Review — §4.8 Secondary-Trading Position Layer (FR-23…FR-27)

**Reviewer role:** Adversarial domain reviewer — regulated finance, ERC-3643 / T-REX, derivatives & position accounting, exchange/venue failure modes.
**Target:** PRD `prd-rose-engine-2026-06-15/prd.md`, new §4.8 (FR-23…FR-27) and supporting sections.
**Context input:** `sprint-change-proposal-2026-06-18.md` (Option C rationale).
**Date:** 2026-06-18.

---

## Verdict

The atomic-coupling invariant is genuinely preserved **at the token/custody layer** — Option C does not introduce a single-leg on-chain artifact, and that part is sound. **But the review finds that §4.8, as written, pushes the system's *economic* solvency model into an undecided corner (§8 Q8) and treats that decision as a mere "mechanism" for architecture.** It is not. The choice of how a per-user directional position is assigned over an atomic pair *is* the choice between Option A (matching) and Option B (house warehouses inventory) — the two options Option C claimed to avoid. Combined with the D1a "crystallised & withdrawable" decision and conditional issuer-neutrality, there are concrete paths to an operator-level shortfall — i.e. the Lykke failure mode is currently **name-checked, not structurally closed**. The invariant protects the chain; it does not by itself protect solvency, and §4.8 currently leans on the invariant as if it did.

**Recommendation:** Do not treat §4.8 as "additive, no rework." Resolve the assignment/solvency model in the PRD (not defer to architecture), tighten FR-27 from an aggregate-notional cap to a per-pair/per-side residual-backing invariant, add an explicit reset-boundary requirement for positions, and flag the derivative/CFD regulatory characterization to counsel in §12.

---

## Findings

| # | Severity | Section ref | Finding (one line) | Remediation |
|---|----------|-------------|--------------------|-------------|
| 1 | **CRITICAL** | §4.8 / §8 Q8 / FR-25 | The deferred "claim/assignment semantics" is the hidden choice between Option A (matching) and Option B (house inventory) — i.e. a solvency-model decision, not a mechanism detail. | Resolve in the PRD: state who holds the counterparty leg when a user opens a one-sided position. If the house warehouses it, declare the inventory/solvency risk explicitly and bound it; if it requires a matching short, acknowledge that re-introduces Option A. Tag §8 Q8 "solvency-determining; product-safety sign-off required." |
| 2 | **CRITICAL** | §4.8 FR-25 / FR-21 | Independent close of one directional position is incompatible with whole-package atomic burn when the counterparty leg belongs to a *different* user — FR-25 routes FR-21, which burns both legs. | Specify how a single holder closes without burning the counterparty's leg: either novate/re-assign the counterparty leg, hold an inventory buffer, or net against an opposing close. Add a testable consequence covering "close one side while the other side is held by another user." |
| 3 | **CRITICAL** | §4.8 FR-27 | "Aggregate position notional never exceeds issued pair notional" is too coarse: it nets across pairs and across L/S sides, and uses *issued* notional, not the *residual* pool after D1a resets/withdrawals — permitting synthetic over-exposure. | Re-state FR-27 as a **per-pair, per-side** invariant against **current residual backing** (post-reset, post-withdrawal pool K), not aggregate issued notional. Add a testable consequence: assigned exposure on side X of pair P ≤ backing available to side X of pair P after settlement. |
| 4 | **HIGH** | §4.2 / §4.8 FR-23, FR-24 | No requirement describes what happens to a position's entry / mark / unrealized P&L at a D1/D1a **reset settlement boundary** (re-anchor of P₀, unrealized→realized crystallisation, withdrawable-cash movement, mark consistency). | Add an FR (or a testable consequence on FR-23/FR-24): at each reset, the position crystallises realized P&L, re-anchors `entry` to the new P₀, and the mark service computes against post-reset params so P&L is neither double-counted nor silently reset. Reconcile the position's realized P&L to the settlement journal entry (§4.2 note). |
| 5 | **HIGH** | §12 / §4.8 | A per-user directional position with entry/mark/P&L, a "max loss," a (disabled) leverage selector, and **withdrawable crystallised cash** is economically a CFD / synthetic-derivative product; §12 is silent on it and it is not flagged for counsel — the regulatory posture may shift even on testnet/paper. | Add a §12 paragraph and a §9 `[ASSUMPTION]` flagging that the synthetic position layer may constitute a derivative/CFD-like offering with its own licensing/characterization implications (distinct from ERC-3643 token distribution), and route to counsel before any real-capital secondary market. |
| 6 | **HIGH** | §15 / §4.8 | The Lykke (collapsed-exchange) lesson is name-checked as a "review input," but the concrete shortfall path — off-chain position ledger promising D1a withdrawable P&L while conditional issuer-neutrality breaks on a floor-gap (§15 key model risk) — is not structurally addressed. | Add a mitigation requirement: define the operator-shortfall scenario (positions claim more withdrawable value than residual pools back after a gap), require the position layer to gate withdrawals on reconciled residual backing, and make this a hard pre-condition (not just a "named input") for the board-gated real secondary market. |
| 7 | **MEDIUM** | §4.8 FR-24 | Oracle integrity is under-specified for a regulated mark: only *absent* feed is handled. No staleness/heartbeat bound, no source provenance/audit, no required consistency between the oracle reference price and the price driving the pair's own reset/floor logic. | Extend FR-24: require a max-staleness bound (stale ≠ absent; surface a distinct stale state), provenance/audit logging of the price series (operator-supplied CSV is an integrity surface), and a consistency check that the mark price and the pair-mechanics price agree (or document the divergence). Even with a CSV adapter, the **port contract** set in P0 should encode these. |
| 8 | **MEDIUM** | §4.8 FR-27 | "Correct toward chain" is correct for token *ownership*, but applied to a user's *position* it is a forced deleverage/liquidation of an economic claim — not a bookkeeping correction — with undefined semantics and no holder notice. | Distinguish in FR-27 between (a) ownership reconciliation (correct ledger to chain) and (b) position-cap enforcement (a deliberate, journaled liquidation/deleverage event with defined ordering and audit), so a user's recorded claim is never silently rewritten. |
| 9 | **MEDIUM** | §4.8 FR-23 / FR-27 / §17 | The `leverage` field is modelled for >1x later, but FR-27's bound is on *notional* and is not re-validated for leverage; at >1x notional exceeds collateral, so a notional cap no longer equals a backing cap. | Note in FR-23/§17 that un-pinning leverage requires re-deriving the FR-27 invariant against **collateralized backing**, not notional, plus a fresh solvency review — so the 1x→>1x flip is a gated change, not a config flip (consistent with §11.3). |
| 10 | **LOW** | §4.6 / §4.8 | Perp-terminal framing ("buy a naked long," "max loss," leverage selector) risks presenting a synthetic claim as a venue order, overstating what the product is. | Keep the honest-data discipline already in FR-24/FR-26 and add a UI requirement that the synthetic, claim-over-issued-pair nature is surfaced (not a CLOB order), reinforcing the §5 non-goal. |

---

## Detail by hunt area

### 1. Solvency / synthetic-exposure risk

The headline weakness is that **Option C's safety claim rests on the on-chain invariant, but solvency lives off-chain.** The change proposal (§3) sells Option C as avoiding Option A's matching engine and Option B's "MM capital + inventory risk." But D1 fixes that L and S are held **separately and directionally**. When a user opens a one-sided directional position over an atomically-minted pair, *something* must hold the opposite leg:

- If the **house/issuer** holds the unassigned leg, the house is running directional inventory — exactly Option B's risk, re-imported under a different name.
- If opening requires a **matching opposite user**, that is order-book matching — Option A, explicitly rejected.

The PRD defers this to §8 Q8 "for architecture" and frames it as a mechanism. It is not; it determines the solvency profile of the whole layer. (Finding 1.)

FR-27's bound — *aggregate position notional never exceeds issued pair notional* — is **insufficient** (Finding 3) because:

- It nets across pairs and across the L/S sides. Each issued pair has exactly one L and one S leg; a per-pair/per-side cap is the only meaningful solvency invariant. An aggregate sum can pass while one pair is double-assigned and another is empty.
- It uses **issued** notional. Under D1a, each reset crystallises the winner's gain as **withdrawable cash** and re-bases both legs to the residual pool. After withdrawals the actual backing K shrinks below issued notional. A cap pinned to *issued* notional therefore permits positions that exceed the *residual* backing — a textbook synthetic-over-promise.

Independent close is a second structural hole (Finding 2): FR-25 says closing "routes the real redeem/burn path (FR-21)," and FR-21 burns the **whole package**. If the long and short of a pair are held by two different users (the D1 model), one user cannot close without burning the other's leg. The close path is undefined for the very topology D1 mandates.

**Lykke:** the failure was an operator that could not honour the liabilities its book showed. The combination here — an off-chain book showing withdrawable P&L (D1a) + conditional issuer-neutrality that can break on a gap (§15) + a coarse notional cap — reproduces the precondition for that failure. §15 mitigates it only by declaring Lykke a "named review input." That is not a control. (Finding 6.)

### 2. D1 / D1a interaction

§4.2 establishes that each reset is a **settlement boundary** (cash movement + settlement journal entry), entry re-anchors to the new P₀, and legs re-base symmetrically. §4.8 adds a position with `entry = anchor P₀` and realized/unrealized P&L, and a mark service that computes from "real pair parameters (`legsAtPrice` / floor / distance-to-floor)." **There is no requirement tying the position's lifecycle to the reset boundary.** Concretely: if the mark service reads *live* pair params (post-reset P₀) while the position still stores the *pre-reset* `entry`, the computed P&L is wrong — it spans a settlement boundary that has already crystallised. There must be an explicit reset hook on the position (crystallise realized P&L, re-anchor entry, reconcile to the settlement journal entry). This is a missing requirement, not an implementation detail. (Finding 4.)

### 3. Oracle integrity

FR-24's "never fabricate marks" and substitutable port are necessary but not sufficient for a regulated mark. The spec handles only the *absent* feed. It is silent on **staleness** (a stale price presented as live is worse than an honest empty-state), on **provenance/audit** of an operator-supplied CSV that drives user-visible P&L, and on **consistency** between the oracle's reference price and the price that drives the pair's own floor/reset mechanics. If those two prices can diverge, marks and resets are computed on different truths — a quiet path to inconsistency. Even though P0 is CSV/testnet, the **port contract is defined now**; the integrity requirements should be encoded now. (Finding 7.)

### 4. Regulatory framing

§12 still describes only the ERC-3643 security tokens and the fund structure; it does not mention the position layer at all. A product that lets a user take a **directional** position with **entry/mark/P&L**, a **max-loss**, a **leverage** control (even disabled), and **withdrawable crystallised cash** has the economic signature of a CFD / synthetic derivative — a different regulatory characterization from holding a permissioned security token. Even on testnet/paper, the PRD should flag this to counsel (the disabled-but-modelled leverage field signals forward intent, which counsel will read as such). The existing §12 `[ASSUMPTION]` is about token *distribution* eligibility, not about offering a derivative product. (Finding 5.)

### 5. Invariant leakage

There is no leakage at the **token** layer — the mint/burn stays atomic and a single-leg artifact remains unrepresentable; that is the genuine strength of Option C. **But the product deliberately synthesizes single-leg *economic* exposure** (a user holding only the long is economically naked-long). That is the intent, and it is defensible — provided the PRD is explicit that the "no naked single leg" property is now a **custodial/technical** property, not an economic one, and that solvency must be controlled separately (Findings 1, 3, 6). The current text leans on the invariant as though it also guaranteed economic balance; it does not. The single sharpest sentence to add to §4.8: *"The atomic-coupling invariant protects the chain and custody; it does not by itself bound net directional exposure or operator solvency — those are bounded by FR-27 and the assignment model (§8 Q8), which must be resolved with a solvency analysis."*

---

## What is already handled well (for balance)

- On-chain contracts are genuinely untouched; no re-audit is a correct call, and the no-single-leg-mint/burn ACs (FR-25, P0 acceptance) are testable and right.
- The oracle-as-read-only-port / never-a-writer-of-postings framing (FR-24) is the correct boundary.
- Keeping P0 on CSV/testnet and the §11.3 "no config-flip to real money" guardrail correctly de-risk P0 itself; most findings above bite hardest at the **board-gated real-capital step**, which is the right place to force them — but the PRD should *name* them as gating pre-conditions now, not discover them later.

---

*File: `/Users/croiseaux/devel/ROSE/rose-engine/_bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/review-domain-finance-2026-06-18.md`*
