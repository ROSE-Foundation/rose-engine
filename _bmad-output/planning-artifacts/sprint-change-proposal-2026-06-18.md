# Sprint Change Proposal — ROSE Engine: Off-Chain Secondary-Trading Position Layer (Resolution Option C)

**Type:** BMad Correct Course (significant change during execution)
**Date raised:** 2026-06-18
**Anchor decision:** Resolution **Option C** — off-chain synthetic position layer; on-chain stays atomic-pair issuance; the atomic-coupling invariant is preserved; no contract redefinition.
**Source analysis:** `_bmad-output/implementation-artifacts/correct-course-exchange-trading.md`
**Companion (already shipped):** `_bmad-output/implementation-artifacts/spec-exchange-terminal.md`

---

## 1. Issue Summary

**What triggered it.** The mock-faithful redesign program (spec #5, the Exchange terminal) surfaced a hard conflict between the design mock and ROSE's core safety property. `docs/mocks/exchange.html` is a perp-style trading terminal where a user buys a **naked LONG or naked SHORT leg**, picks **leverage**, and sees a **live mark price, entry price, per-position P&L, and max loss**, with a **per-user positions table** (size / entry / mark / P&L / collateral).

**Why that is a problem.** ROSE's safety invariant is that the long (L) and short (S) legs are **only ever minted/burned as an atomic pair** — a single leg is unrepresentable on-chain and off-chain. This is enforced by:

- **FR-19** (on-chain compliance: pair coupling) and **FR-18 / FR-21** (paired mint / whole-package burn) in the PRD;
- **Epic 4, Story 4-3** ("Enforce pair coupling on-chain — atomic paired mint/burn, single-leg impossible") and **Story 4-4** (Model-A bright line + principal/yield distinction on-chain);
- the coupled-pair schema (**FR-6 / Epic 2, Story 2.1**) which "cannot represent a persistent single-leg pair."

A "buy a naked long" order cannot be honored without either breaking this invariant or introducing a counterparty mechanism. The contracts are deployed/tested and audit-shaped toward Sepolia, so changing the invariant is a **product-safety decision**, not an implementation tweak (CLAUDE.md §8 forbids changing core functionality to fit a UI).

**How it was discovered.** During spec #5 build (`spec-exchange-terminal.md`), the team built the 3-column terminal **honestly adapted** to the real coupled-package model: market list from the live `coupledCoinBook`, real derived leg-token symbols, an order ticket wired to the **real subscribe/redeem coupled-package flow**, and an open-positions table of **real coupled pairs** marked from real params. Crucially, every price-oracle-dependent element (price chart, live mark, 24h hi/lo/OI, live P&L) was rendered as an **explicit empty-state**, never fabricated.

**Evidence.** Three capabilities the mock requires do **not** exist today:

1. **No per-user position model.** The ledger tracks the *issuer's* coupled pairs and double-entry balances (FR-1/FR-2/FR-6/FR-13); there is no per-user position entity (owner, side, size, entry, collateral, realized/unrealized P&L).
2. **No price oracle / mark feed.** Entry/mark/P&L, the chart, and 24h stats all need live prices. PRD §14 explicitly states "no live OANDA/LMAX feed in P0; historical tick files (CSV)"; the reconcile path reads on-chain supply, not market prices.
3. **The naked-leg model conflicts with the deployed atomic-coupling contracts.**

The companion analysis assessed four resolutions (A order-book matching; B market-maker/AMM; C off-chain synthetic layer; D redefine contracts to allow single legs). **Option C is chosen.**

---

## 2. Impact Analysis

### Epic impact

- **New epic required** — proposed **Epic 8: Off-chain secondary-trading position layer**. This is epic-sized: it adds a per-user position model, a price-oracle integration, a position service, API endpoints, and web wiring.
- **Epic 4 invariant MUST stay intact.** Option C makes **zero** changes to the on-chain contracts. Stories **4-3** (atomic paired mint/burn), **4-4** (Model-A on-chain), **4-5** (dual-plane conformance), and FR-18/FR-19/FR-21 are untouched and not re-audited. The off-chain position layer composes the *existing* atomic pair flow; it never mints or transfers a single leg.

### Story impact

**Unaffected (no change):**

- All of **Epic 1** (ledger spine), **Epic 2** (coupled-pair contract/lifecycle), **Epic 3** (authorization chokepoint + rule-spec), **Epic 4** (on-chain tokens/compliance), **Epic 5** (mint/burn/reconcile), **Epic 7** (throwaway model validation).
- **Epic 6 stories 6.1–6.5** (API boundary, subscription, redemption, paper execution, Covenant Console + Coupled-Pair surfaces) — unchanged.

**Touched, additively (no rework):**

- **Epic 6, Story 6.6** ("Exchange/Trading and Subscriber surfaces on live data") already shipped the terminal with price-feed **empty-states** (per `spec-exchange-terminal.md`). Epic 8 *replaces those empty-states with live positions+marks* — it consumes 6.6's components (`market-list.tsx`, `pair-strip.tsx`, `order-ticket.tsx`, `positions-table.tsx`, `chart-placeholder.tsx`) rather than rewriting them.

**New stories:** all under Epic 8 (see §4).

### PRD / Architecture / UX artifact conflicts needing updates

- **PRD `prd.md`:**
  - **§5 Non-Goals** and **§6.2 Out of Scope** currently say "No general multi-asset trading venue / matching engine." This must be **clarified, not contradicted**: Option C is *not* a matching engine / CLOB / AMM venue — it is an **off-chain synthetic position layer over issued atomic pairs**. A scope note is needed so the new FRs do not appear to violate the stated non-goal.
  - **§4.6 / FR-14** (Engine surfaces — Exchange/Trading view) and **§4.5 / FR-20** (paper/testnet execution) need a forward reference to the new position layer.
  - **§14 Integration & Dependencies** ("Price data") must add the **price-oracle port** as a new (P0-or-post-P0) dependency, consistent with the existing "CSV ticks, no live feed in P0" stance.
  - New FRs must be added (proposed **FR-23 … FR-27**, continuing past the current FR-1…FR-22 set).
  - Relevant context already resolved: **D1 / D1a** (separate L/S, directional; losing-leg holder bears the loss; crystallised & withdrawable at reset) — the off-chain position layer is the natural home for the directional per-holder view this decision implies.

- **Architecture `architecture.md`:**
  - A new **architecture decision** for the off-chain position layer (entities, position service, price-oracle port) must be appended under "Core Architectural Decisions."
  - **Project Structure** must add new PROD packages and map the new FRs (current table maps FR-1…FR-22 only).
  - Must explicitly restate: **on-chain coupling contracts are untouched**; positions reconcile *against* issued pairs with the **chain still authoritative** for the underlying pairs (NFR-9 / FR-10 pattern reused).

- **UX `DESIGN.md` / `EXPERIENCE.md`:** the terminal register and Exchange/Trading surface are already specified and built. The delta is **behavioral wiring only** — remove the price-feed empty-states once the oracle + positions back them; add live-mark / live-P&L / stale-data states (UX-DR4 already defines live/stale patterns).

### Technical impact (on-chain UNCHANGED)

New, all in the PROD regime, all TypeScript with clean seams (NFR-7):

- **Off-chain position schema** — a per-user `positions` table (owner, reference asset, side L/S, size/units, entry = anchor P₀, collateral, realized/unrealized P&L, link to the issued `coupled_pair`), with a **reversible migration** (NFR-5).
- **Position service** — open/close-position composing the **existing atomic subscribe/redeem pair flow**; positions are claims/assignments against issued pairs, never single-leg mints.
- **Price-oracle integration** — a substitutable **oracle port** (NFR-8) + a **mark-to-market service** computing entry/mark/unrealized P&L; P0 adapter is CSV/replay or a testnet feed (consistent with PRD §14, no-real-money guardrail §11.3 preserved).
- **API endpoints** — position list + position P&L, over the existing Fastify + Zod + OpenAPI boundary (Story 6.1), money as decimal strings.
- **Web wiring** — replace the empty-states in `prod/packages/web/src/surfaces/exchange-trading/*` with live positions + marks.
- **Reconciliation** — off-chain positions reconcile against issued on-chain pairs (Σ position notional ≤ issued pair notional); reuses the **reconcile** module's correct-toward-chain backstop (Epic 5, FR-10).
- **On-chain: NONE.** No contract change, no new compliance rule, no re-audit.

---

## 3. Recommended Approach

**Option C — off-chain synthetic position layer.**

**Rationale:**

- **Invariant preserved.** On-chain truth stays paired; FR-18/FR-19/FR-21 and Stories 4-3/4-4 are untouched. The position layer composes the existing atomic pair flow — single-leg is still impossible everywhere it matters.
- **Lowest on-chain risk / no re-audit.** Unlike Option A (order-book matching engine) and Option B (market-maker/AMM with MM capital + inventory risk), Option C needs **no new on-chain mechanism**. Unlike Option D (redefine contracts to allow single legs), it does **not** break the audited safety invariant and needs **no fresh audit**.
- **Reuses proven patterns.** Dual-write outbox/saga with the on-chain tx as commit point (NFR-9), the reconcile-and-correct-toward-chain backstop (FR-10), the `postTransfer` chokepoint (FR-7), the single rule-spec, and the already-built terminal UI. The directional per-holder framing aligns with the resolved **D1/D1a** decision.

**Effort estimate (relative):** **lowest of the four options.** Roughly **one epic / ~6 stories**, predominantly off-chain TypeScript on existing infrastructure, with **no Solidity change and no audit cycle.** Option A and B each add a contract-side build plus re-audit; Option D adds a contract redefinition plus a mandatory fresh audit. Order of magnitude: C ≈ 1 epic; A/B ≈ 2+ epics incl. on-chain; D ≈ contract rewrite + audit.

**Risk assessment:**

- *Synthetic-exposure / solvency risk* — positions are claims against issued pairs; the position↔pair reconciliation (FR-27) and the floor-derived max-loss bound the exposure. Named-input: the Lykke exchange-collapse failure mode (PRD §15) must be a review input.
- *Oracle risk* — mark price is a new trust input; isolate behind the port, keep P0 on CSV/testnet (no real money, §11.3).
- *Ledger↔position drift* — mitigated by reusing the reconcile-and-correct pattern (NFR-9, chain authoritative for the underlying pairs).
- *Scope-creep into a real venue* — explicitly bounded by the PRD scope note (this is a synthetic layer, **not** a matching engine/AMM).

**Sequencing:** PM + Architect first (PRD FRs + architecture decision), then PO/Dev for Epic 8. Within Epic 8: oracle port + mark service → position schema + repo → open/close service → position P&L API → terminal wiring → position↔pair reconciliation + conformance.

---

## 4. Detailed Change Proposals

### 4.1 PRD (`prds/prd-rose-engine-2026-06-15/prd.md`)

**Add a new feature group §4.8 "Secondary-Trading Position Layer (off-chain, synthetic over issued pairs)"** with these FRs (continuing the FR-1…FR-22 set):

- **FR-23 — Persist an off-chain per-user position model.**
  *Before:* no per-user position entity exists.
  *After:* the system stores a position as (owner, reference asset, side L/S, size/units, entry = anchor P₀, collateral, realized + unrealized P&L, lifecycle, link to the issued coupled pair). Positions are **off-chain**; they never mint or hold a single on-chain leg.
  *Testable:* a position always references an issued coupled pair; no single-leg on-chain artifact is created.

- **FR-24 — Price-oracle port + mark-to-market service.**
  *After:* a substitutable oracle port supplies the reference-asset price; a mark service computes entry/mark/unrealized P&L from real pair params (`legsAtPrice` / floor / distance-to-floor). P0 adapter is CSV/replay or a testnet feed (no live OANDA/LMAX, §14).
  *Testable:* swapping the oracle adapter changes no caller (NFR-8); absent feed yields an explicit "no price feed" state, never fabricated marks.

- **FR-25 — Open/close a position composing the atomic subscribe/redeem pair flow.**
  *After:* opening a position acquires/assigns exposure against an **atomically issued coupled package** (the real FR-11/FR-18 subscribe + mint path); closing routes the real redeem/burn path (FR-21). The atomic-coupling invariant is preserved; no single-leg mint/burn occurs.
  *Testable:* every open/close drives a paired (both-or-neither) on-chain action; a single-leg path is impossible.

- **FR-26 — Position P&L API + Exchange-terminal wiring.**
  *After:* typed REST endpoints expose per-user positions and live P&L (money as decimal strings); the Exchange terminal renders live positions + marks, replacing the price-feed empty-states.
  *Testable:* the terminal shows live mark/P&L when the oracle is connected, and the documented empty-state when it is not.

- **FR-27 — Position↔pair reconciliation (chain authoritative for the underlying pairs).**
  *After:* reconciliation verifies that aggregate off-chain position notional never exceeds issued on-chain pair notional; divergence is reported and corrected toward the chain-backed pair state (reusing the FR-10 pattern).
  *Testable:* a deliberately introduced position↔pair mismatch is reported and corrected.

**MVP-scope note (add to §5 Non-Goals and §6.2):** "The secondary-trading position layer is an **off-chain synthetic layer over issued atomic pairs** — it is **not** a matching engine, CLOB, or AMM venue (the §5 'no general trading venue' non-goal stands). On-chain issuance remains atomic-pair-only; the deployed coupling contracts are unchanged. P0 in/out: the position model, oracle port, mark service, P&L API, and terminal wiring are **in** (testnet/paper); a real-capital/real-venue secondary market is **out** (board-gated, §11.3)."

### 4.2 Architecture (`architecture.md`)

**Append a Core Architectural Decision — "Secondary-Trading Position Layer (Off-Chain, Option C)":**

- **Entities:** a `positions` table (owner, reference_asset, side enum L/S, size/units NUMERIC, entry/anchor decimal(18,8), collateral NUMERIC, realized/unrealized P&L, lifecycle, `coupled_pair_id` FK). Reversible migration (NFR-5); money as integer smallest-units / `NUMERIC` (NFR-2).
- **Position service** (`prod/packages/positions`): open/close composing the existing `rose-note` subscribe/redeem + `chain` mint/burn flow (atomic pair, commit point = on-chain tx). It **never** writes a single-leg artifact; capital movements still route through `postTransfer` (FR-7).
- **Price-oracle port** (`prod/packages/price-oracle`): an interface (NFR-8) + a mark-to-market service reusing `pair-math`; P0 adapter = CSV/replay or testnet feed. Sits beside the ledger as a **read-only market-data input** — it is **not** a writer of postings.
- **Where it sits vs ledger/reconcile:** positions are a derived layer **over** the ledger's issued pairs; the ledger and the atomic-pair contracts remain the source of accounting/ownership truth. Reconciliation (FR-27) extends the existing reconcile module's correct-toward-chain backstop (NFR-9, FR-10): **chain authoritative for the underlying pairs.**
- **Regime boundary:** all PROD; `/prod` never imports `/throwaway`. The oracle keeps the testnet/paper money-boundary (§11.3) — switching to a real feed/real capital stays a gated change, never a config flip.
- **Explicit guardrail (state in the decision):** **the on-chain coupling contracts (Epic 4, Stories 4-3/4-4; FR-18/FR-19/FR-21) are untouched; no re-audit is triggered by Option C.**

**Project Structure / mapping table:** add `prod/packages/positions` (FR-23, FR-25, FR-27), `prod/packages/price-oracle` (FR-24), position endpoints under `prod/packages/api` (FR-26), and the live wiring under `prod/packages/web/src/surfaces/exchange-trading/` (FR-26).

### 4.3 New Epic + Stories — **Epic 8: Off-Chain Secondary-Trading Position Layer**

> Build a per-user synthetic position layer over issued atomic pairs, marked from a price oracle, so the Exchange terminal shows live positions and P&L — **without any change to the deployed coupling contracts.**

- **Story 8.1 — Price-oracle port + mark-to-market service (FR-24).**
  *Goal:* a substitutable oracle port feeding a mark service that computes entry/mark/unrealized P&L from real pair params.
  *Key AC:* swapping the oracle adapter requires no caller change; when no feed is connected, the service returns an explicit "no price feed" state (never a fabricated mark).

- **Story 8.2 — Off-chain position schema + repo, reversible migration (FR-23).**
  *Goal:* persist per-user positions linked to issued coupled pairs.
  *Key AC:* the migration applies and rolls back in CI (NFR-5); a position cannot exist without referencing an issued coupled pair, and no single-leg on-chain artifact is created.

- **Story 8.3 — Open/close-position service composing the real subscribe/redeem pair flow (FR-25).**
  *Goal:* open/close a position by driving the existing atomic subscribe→mint / redeem→burn path.
  *Key AC:* every open/close produces a paired (both-or-neither) on-chain action via the existing flow; a single-leg path is impossible and capital moves only through `postTransfer`.

- **Story 8.4 — Position P&L API (FR-26).**
  *Goal:* typed REST endpoints for per-user positions and live P&L over Fastify + Zod + OpenAPI.
  *Key AC:* responses are Zod-validated with money as decimal strings; refusals surface as the structured `{ error: { code, message } }` (Story 6.1 contract).

- **Story 8.5 — Wire the Exchange terminal to live positions + marks (FR-26, FR-14).**
  *Goal:* replace the price-feed empty-states in `exchange-trading/*` with live positions and marks.
  *Key AC:* with the oracle connected the chart/mark/P&L columns render live data; with it disconnected the documented empty-states remain (no fabrication) — reusing the existing terminal components from Story 6.6.

- **Story 8.6 — Position↔pair reconciliation + conformance tests (FR-27).**
  *Goal:* reconcile aggregate position notional against issued on-chain pair notional, correcting toward chain.
  *Key AC:* a deliberately introduced position↔pair mismatch is reported and corrected; aggregate position notional never exceeds issued pair notional.

### 4.4 UX delta

- The terminal is **already built** (DESIGN.md / EXPERIENCE.md / `spec-exchange-terminal.md`); no new visual design.
- **Delta = behavioral wiring:** wire real marks/positions into the existing components (`positions-table.tsx`, `pair-strip.tsx`, `chart-placeholder.tsx`); **remove the price-feed empty-states once the oracle + position data back them**, and add live/stale-mark + live-P&L states (UX-DR4 already defines the live/stale and divergence patterns).
- Keep the honest-data discipline: empty-state when the oracle is absent; never fabricate marks.

---

## 5. Implementation Handoff

**Scope classification: MAJOR.** This crosses the PRD (new FR-23…FR-27 + scope note), the architecture (new decision + packages), and a new epic. It is not a Quick Dev increment.

**Recipients / sequencing:**

1. **PM (John)** — add FR-23…FR-27 and the MVP-scope note to `prd.md`; confirm the §5 non-goal clarification (synthetic layer ≠ trading venue).
2. **Architect (Winston)** — append the "Secondary-Trading Position Layer (Option C)" decision; add `positions` + `price-oracle` packages and the FR→structure mapping; restate the on-chain-untouched guardrail.
3. **PO / Dev (then)** — break Epic 8 into stories 8.1–8.6 and execute on the existing plan→dev→review cycle. UX wiring lands in 8.5 on the already-built terminal.

**Success criteria:**

- The Exchange terminal shows **live per-user positions with mark-to-market P&L** (oracle connected) and the documented empty-state (oracle absent) — no fabricated data.
- Off-chain positions **reconcile to issued on-chain pairs**, chain authoritative for the underlying pairs (FR-27).
- **Zero change** to the deployed contracts: Stories 4-3/4-4 and FR-18/FR-19/FR-21 untouched; no re-audit.
- All Epic 8 migrations reversible (NFR-5); money exact (NFR-2); oracle substitutable (NFR-8); testnet/paper boundary intact (§11.3).

**Explicit guardrail (non-negotiable, Option C):** the **atomic-coupling invariant and the deployed ERC-3643 coupling contracts must not change.** No single-leg mint/burn/transfer is introduced anywhere; positions are an off-chain synthetic layer composed from the existing atomic pair flow. Any proposal that would alter the on-chain coupling is **out of Option C** and would require re-opening the resolution decision (toward Option D) with a fresh audit and an explicit product-safety sign-off.
