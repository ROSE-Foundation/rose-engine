---
title: ROSE Engine — Product Requirements Document
status: final
created: 2026-06-15
updated: 2026-06-15
---

# PRD: ROSE Engine
*Working title — confirm.*

## 0. Document Purpose

This PRD defines the **ROSE Engine** — the regulated, real-time financial-infrastructure product at the operational heart of the ROSE system. It is written for **two audiences**: the build teams (InTech and collaborators) and the **stakeholders / board** who steer ROSE. It states *what* the Engine must do and *why* — capabilities, requirements, constraints — not *how* to implement them.

Scope was set deliberately: this is the **ROSE Engine product**, sequenced **Engine-first**, with **P0** as the near-term milestone. During review, P0 was scoped as a **full vertical-slice MVP** — the off-chain ledger spine *plus* real subscription/redemption, real strategy execution, and real on-chain token minting — but run entirely on **testnet (Sepolia) and paper execution, with no real capital** (see §6). It is **not** a PRD for the whole ROSE movement (Money System, EDIN, Living Movement, Governance, Commons) — those are referenced only where they bound the Engine.

The PRD is Glossary-anchored: features are grouped, functional requirements (FR-N) nest under them with globally stable IDs, success metrics (SM-N) and user journeys (UJ-N) cross-reference by ID, and inferred decisions carry inline `[ASSUMPTION]` tags indexed in §9. It builds on, without duplicating, two inputs: **`docs/SPEC.md`** (the original P0 engineering spec) and the **ROSE source corpus** (`docs/`). Implementation-level "how" — database, migration tooling, repo layout, the coupled-coin math, the ERC-3643 contract stack — lives in the companion **`addendum.md`**.

> **⚠️ SPEC.md is superseded on several P0 non-objectives.** Review widened scope beyond SPEC.md's stated P0: the SPEC said off-chain, no EVM, no smart contracts, no live trading, no token minting, on-chain authorization at P3+. **All are now in P0** (on testnet/paper). `docs/SPEC.md` must be updated. Where SPEC and this PRD disagree, **this PRD governs**.

> **Build approach (load-bearing decision):** ROSE Engine is a **greenfield build**, informed by — but not an upgrade of — the existing **Laplace** group and its `laplace.digital` tokenised-note platform. Laplace is precedent, not codebase.

---

## 1. Vision

Modern finance is digital on the surface and analog underneath. Markets move in milliseconds, but settlement still takes T+2; liquidity sits trapped overnight across fragmented custodians, correspondent banks, and clearing houses. No genuine intraday money market exists. The ROSE Engine exists to make finance **digital underneath** — a real-time infrastructure layer where trading, settlement, interest, and liquidity coordination happen continuously rather than in delayed batches. Its sibling premise is **intrinsic time**: markets measured by meaningful events rather than the wall clock — financial time that slows when markets are calm and accelerates with volatility. The Engine's threshold-only rebalancing (§4.7) is the operational embodiment of that idea: it reacts to price events, never to a clock.

The Engine's structural innovation is the **coupled pair**: financial value issued only in paired long+short form, designed to be **delta-neutral at issuance**, so directional risk comes from strategy rather than from the existence of the instrument. The pair is more than a risk device — it lets collateral **circulate and recycle** through the infrastructure instead of lying dormant, which is the bridge to the intraday-money-market end-state. Packaged into a **Rose Note** and issued from a regulated fund vehicle as **ERC-3643 permissioned security tokens on EVM**, it lets ROSE access significant markets with bounded risk. The Engine is the financial organ that generates the surplus the rest of ROSE depends on — "the first moment at which ROSE must not only make sense, but *work*."

P0 proves the whole loop end-to-end — **live in code, on testnet/paper, with no real capital**: a Subscriber subscribes through the real flow, the fund issues coupled ERC-3643 tokens (on **Sepolia testnet**), on-chain compliance enforces the rules, the Trading Co. executes strategy in **paper/testnet** mode, and every movement lands in a double-entry ledger reconciled against the chain. The code paths are real; the funds are test funds. The chain is the **source of truth** for token ownership; the off-chain ledger is the **accounting system of record**, reconciled to the chain. A falsifiable validation puts the coupled-coin model itself on trial — built to reveal a wrong model cheaply and early. The widened P0 is still **"sufficient precision, not maximal elaboration"**: precisely *because* it runs on testnet/paper, the slice can be end-to-end without the real-money, real-venue, and custody hardening that would make it premature.

---

## 2. Target Users & Stakeholders

### 2.1 Jobs To Be Done

- **As a Subscriber (Rose Member)**, I want to subscribe to and redeem Rose Notes (fiat or crypto) and see the state and value of what I hold, so I can participate with a clear view of my position. *(Functional / financial.)*
- **As the Investment Manager (Namara Wealth Advisors)**, I want to implement the portfolio, manage cash and NAV, run and monitor the coupled-pair strategies, and coordinate service providers, so the fund operates within mandate. *(Functional / professional.)*
- **As an internal operator / steward**, I want a consolidated, reconcilable view of group NAV, per-entity balances, float yield, and exposure — with assurance the ledger agrees with the chain — so I can attest capital is where the books say and no segregation line was crossed. *(Fiduciary, trust.)*
- **As a stakeholder / board member**, I want evidence the coupled-coin model holds across a full lifecycle on real ticks, and that the loop runs safely, so I can decide whether to move toward real capital. *(Strategic — the make-or-break call.)*
- **As a build engineer**, I want invariants enforced by the system (database balance, on-chain compliance) and a hard PROD/throwaway boundary, so I can move fast on validation without endangering the spine. *(Safety.)*

### 2.2 Non-Users (P0)

- **Retail / unvetted public.** Distribution is to **sophisticated clients** via `laplace.digital`, gated by a **curated eligibility allowlist** — itself conditioned on **completed off-chain KYC/AML and accreditation checks** (the on-chain claim merely records that those passed). There is **no self-service KYC product flow** in P0.
- **Multi-asset traders.** P0 validates the model on a small reference set (§4.7); it is not a general trading venue.

### 2.3 Key User Journeys

- **UJ-1. Namara issues a coupled Rose Note and the records stay consistent.**
  > The investment manager originates a Rose Note embedding one coupled pair — minted as paired ERC-3643 tokens (L-Token and S-Token at equal notional, delta-neutral at issuance) on Sepolia. The mint is the committing event; the Engine then records a single balanced journal entry across the relevant entity accounts (both legs together, never one alone), and the ledger's token quantities reconcile to the on-chain position. The manager sees the pair `ACTIVE` and the Note in group NAV. **Edge case:** if the ledger write fails after the on-chain mint, reconciliation detects the divergence and the ledger is corrected toward the chain (§4.4). Realizes FR-1, FR-2, FR-6, FR-13, FR-18.

- **UJ-2. An operator reconciles the ledger against the chain before sign-off.**
  > A steward runs `reconcile`. The Engine produces the group view (per entity, per account type, balances) **and** checks that ledger token quantities match on-chain balances. A clean text/JSON report supports the close. **Edge case:** any ledger↔chain or per-entity/consolidated divergence is flagged and, for token ownership, resolved by correcting the ledger to the chain. Realizes FR-9, FR-10.

- **UJ-3. A forbidden transfer is blocked — off-chain and on-chain.**
  > A transfer of client-collateral *principal* toward treasury is attempted. Off-chain it is routed through the single `postTransfer` chokepoint, whose authorization provider rejects it by default (Model-A bright line); on-chain, the custom ERC-3643-compatible contract's compliance rule rejects the equivalent token transfer. Nothing posts on either side. **Edge case:** a *yield* movement on the same collateral *is* permitted. Realizes FR-7, FR-8, FR-19.

- **UJ-4. The model is put on trial against real ticks.**
  > An analyst replays historical EUR/USD and BTC ticks through the coupled-coin simulator. Rebalancing fires *only by threshold* — when a losing leg breaches the floor — never on a clock. The run proves no leg goes negative inside the barrier, journals every reset, and shows the full lifecycle (`PENDING → … → CLOSED`). At L=1, EUR/USD should almost never hit the barrier (validates the model); BTC at L=1 is a deliberate **stress test** expected to exhibit resets. Realizes FR-15, FR-16, FR-17; validates SM-2, SM-3.

- **UJ-5. A Subscriber views a coupled pair.**
  > A Rose Member opens the functional coupled-pair view and sees the live state of a pair — V_A, V_B, K, floor, anchor — and their holding. All Subscriber surfaces are functional in P0. Realizes FR-14.

---

## 3. Glossary

*Downstream artifacts and readers must use these terms exactly. Synonyms anywhere in the PRD are a discipline violation.*

- **ROSE Engine** — the real-time financial-infrastructure product specified by this PRD.
- **Coupled pair** — a package of one long leg and one short leg at equal notional, created, modified, and closed only together. Never a standalone leg. Its shared data model is the **inter-track contract** (FR-6). Source synonyms ("coupled coin", "coupled package", "L+S unit") map here.
- **Leg** — one side (long = A, short = B) of a coupled pair; no independent persistent existence. A transient orphan mid-rebalance is the explicit `PARTIAL` state.
- **Rose Note** — the investor-facing instrument issued by the fund vehicle, embedding a coupled pair, delta-neutral at issuance. *(Its composition — whether one Note bundles both legs or legs can be held separately — is an open product decision; see §8 Q1 and the §4.2 note.)*
- **L-Token / S-Token** — the long and short legs realized as **ERC-3643-compatible permissioned security tokens on EVM** (custom contract, OpenZeppelin base, with ROSE-specific compliance rules), minted as paired units at equal notional.
- **ERC-3643** — the permissioned security-token standard (T-REX): transfers allowed only between eligible, identity-verified holders, enforced on-chain by compliance rules. ROSE uses an **ERC-3643-compatible custom contract** that adds use-case rules (pair coupling, Model-A principal/yield handling).
- **ONCHAINID** — the on-chain identity carrying eligibility claims an ERC-3643 holder must have.
- **Claim issuer** — the trusted party issuing eligibility claims to an ONCHAINID; in P0, a ROSE-operated issuer working from the curated allowlist (claims attest off-chain KYC/AML/accreditation passed).
- **Compliance rule** — an on-chain rule in the custom ERC-3643 contract that permits or rejects a token transfer (eligibility, transfer restriction, the Model-A bright line, pair coupling).
- **Allowlist (eligibility allowlist)** — the curated set of sophisticated clients granted ERC-3643 eligibility in P0, gated on completed off-chain KYC/AML/accreditation.
- **Transfer agent / administrator** — the privileged role authorized to operate ERC-3643 agent powers (forced transfer, recovery, freeze, pause) on the token. `[ASSUMPTION: which entity holds this role is TBD — see §8.]`
- **Subscriber (Rose Member)** — an eligible investor who subscribes to / redeems Rose Notes, in fiat or crypto, at the fund-vehicle level.
- **Investment Manager** — the licensed entity (Namara Wealth Advisors): portfolio implementation, cash/NAV management, strategy execution, service-provider coordination.
- **Entity** — one of the four fixed P0 legal books: `VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`. No dynamic entity creation in P0. Each carries a `jurisdiction`.
- **Account** — a book of record under an entity, typed: `BACKING_FLOAT`, `DEPLOYED_CAPITAL`, `CLIENT_COLLATERAL`, `FEE_INCOME`, `NOTE_LIABILITY`. Each account carries an asset and its decimal scale. **VCC accounts are cash/NAV only**; exchange/trading accounts live under `TRADING_CO`; coin-treasury / on-chain-liquidity accounts under `COIN_ISSUER`.
- **Treasury** — the entity-level operating cash destination for permitted flows (e.g. fees, collateral yield); distinct from `CLIENT_COLLATERAL` and from the `COIN_ISSUER` coin treasury.
- **Journal entry** — a balanced set of postings recording one economic event (debits = credits), with a human-readable `description`.
- **Posting** — a single debit or credit line against one account, in **integer smallest units** of that account's asset (never binary float).
- **Double-entry invariant** — for every journal entry, Σ debits = Σ credits, enforced *in the database*.
- **postTransfer** — the single function through which every off-chain inter-account capital movement must pass; the only writer of transfer postings.
- **Authorization Provider** — the interface `postTransfer` consults before writing; default-deny. In P0 the same rule intent also exists on-chain as compliance rules.
- **Model-A segregation ("bright line")** — client-collateral *principal* may never move outside the client account; yield may. Enforced off-chain (FR-8) and on-chain via the custom contract (FR-19). Non-negotiable.
- **Floor (f)** — the rebalancing threshold for a pair; a reset fires only when a losing leg breaches it. Threshold-only, never clock-based. `f = m·L·g`, where `m` (safety margin) and `g` (worst plausible gap) are **parked parameters** (§11.2).
- **Anchor price (P₀)** — the reference price a pair is anchored to; re-anchored to current price at each reset.
- **Leverage (L)** — multiplier on the relative price deviation; **a per-pair parameter** (never hard-coded). A leg hits zero at |price move| = 1/L.
- **Collateral pool (K)** — the cash pool of a pair, the sum of both legs. Structural invariant: leg values sum to K for all prices within the barrier (issuer-neutral).
- **Reconciliation** — the process producing the group view and verifying ledger ↔ chain consistency, **correcting the off-chain ledger toward the chain** on token-ownership divergence.
- **Source of truth** — the **chain** is authoritative for token ownership and positions; the **off-chain ledger** is the authoritative accounting record and is reconciled/corrected to the chain on conflict.
- **Commons allocation** — the share of ROSE's surplus directed to the common good (Swiss non-profit). Context, not a P0 capability.
- **PROD regime / Throwaway regime** — the two labelled code-quality regimes in one repository. PROD is production-grade; throwaway (model math, simulator) is disposable and never a production dependency.

---

## 4. Features

### 4.1 Consolidated Double-Entry Ledger (the accounting system of record)

**Description:** A consolidated, multi-entity, off-chain ledger in strict double-entry — the **authoritative accounting record** for the Engine. (For token *ownership*, the chain is authoritative; on divergence the ledger is corrected to the chain — see §4.4.) It covers backing float, deployed capital, segregated client collateral, fee income, and Note liability across four fixed entities, reconcilable into one group view. Integrity of the *accounting* is guaranteed by the **database** — an unbalanced entry cannot persist. All amounts are **integers in the smallest unit of their asset** (never binary float); see NFR-2. *(PROD regime.)*

**Functional Requirements:**

#### FR-1: Record entities and typed accounts
The system models the four fixed entities (`VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`), each with a `jurisdiction`, and under each, accounts of the five fixed types, each with an asset and decimal scale.
**Consequences (testable):**
- The entity set is fixed to four codes in P0; no API creates entities dynamically.
- Every account has one entity, one type, one asset, a decimal scale, and is placed per the routing rule (VCC = cash/NAV only; exchange accounts under `TRADING_CO`; coin treasury / on-chain liquidity under `COIN_ISSUER`).

#### FR-2: Record balanced journal entries with postings
An actor records a journal entry of two or more postings (debits/credits) against accounts, with a human-readable `description` and an optional link to a coupled pair.
**Consequences (testable):**
- Amounts are integers in smallest units; no binary-float amount can be stored.
- Each entry carries a non-empty `description` for the audit trail (NFR-3).

#### FR-3: Enforce the double-entry invariant in the database
For every journal entry, Σ debits = Σ credits, enforced as a database-level guarantee.
**Consequences (testable):**
- Persisting an unbalanced entry fails the transaction; no partial state remains.
- The guarantee holds regardless of application path; it cannot be bypassed by writing postings directly. *(This guarantees accounting balance — it does not by itself guarantee agreement with the chain; that is FR-10.)*

---

### 4.2 Coupled-Pair Contract & Lifecycle

**Description:** The shared data model of the coupled pair is the **most important artifact in the system** — the contract every downstream track consumes. A pair carries reference asset, anchor price P₀, leverage L (**a per-pair parameter**), collateral pool K, floor f, and a lifecycle state. Cardinal rule: a pair **never exists as a single leg**; the schema makes a persistent orphan leg unrepresentable. A transient orphan mid-rebalance is the explicit `PARTIAL` state. *(PROD regime; the model's behavioral math is validated in the Throwaway regime, §4.7.)*

> **[NOTE FOR PM — deferred decision (D1):** the PRD does not yet fix **what a Rose Note holds** (one Note bundling *both* legs → market-neutral holder; or L/S held *separately* → zero-sum, each holder directional) nor **who bears the losing leg's locked loss at a reset** and what they hold afterward. The structure memo implies a bundled package, but the simulator describes divergent legs. This is a genuine product decision affecting the whole instrument; it is parked in §8 Q1 to resolve with architecture before build. The model validation (§4.7) proves the *invariant*, not the *loss-allocation*.]

**Functional Requirements:**

#### FR-6: Persist the coupled-pair shared data model (inter-track contract)
The system stores a coupled pair as: identifier, reference asset, anchor price P₀, leverage L, collateral pool K, floor f, lifecycle state, timestamps.
**Consequences (testable):**
- The schema cannot represent a persistent single-leg pair.
- **L is a per-pair parameter** (EUR/USD and BTC both at L=1 in P0 validation; the field is never hard-coded).

#### FR-4: Represent the pair lifecycle states
A pair moves through `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED`.
**Consequences (testable):**
- Transitions are explicit; `PARTIAL` is a known transient mid-rebalance state.
- The full lifecycle (PENDING→CLOSED) can be traversed and observed. *(Validates SM-3.)*

#### FR-13: Record a coupled-pair issuance as one balanced entry
Issuing a pair records both legs in a single balanced journal entry linked to the pair, alongside the on-chain mint (FR-18).
**Consequences (testable):**
- The issuance entry balances and is visible in the group view.
- One cannot record an issuance of a single leg.

---

### 4.3 Capital-Flow Authorization (single chokepoint, off-chain and on-chain)

**Description:** Every off-chain movement of capital passes through **one** function, `postTransfer`; no module writes transfer postings directly. Before writing, `postTransfer` consults a **default-deny** Authorization Provider. **In P0 the same rule intent also lives on-chain** in the custom ERC-3643-compatible contract, so eligibility, transfer restrictions, the Model-A bright line, and pair coupling are enforced where the token moves as well as where the books are kept. *(PROD regime.)*

**Functional Requirements:**

#### FR-7: Route all off-chain capital movements through a single chokepoint
All inter-account capital movement occurs via `postTransfer(from, to, amount, context)`; no other path writes transfer postings.
**Consequences (testable):**
- A test proves no module writes transfer postings outside `postTransfer`.
- `postTransfer` consults the Authorization Provider before any write.

#### FR-8: Default-deny authorization with the minimal P0 rule set
`postTransfer` rejects any transfer not explicitly permitted by a `flow_permissions` rule. P0 rules:
**Consequences (testable):**
- `FEE_INCOME` (any entity) → treasury: **allowed**.
- Yield on `CLIENT_COLLATERAL` → treasury: **allowed** (principal excluded).
- `CLIENT_COLLATERAL` *principal* → any destination outside the client account: **rejected** (Model-A). *(UJ-3.)*
- Any transfer pushing `BACKING_FLOAT` below its floor: **rejected**; if the floor config is absent, **refused**, never treated as 0 (§11.2).
- Token/trading flows do not route through VCC accounts (VCC = cash/NAV only); they route through `TRADING_CO` / `COIN_ISSUER`.
- A transfer not covered by any rule: **rejected by default**.

#### FR-5: Provider substitutability (interface isolation)
The Authorization Provider is an interface; swapping implementations requires no change to calling code.
**Consequences (testable):**
- Substituting a fake/alternate provider changes no caller.

#### FR-19: Enforce the same restrictions on-chain via a custom ERC-3643-compatible contract
Token transfers of L-Token/S-Token are governed by on-chain compliance rules in a **custom ERC-3643-compatible contract (OpenZeppelin base)** that encodes eligibility, the Model-A bright line, and pair coupling — including the logic needed to distinguish principal from yield (e.g. segregated principal balances / sub-positions) which a plain fungible token cannot express.
**Consequences (testable):**
- A token transfer to a non-eligible (no valid ONCHAINID claim) recipient is rejected on-chain.
- An on-chain transfer that would violate Model-A (principal leaving the client position) is rejected on-chain. *(UJ-3.)*
- A single-leg transfer that would break pair coupling is rejected on-chain.
- The on-chain rules are consistent with the off-chain `flow_permissions` rules; the two rule sets are derived from a single specification so they cannot silently diverge. `[ASSUMPTION: the single-source mechanism keeping off-chain and on-chain rules equivalent is to be designed with architecture — see §8.]`

---

### 4.4 Reconciliation & Group View (ledger ↔ chain)

**Description:** A `reconcile` capability produces the consolidated group view, verifies per-entity/consolidated consistency, **and** verifies that ledger token quantities agree with on-chain balances. Because the **chain is the source of truth** for token ownership, reconciliation does not merely detect divergence — on a token-ownership mismatch it **corrects the off-chain ledger toward the chain** (with the correction itself journaled). Cross-jurisdiction (e.g. Cayman) reconciliation is out of P0 scope. *(PROD regime.)*

**Functional Requirements:**

#### FR-9: Produce the consolidated group view
`reconcile` outputs per-entity, per-account-type balances plus the consolidated group view, as human-readable text and structured JSON.
**Consequences (testable):**
- The report renders for a populated ledger and lists balances by entity and account type.
- Running `reconcile` on a balanced, chain-consistent ledger reports no divergence.

#### FR-10: Verify per-entity/consolidated AND ledger↔chain consistency; correct toward chain
Reconciliation checks per-entity sums against consolidated figures, and ledger token quantities against on-chain balances; token-ownership divergence is corrected toward the chain.
**Consequences (testable):**
- A per-entity/consolidated divergence is reported explicitly.
- A ledger↔chain quantity mismatch is reported **and** the ledger is corrected to match the chain, with a journaled correcting entry. *(Realizes UJ-1/UJ-2 edge cases.)*
- `[ASSUMPTION: reconciliation cadence (on-demand, scheduled, per-event) and chain finality/reorg handling are for architecture — see §8.]`

---

### 4.5 Rose Note — Live Issuance, Subscription, Execution, Minting & Redemption

**Description:** The investor-facing product layer, **live in P0** as a small-scale testnet/paper vertical slice. Eligible Subscribers subscribe to and redeem Rose Notes (fiat or crypto) at the fund (VCC) level; the Coin Issuer mints — and burns on redemption — **paired ERC-3643-compatible L/S tokens on Sepolia**; the Trading Co. executes strategy in paper/testnet mode. Coupled packages move between entities as **whole L+S units** (collateral, hedging, liquidity inventory), never single legs. The ledger is **hybrid**: value *and* token quantities. *(PROD regime; performance-critical execution paths may be Rust/Go — see addendum.)*

**Functional Requirements:**

#### FR-11: Live subscription and redemption of Rose Notes
An eligible Subscriber subscribes to and redeems (buys back) Rose Notes at the VCC level in fiat or crypto; each produces balanced journal entries touching the appropriate accounts (incl. `NOTE_LIABILITY`).
**Consequences (testable):**
- A subscription and a redemption each produce balanced entries, visible in the group view, respecting the chokepoint and segregation rules.
- Only allowlist-eligible Subscribers (valid ONCHAINID claim) can receive tokens (FR-19).

#### FR-12: Embed a coupled pair in a Note, delta-neutral at issuance
A Rose Note references exactly one coupled pair whose legs offset at issuance.
**Consequences (testable):**
- At issuance the embedded position is **market-neutral on the underlying** (delta-neutral); directional risk arises only from strategy. *(Whether the holder remains neutral post-reset depends on the D1 decision — see §4.2 note.)*

#### FR-18: Mint paired ERC-3643 L/S tokens on EVM (Sepolia in P0)
Issuing a pair mints one L-Token and one S-Token at equal notional via the custom ERC-3643-compatible contract on Sepolia, recorded in the ledger (quantity + value) and reconcilable to chain. The paired (atomic, both-or-neither) mint is enforced by the contract's coupling logic.
**Consequences (testable):**
- Tokens are minted only as paired units at equal notional; a single-leg mint is impossible.
- Minted on-chain quantities reconcile to ledger token quantities (FR-10).

#### FR-21: Burn / retire tokens on redemption
Redeeming a Note burns (retires) the corresponding coupled token package on-chain, with matching ledger entries.
**Consequences (testable):**
- A redemption burns the whole package (both legs); a single-leg burn is impossible.
- Post-redemption on-chain supply and ledger quantities reconcile.

#### FR-22: Privileged transfer-agent / agent powers
The custom contract exposes ERC-3643 agent powers — **forced transfer, recovery (lost-key reissue), freeze, pause** — operable only by the designated transfer-agent/administrator role.
**Consequences (testable):**
- Agent powers are callable only by the authorized role; unauthorized calls revert.
- A recovery reissues a holder's balance to a new wallet while preserving eligibility and the audit trail.
- `[ASSUMPTION: which entity holds the transfer-agent role is TBD — §8.]`

#### FR-20: Execute coupled-pair strategy (paper/testnet, small-scale)
The Trading Co. executes strategy in **paper/testnet mode** (no real CEX, no real capital), with resulting positions/P&L flowing to the ledger.
**Consequences (testable):**
- A strategy execution produces ledger entries tagged to the executing entity; simulated P&L accrues to the VCC via its ownership chain and is visible in the group view.
- P0 execution is paper/testnet and small-scale; real-venue and high-frequency scale-up are post-MVP (NFR-7, §17).

---

### 4.6 Engine Surfaces

**Description:** Four surfaces are **all functional (live data) in P0** — no mockups: the **Covenant Console** (group NAV, per-entity balances, float yield, exposure), the **Coupled-Pair view** (V_A, V_B, K, floor, anchor + holding), the **Exchange / Trading** view, and the **Subscriber surfaces** (subscribe / redeem / view position). *(PROD regime.)*

**Functional Requirements:**

#### FR-14: Provide the Engine surfaces, all functional in P0
The system provides functional Covenant Console, Coupled-Pair, Exchange/Trading, and Subscriber surfaces, reading live data from the ledger / chain / strategy.
**Consequences (testable):**
- Each surface renders live data (no hard-coded mockup surfaces in P0).
- The Subscriber surfaces drive the live subscription/redemption flow (FR-11); the Coupled-Pair view reflects live pair state (FR-6); the Covenant Console reflects the live group view (FR-9).

---

### 4.7 Coupled-Coin Model Validation (the trial)

**Description:** A **throwaway** mathematical library and rebalancing simulator that **refutes or confirms** the coupled-coin model cheaply, before production weight rests on it. In-memory, no database, no auth. The library implements the reference mechanics (leg values vs price; the issuer-neutral invariant that leg values sum to K within the barrier; the floor as `m·L·g`). The simulator replays historical ticks and rebalances **by threshold only** — a reset fires *only* when a losing leg breaches the floor, **never on a clock** (clock-based rebalancing would import leveraged-ETF volatility decay — the trap to avoid; this is "intrinsic time" in operation). *(Throwaway regime. Math reference → `addendum.md`.)*

> **What this validates and what it does not.** The simulator proves the **invariant** `V_A+V_B=K` holds within the barrier and that no leg goes negative — i.e. the model is *issuer-neutral* (issuer net = 0). It does **not** settle *who bears the locked loss at a reset* or *what a holder holds afterward* (the D1 decision, §4.2). Issuer-neutrality is **conditional**: it holds within the barrier and can break on a price gap past the floor — that conditionality is the **key model risk** (§15).

**Functional Requirements:**

#### FR-15: Implement the coupled-coin reference math with the issuer-neutral invariant
The library computes leg values from price, verifies leg values sum to K within the barrier, and detects floor breaches.
**Consequences (testable):**
- For a price grid within the barrier, V_A + V_B == K exactly (model math may use higher precision; NFR-2 rounding policy). *(Validates SM-2.)*
- No leg becomes negative while price stays within the barrier; floor breach is detected.

#### FR-16: Simulate threshold-only rebalancing over historical ticks
The simulator replays ticks (CSV `timestamp,price`) and triggers a reset only when a losing leg breaches floor f.
**Consequences (testable):**
- No reset is ever triggered on a time interval; resets are threshold-driven only.
- At reset, current dollar values are locked, P₀ re-anchors to current price, and the losing holder's loss is locked.

#### FR-17: Prove no-negative-leg and journal every reset over a tick set
Over a tick set, the simulator demonstrates no leg goes negative and journals every reset (price, locked values, new anchor).
**Consequences (testable):**
- The run reports whether any leg went negative and whether any gap breached the floor (the issuer-neutrality break condition).
- Every reset is journaled with price, locked values, new anchor.
- The run exercises the full pair lifecycle end-to-end. *(Validates SM-3.)*

**Notes:** Reference pairs in P0 are **EUR/USD and BTC, both at L=1**. EUR/USD validates the model (barrier ~never hit). **BTC at L=1 is a deliberate stress test** expected to exhibit resets and to probe the floor-gap break condition. No live OANDA/LMAX integration; an example tick file suffices.

---

## 5. Non-Goals (Explicit)

- **No self-service KYC / onboarding funnel.** Eligibility is a curated allowlist (ERC-3643 claims) gated on completed **off-chain** KYC/AML/accreditation for sophisticated clients; ROSE does not build a public KYC product in P0.
- **No general multi-asset trading venue.** P0 validates the model on EUR/USD and BTC only; not a matching engine / CLOB / open exchange.
- **No invented values for parked parameters** (Note coupon, use-of-proceeds split, conversion-to-participation, backing-float floor, model floor params m and g). Read from config; **refuse** when absent.
- **The Engine is not the whole ROSE system.** Money System currencies, EDIN, Living Movement, Governance tooling, the Commons hardware lab — out of scope.
- **Not an upgrade of the Laplace platform.** Greenfield; Laplace is precedent only.
- **No real-capital / mainnet operation in P0** — Sepolia testnet + paper execution only.
- **No cross-jurisdiction reconciliation in P0** (e.g. Cayman) — deferred.

> *Superseded SPEC non-objectives:* "no EVM / no smart contracts / no functional exchange beyond mockups / on-chain auth = P3+" no longer hold; on-chain ERC-3643 tokens, real minting, real subscription, and small-scale paper execution are in P0 (on testnet/paper).

## 6. MVP Scope (P0)

P0 is a **live, small-scale vertical slice** proving the whole loop on the off-chain ledger foundation. **Live in code, but on testnet/paper with no real capital:** ERC-3643-compatible tokens on **Sepolia**, strategy execution in **paper/testnet** mode. The code paths are real; the funds are test funds. This is what makes the wide slice feasible as a *P0* — the real-money, real-venue, and custody hardening is deliberately deferred.

### 6.1 In Scope
- Consolidated double-entry ledger across the four entities, DB-enforced balance, **hybrid value + token-quantity** accounting (§4.1).
- Coupled-pair contract with **per-pair L** and lifecycle states (§4.2).
- Single off-chain chokepoint, default-deny authorization, **mirrored on-chain** by the custom ERC-3643 contract's compliance rules (§4.3).
- Reconciliation: group view **and ledger ↔ chain**, correcting toward chain (§4.4).
- **Live (testnet/paper)** Rose Note subscription/redemption, **paired ERC-3643 mint + burn on Sepolia**, transfer-agent powers, and **small-scale paper execution** (§4.5).
- ERC-3643 identity/eligibility infrastructure: ONCHAINID registry, trusted claim issuer, compliance rules, curated allowlist gated on off-chain KYC/AML (§4.3/§4.5).
- All four Engine surfaces functional (§4.6).
- Throwaway coupled-coin library + threshold-only simulator on EUR/USD and BTC at L=1 (§4.7).
- Versioned, reversible migrations from the first commit; invariant tests before application logic.

### 6.2 Out of Scope for MVP
- Self-service KYC / open onboarding — *allowlist instead*.
- General multi-asset trading venue / matching engine — *P0 proves the loop + model, not a venue*.
- **Real-capital / mainnet operation** — *Sepolia + paper only; real funds/venues are post-P0, board-gated*.
- Cross-jurisdiction (Cayman) reconciliation — *deferred*.
- High-frequency / large-scale execution — *perf hot paths planned (Rust/Go) but not scaled*.
- `[NOTE FOR PM: resolving any parked parameter — these stay unset by decision, not omission.]`

## 7. Success Metrics

**Primary**
- **SM-1: Subscription capability proven end-to-end (testnet/paper).** The full subscribe → issue → mint → ledger loop works end-to-end on Sepolia/paper with test funds. Raising **real** capital is a post-P0, board-gated step; **no numeric target or deadline is set** (the board defines the go/scale threshold). Validates FR-11, FR-12, FR-18.
- **SM-2: The coupled-coin model holds on a real pair.** The issuer-neutral invariant (V_A + V_B = K) holds across the price grid within the barrier and no leg goes negative, demonstrated on a real coupled pair. Validates FR-15, FR-17.
- **SM-3: Full lifecycle traversed.** A coupled pair is driven through the complete lifecycle (`PENDING → … → CLOSED`) with every reset correctly journaled, on real ticks. Validates FR-4, FR-16, FR-17.

**Secondary**
- **SM-4: Spine + compliance integrity proven by test.** All P0 acceptance criteria pass — DB rejection of unbalanced entries, default-deny authorization, on-chain compliance rejection, provider substitutability, ledger↔chain reconcile-and-correct. Validates FR-3, FR-5, FR-7, FR-8, FR-10, FR-19.

**Counter-metrics (do not optimize)**
- **SM-C1: EUR/USD reset frequency must stay near zero with a *plausible* floor.** Falsifiability rule: pick `m` and `g` by a **stated, defensible method** (e.g. `g` = empirical worst gap over the reaction window in the tick history; `m` a fixed margin documented in advance), *then* observe the reset rate — do not tune `m`/`g` to manufacture a low rate after the fact. If EUR/USD at L=1 needs an implausibly large `m` to avoid frequent resets, the model/parameters fail. **Does not apply to BTC** (resets expected). Counterbalances SM-3.
- **SM-C2: Do not trade spine/compliance safety for delivery speed.** Throwaway velocity must never weaken a PROD invariant, an on-chain compliance rule, or let throwaway code become a production dependency. Counterbalances SM-1.

## 8. Open Questions

1. **(D1) Rose Note composition & reset loss-allocation** — does one Note bundle both legs (market-neutral holder) or do L/S trade separately (zero-sum, directional)? Who is counterparty to the losing leg's locked loss at a reset, and what does the holder hold afterward? *Deferred; resolve with architecture before build. Blocks final instrument design.*
2. **Funds-raised target & date** for SM-1 — board to define (post-P0 real-capital step).
3. **The two offshore jurisdictions** (Trading Co. = Jurisdiction 1; Coin Issuer Co. = Jurisdiction 2) — not yet identified.
4. **ERC-3643 claim-issuer & transfer-agent operating model** — who operates the trusted issuer and the transfer-agent/administrator role; how allowlist/claims are administered. (Chain decided: Sepolia in P0.)
5. **Single-source rule equivalence** — the mechanism keeping off-chain `flow_permissions` and on-chain compliance rules provably equivalent (FR-19).
6. **Reconciliation cadence & chain finality** — on-demand vs scheduled vs per-event; reorg/finality handling (FR-10).
7. **Floor-parameter method** — the defensible method for choosing `m` and `g` that makes SM-C1 falsifiable.

## 9. Assumptions Index

*Remaining `[ASSUMPTION]` tags for confirmation:*
- §3 / §4.5 FR-22 — which entity holds the transfer-agent/administrator role (→ §8 Q4).
- §4.3 FR-19 — the single-source mechanism keeping off-chain and on-chain rules equivalent (→ §8 Q5).
- §4.4 FR-10 — reconciliation cadence and chain finality/reorg handling (→ §8 Q6).
- §10 NFR-7 — no hard latency budget set for P0 (directional).
- §12 — specific securities-law / "sophisticated client" eligibility rules for `laplace.digital` distribution (for legal counsel; shapes allowlist/claim criteria).
- §14 — degree of P0 `laplace.digital` marketplace integration.

*Resolved during review (now firm — see `.decision-log.md`):* P0 = live testnet/paper slice (Sepolia + paper); tokens via custom ERC-3643-compatible contract (OpenZeppelin) on EVM; chain = source of truth, ledger corrected to chain; off-chain ledger = accounting record; SPEC superseded; BTC at L=1 stress test; L per-pair; hybrid value+quantity ledger; integers + BigInt/NUMERIC; SM-1 no target; minimal roadmap; TypeScript default + Rust/Go hot paths; KYC self-service out, ERC-3643 identity infra in; all surfaces functional.

---

## 10. Cross-Cutting NFRs

- **NFR-1 Integrity-by-construction.** Accounting invariants (double-entry balance; no persistent orphan leg) are enforced by the data layer and survive application bugs.
- **NFR-2 Exact arithmetic.** Monetary amounts are **integers in the smallest unit** of their asset; **binary floating point is prohibited** in PROD. Use **`BigInt` in code**; use **`NUMERIC` (arbitrary precision) when `bigint`/int64 is insufficient** (notably 18-decimal tokens). Each account stores its asset's **decimal scale**. Fractional intermediates (e.g. `K/2`, `L·r`) use a **deterministic remainder/rounding policy** so posted integers preserve `V_A + V_B = K` exactly within the barrier.
- **NFR-3 Auditability.** Every capital movement is attributable to a journal entry (with `description`) and a `postTransfer` call (off-chain) and to an on-chain transaction (on-chain); the ledger is append-oriented; ledger and chain are reconcilable (FR-10).
- **NFR-4 Authorization is fail-closed, off-chain and on-chain.** The default answer to any unrecognized movement is "no", at `postTransfer` and at the on-chain compliance layer. Absent configuration (e.g. a missing floor) yields refusal, never a permissive default.
- **NFR-5 Migration discipline.** Schema migrations are versioned and reversible from the first commit.
- **NFR-6 Test-first on invariants.** The §4.1/§4.2/§4.3 invariants (incl. on-chain compliance) are covered by tests before application logic.
- **NFR-7 Real-time orientation; performance-critical paths in Rust/Go.** The architecture assumes continuous operation; latency-sensitive modules (execution/matching, real-time pricing/rebalancing) are Rust or Go, with **TypeScript the default** elsewhere. P0 must not bake in batch-only assumptions. `[ASSUMPTION: no hard latency budget for P0; directional.]`
- **NFR-8 Substitutability.** Authorization (and on-chain compliance configuration) sit behind interfaces so implementations swap without caller changes.
- **NFR-9 Ledger ↔ chain consistency, chain authoritative.** The chain is the source of truth for token ownership; the off-chain ledger is reconciled and **corrected toward the chain** on divergence. Dual writes (ledger + chain) use an outbox/saga with the **on-chain transaction as the commit point**, plus idempotency and compensation; reconciliation provides the backstop.

## 11. Constraints & Guardrails

### 11.1 Two-regime build discipline (safety)
- One repository, two labelled regimes: **PROD** (`/prod`) and **Throwaway** (`/throwaway`). **`/prod` never imports `/throwaway`** (reverse tolerated); enforced in CI where possible. The regime boundary is **orthogonal to language** (a Rust/Go hot-path module is still PROD).

### 11.2 Parked parameters (correctness)
Unset by decision; read from config; absence → explicit refusal, never a default: **Note coupon; use-of-proceeds split; conversion-to-participation; backing-float contractual floor; model floor parameters `m` (safety margin) and `g` (worst plausible gap).**

### 11.3 Sequencing & no-accidental-real-money guardrail
- No component that touches real client money or real backing advances until the corresponding invariant is proven in software. **P0 touches no real money** — Sepolia testnet + paper execution by design. Because the testnet/paper boundary is a **runtime/config switch** rather than an absent feature, the code must not create a path by which real-money operation becomes possible by accident: switching to real capital/mainnet must be an explicit, gated, reviewed change, not a config flip — and the off-chain ledger + on-chain compliance must both be in force first.

## 12. Regulatory, Legal & Jurisdictional

*Context that bounds the Engine. **P0 itself runs on Sepolia testnet + paper execution with no real capital**, so live regulatory exposure is deferred; the structure below is what the Engine is built toward for the post-P0 real-capital step.*

- **Fund wrapper:** a **Singapore VCC** sub-fund ("Rose Perpetual Strategies Sub-Fund"), regulated vehicle and Note issuer.
- **Licensed management:** a **licensed investment manager** (Namara Wealth Advisors).
- **Entity separation:** regulated fund activity, trading, and token issuance separated across distinct entities and **two offshore jurisdictions** (Trading Co. = **Jurisdiction 1 — TBD**; Coin Issuer Co. = **Jurisdiction 2 — TBD**); economic risk/control consolidated at the VCC. VCC handles cash/NAV only; trading and token treasuries live in the operating entities.
- **Permissioned security tokens:** L/S tokens are **ERC-3643-compatible**; only identity-verified, allowlist-eligible holders (gated on off-chain KYC/AML/accreditation) can hold/transfer; transfer restrictions (incl. Model-A) and pair coupling enforced on-chain by the custom contract; standard agent powers (forced transfer, recovery, freeze, pause) available to the transfer-agent role.
- **Client-collateral segregation:** the **Model-A bright line**, enforced **off-chain (FR-8) and on-chain (FR-19)**.
- **Surplus / non-profit:** ROSE operates through a **Swiss non-profit**; surplus is partly directed to commons. *(Context.)*
- `[ASSUMPTION: specific securities-law / marketing-restriction / "sophisticated client" eligibility rules for `laplace.digital` distribution are for legal counsel (e.g. AUSIA); they shape the allowlist/claim criteria. Out of P0 build scope.]`

## 13. Capital Structure & Commons (context)

- Investors subscribe to **Rose Notes** at the VCC; P&L accrues to the VCC via its equity ownership in Rose Holding and, indirectly, the Trading Co.
- The Engine is the **funding gateway** ("Engine-first → Funding-first"): it must work and generate surplus before downstream ROSE domains and the Commons hardware lab can be funded.
- Engine success is also a **demonstration effect** — proof that a different, non-extractive financial logic can work in practice, redirecting value rather than extracting it. The **Commons allocation** is the purpose the surplus serves; out of P0 scope, but it is *why* spine safety and model validity matter.

## 14. Integration & Dependencies

- **EVM / custom ERC-3643-compatible stack** — token contracts (OpenZeppelin base + ROSE compliance rules), ONCHAINID, claim issuer, deployed on **Sepolia testnet** in P0. A **P0 dependency**.
- **Laplace precedent** (`laplace.digital`) — proven tokenised-note distribution pattern ROSE is modelled on; **not a code dependency** (greenfield).
- **Distribution surface** — eligible Subscribers reach Rose Notes via `laplace.digital`. `[ASSUMPTION: degree of P0 marketplace integration TBD.]`
- **Trading venue** — P0 execution is **paper/testnet** (no real CEX/DEX integration); real venues are post-P0.
- **Price data** — historical tick files (CSV) for validation; no live OANDA/LMAX feed in P0.

## 15. Risk & Mitigations

- **Model risk — conditional issuer-neutrality.** `V_A+V_B=K` holds *within the barrier*; a price gap past the floor can break it and leave a leg short. This is the **key model risk**, not an edge case. *Mitigation:* threshold-only rebalancing with a defensibly chosen floor (SM-C1); the simulator explicitly tests for floor-gap breaches (FR-17); BTC stress test (§4.7).
- **Reset loss-allocation undefined (D1).** Until §8 Q1 is resolved, the instrument's risk to holders is unspecified. *Mitigation:* parked as a blocking open question before build; SM-2 scoped to the invariant, not the loss-allocation.
- **Exchange-venture precedent.** ROSE's own materials cite a **successful (Oanda)** and a **failed (Lykke)** exchange venture. Lykke's failure (a collapsed exchange) is directly relevant. *Mitigation:* treat Lykke's failure modes (custody, solvency, run risk) as a named review input before any real-capital step; greenfield design avoids inheriting flawed infrastructure.
- **Segregation breach.** *Mitigation:* single chokepoint + default-deny + DB-enforced balance + **on-chain compliance** + tested bright line (FR-3, FR-7, FR-8, FR-19).
- **Ledger ↔ chain drift / dual-write failure.** *Mitigation:* chain authoritative; outbox/saga with on-chain commit point; reconcile-and-correct backstop (FR-10, NFR-9).
- **Regime leakage / accidental real-money path.** *Mitigation:* CI dependency rule (§11.1); explicit gated switch to mainnet (§11.3).
- **Silent-default risk.** *Mitigation:* refuse-on-absent for all parked params incl. m/g (NFR-4, §11.2).
- **Scope/feasibility risk of a wide P0.** *Mitigation:* testnet/paper removes the hardest hardening; the slice is "sufficient precision," not maximal elaboration (§1, §6).

## 16. Stakeholders & Approvals — and Audit Trail

- **Approvers / steerers:** ROSE board / stakeholders (model confidence on SM-2/SM-3; go/scale toward real capital).
- **Accountable for build:** InTech + collaborating engineers.
- **Investment mandate:** Namara Wealth Advisors (licensed IM).
- **Legal/regulatory:** counsel (e.g. AUSIA — Thibault Verbiest) shapes eligibility/claim criteria and jurisdiction selection.
- **Domain credibility (board context):** contributors include James Glattfelder (complexity science / intrinsic time), Rémy Klammers (Namara), and the InTech engineering side — the "why trust this" roster.
- **Audit trail / decision provenance:** the ledger (with entry descriptions) and the chain are the financial audit trail (NFR-3); this PRD's decisions are logged in `.decision-log.md`.

## 17. Roadmap & Phasing
*Minimal and honest — no roadmap document exists yet. The P0 boundary (§6) is firm; beyond it, only directions present in source docs, **unphased and undated**.*

- **P0 — the MVP (this PRD):** off-chain ledger spine + coupled-pair contract + dual off-chain/on-chain authorization + reconciliation (correcting to chain) + **live small-scale subscription/execution/ERC-3643 mint+burn on Sepolia + paper execution** + model validation. Prove the whole loop and the model, with no real capital.
- **Beyond P0 (directions, not commitments):** resolve D1 (instrument design); move to **real capital / mainnet / real venues** (board-gated); **Intraday Money Market** as the intended productization target ("the first step to a global liquidity pool") that the P0 slice precedes; execution scale-up (Rust/Go hot paths) and volume; multi-pair / multi-asset; cross-jurisdiction (e.g. Cayman) reconciliation; broader Subscriber surfaces. **To be formalized in a dedicated roadmap.**

## 18. Why Now

Settlement still takes T+2 while markets move in milliseconds; no intraday money market exists; liquidity is trapped overnight. The gap between a fully digital "underneath" and today's batch infrastructure is the opening, and **intrinsic time** plus the **coupled pair** are what make entering it both *real-time* and *risk-bounded* rather than speculative — which is exactly why P0 proves the mechanism (and the on-chain compliance that keeps it regulated) on a small testnet/paper scale before any real capital rests on it.

---

## P0 Acceptance Criteria

- [ ] An unbalanced entry is rejected by the database (test). *(FR-3)*
- [ ] A transfer of client-collateral principal to treasury is rejected by `postTransfer` (test). *(FR-8)*
- [ ] An on-chain L/S token transfer that violates eligibility, Model-A, or pair coupling is rejected by the custom contract (test). *(FR-19)*
- [ ] A transfer not covered by a `flow_permissions` rule is rejected by default (test). *(FR-8)*
- [ ] A coupled-pair issuance mints a paired ERC-3643 package on Sepolia, records one balanced entry, and is seen in the group view (test). *(FR-13, FR-18)*
- [ ] A redemption burns the whole package and reconciles supply ↔ ledger (test). *(FR-21)*
- [ ] An agent power (e.g. recovery) is callable only by the transfer-agent role (test). *(FR-22)*
- [ ] Reconciliation detects a deliberately introduced ledger↔chain mismatch and corrects the ledger toward the chain (test). *(FR-10)*
- [ ] Substituting a fake `AuthorizationProvider` requires no change to calling code (test). *(FR-5)*
- [ ] A subscription drives the full loop end-to-end on testnet/paper at small scale (demonstration). *(FR-11, SM-1)*
- [ ] The simulator shows V_A+V_B=K within the barrier and no negative leg over a EUR/USD tick set, flags any floor-gap breach, and exercises the full lifecycle (test). *(FR-15, FR-17)*
