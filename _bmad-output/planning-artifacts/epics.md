---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - '_bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/prd.md'
  - '_bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/DESIGN.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/EXPERIENCE.md'
---

# rose-engine - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for rose-engine, decomposing the requirements from the PRD, Addendum, and Architecture into implementable stories.

> **Glossary discipline.** This document uses PRD §3 terms exactly (Coupled pair, Leg, Rose Note, L-Token/S-Token, postTransfer, Authorization Provider, Model-A bright line, etc.). Synonyms are a discipline violation.
>
> **Governing precedence.** Where `docs/SPEC.md` and the PRD disagree, the **PRD governs**. P0 is a full vertical-slice MVP on **Sepolia testnet + paper execution, with no real capital**.

## Requirements Inventory

### Functional Requirements

**Consolidated Double-Entry Ledger (§4.1)**

- **FR-1: Record entities and typed accounts** — Model the four fixed entities (`VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`), each with a `jurisdiction`, and under each, accounts of the five fixed types (`BACKING_FLOAT`, `DEPLOYED_CAPITAL`, `CLIENT_COLLATERAL`, `FEE_INCOME`, `NOTE_LIABILITY`), each with an asset and decimal scale. Entity set fixed to four codes; no dynamic entity creation. Routing rule: VCC = cash/NAV only; exchange accounts under `TRADING_CO`; coin treasury / on-chain liquidity under `COIN_ISSUER`.
- **FR-2: Record balanced journal entries with postings** — Record a journal entry of two or more postings (debits/credits) against accounts, with a non-empty human-readable `description` and an optional link to a coupled pair. Amounts are integers in smallest units; no binary-float amount can be stored.
- **FR-3: Enforce the double-entry invariant in the database** — For every journal entry, Σ debits = Σ credits, enforced as a database-level guarantee. Persisting an unbalanced entry fails the transaction; no partial state remains; the guarantee cannot be bypassed by writing postings directly.
- **FR-13: Record a coupled-pair issuance as one balanced entry** — Issuing a pair records both legs in a single balanced journal entry linked to the pair, alongside the on-chain mint (FR-18). One cannot record an issuance of a single leg.

**Coupled-Pair Contract & Lifecycle (§4.2)**

- **FR-6: Persist the coupled-pair shared data model (inter-track contract)** — Store a coupled pair as: identifier, reference asset, anchor price P₀, leverage L, collateral pool K, floor f, lifecycle state, timestamps. The schema cannot represent a persistent single-leg pair. **L is a per-pair parameter** (never hard-coded).
- **FR-4: Represent the pair lifecycle states** — A pair moves through `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED`. Transitions are explicit; `PARTIAL` is a known transient mid-rebalance state; the full lifecycle can be traversed and observed.
- **FR-12: Embed a coupled pair in a Note, delta-neutral at issuance** — A Rose Note references exactly one coupled pair whose legs offset at issuance (market-neutral on the underlying); directional risk arises only from strategy.

**Capital-Flow Authorization (§4.3)**

- **FR-7: Route all off-chain capital movements through a single chokepoint** — All inter-account capital movement occurs via `postTransfer(from, to, amount, context)`; no other path writes transfer postings. `postTransfer` consults the Authorization Provider before any write.
- **FR-8: Default-deny authorization with the minimal P0 rule set** — `postTransfer` rejects any transfer not explicitly permitted by a `flow_permissions` rule. Allowed: `FEE_INCOME`→treasury; yield on `CLIENT_COLLATERAL`→treasury. Rejected: `CLIENT_COLLATERAL` *principal* leaving the client account (Model-A); any transfer pushing `BACKING_FLOAT` below its floor (refuse if floor config absent, never 0); any uncovered transfer (default-deny). Token/trading flows do not route through VCC.
- **FR-5: Provider substitutability (interface isolation)** — The Authorization Provider is an interface; swapping implementations (e.g. a fake/alternate provider) requires no change to calling code.
- **FR-19: Enforce the same restrictions on-chain via a custom ERC-3643-compatible contract** — Token transfers of L-Token/S-Token are governed by on-chain compliance rules (OpenZeppelin base) encoding eligibility, the Model-A bright line (incl. principal/yield distinction via segregated principal sub-positions), and pair coupling. On-chain rules are derived from the same single rule specification as off-chain `flow_permissions` so the two cannot silently diverge.

**Reconciliation & Group View (§4.4)**

- **FR-9: Produce the consolidated group view** — `reconcile` outputs per-entity, per-account-type balances plus the consolidated group view, as human-readable text and structured JSON. A balanced, chain-consistent ledger reports no divergence.
- **FR-10: Verify per-entity/consolidated AND ledger↔chain consistency; correct toward chain** — Reconciliation checks per-entity sums against consolidated figures, and ledger token quantities against on-chain balances; a token-ownership divergence is reported **and** the ledger is corrected to match the chain with a journaled correcting entry.

**Rose Note Lifecycle (§4.5)**

- **FR-11: Live subscription and redemption of Rose Notes** — An eligible Subscriber subscribes to and redeems Rose Notes at the VCC level in fiat or crypto; each produces balanced journal entries (incl. `NOTE_LIABILITY`), respecting the chokepoint and segregation rules. Only allowlist-eligible Subscribers (valid ONCHAINID claim) can receive tokens.
- **FR-18: Mint paired ERC-3643 L/S tokens on EVM (Sepolia in P0)** — Issuing a pair mints one L-Token and one S-Token at equal notional via the custom contract on Sepolia, recorded in the ledger (quantity + value) and reconcilable to chain. The paired (atomic, both-or-neither) mint is contract-enforced; a single-leg mint is impossible.
- **FR-21: Burn / retire tokens on redemption** — Redeeming a Note burns the whole coupled token package (both legs) on-chain with matching ledger entries; post-redemption on-chain supply and ledger quantities reconcile.
- **FR-22: Privileged transfer-agent / agent powers** — The custom contract exposes ERC-3643 agent powers (forced transfer, recovery/lost-key reissue, freeze, pause) callable only by the designated transfer-agent/administrator role; unauthorized calls revert; recovery preserves eligibility and audit trail.
- **FR-20: Execute coupled-pair strategy (paper/testnet, small-scale)** — The Trading Co. executes strategy in paper/testnet mode (no real CEX, no real capital), with positions/P&L flowing to the ledger tagged to the executing entity and visible in the group view.

**Engine Surfaces (§4.6)**

- **FR-14: Provide the Engine surfaces, all functional in P0** — Provide functional Covenant Console (group NAV, per-entity balances, float yield, exposure), Coupled-Pair view (V_A, V_B, K, floor, anchor + holding), Exchange/Trading view, and Subscriber surfaces (subscribe/redeem/view position), all reading live data from ledger/chain/strategy. No hard-coded mockup surfaces in P0.

**Coupled-Coin Model Validation — the trial (§4.7, Throwaway regime)**

- **FR-15: Implement the coupled-coin reference math with the issuer-neutral invariant** — A library computes leg values from price (`V_A=(K/2)(1+L·r)`, `V_B=(K/2)(1−L·r)`), verifies `V_A+V_B=K` within the barrier, and detects floor breaches (`f=m·L·g`). No leg goes negative while price stays within the barrier.
- **FR-16: Simulate threshold-only rebalancing over historical ticks** — The simulator replays ticks (CSV `timestamp,price`) and triggers a reset **only** when a losing leg breaches floor f — never on a clock. At reset, current values are locked, P₀ re-anchors to current price, and the losing holder's loss is locked.
- **FR-17: Prove no-negative-leg and journal every reset over a tick set** — Over a tick set the simulator demonstrates no leg goes negative, reports any floor-gap breach (issuer-neutrality break condition), journals every reset (price, locked values, new anchor), and exercises the full pair lifecycle end-to-end.

### NonFunctional Requirements

- **NFR-1 Integrity-by-construction** — Accounting invariants (double-entry balance; no persistent orphan leg) are enforced by the data layer and survive application bugs.
- **NFR-2 Exact arithmetic** — Monetary amounts are integers in the smallest unit; binary floating point is prohibited in PROD. Use `BigInt` in code; `NUMERIC` (arbitrary precision) when `bigint`/int64 is insufficient (18-decimal tokens). Each account stores its asset's decimal scale. Deterministic remainder/rounding policy preserves `V_A+V_B=K` exactly within the barrier.
- **NFR-3 Auditability** — Every capital movement is attributable to a journal entry (with `description`) and a `postTransfer` call (off-chain) and to an on-chain transaction (on-chain); ledger is append-oriented; ledger and chain are reconcilable.
- **NFR-4 Authorization is fail-closed, off-chain and on-chain** — Default answer to any unrecognized movement is "no", at `postTransfer` and at the on-chain compliance layer. Absent configuration (e.g. a missing floor) yields refusal, never a permissive default.
- **NFR-5 Migration discipline** — Schema migrations are versioned and reversible from the first commit.
- **NFR-6 Test-first on invariants** — The §4.1/§4.2/§4.3 invariants (incl. on-chain compliance) are covered by tests before application logic.
- **NFR-7 Real-time orientation; performance-critical paths in Rust/Go** — Architecture assumes continuous operation; latency-sensitive modules sit behind clean interfaces (TS default in P0; re-implementable in Rust/Go post-P0 without caller changes). No batch-only assumptions baked in.
- **NFR-8 Substitutability** — Authorization (and on-chain compliance configuration) sit behind interfaces so implementations swap without caller changes.
- **NFR-9 Ledger ↔ chain consistency, chain authoritative** — Chain is the source of truth for token ownership; the off-chain ledger is corrected toward the chain on divergence. Dual writes use an outbox/saga with the on-chain transaction as the commit point, plus idempotency and compensation; reconciliation is the backstop.

### Additional Requirements

*(Technical requirements from Architecture and Addendum that impact epic/story creation.)*

**Starter / Scaffold (FIRST IMPLEMENTATION STORY — Architecture §"Selected Approach"):**

- Custom **pnpm + Turborepo monorepo** on **Node.js 24 LTS** (no monolithic starter). Top-level `/prod` and `/throwaway` regime roots; `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`.
- **CI regime-boundary guard** asserting `/prod` never imports `/throwaway` (`tools/check-regime-boundary.mjs`).
- TypeScript 5.x, ES modules, `strict` everywhere; `tsx` dev, `tsc` project references; **Vitest** (TS) + **Foundry/`forge`** (Solidity); ESLint + Prettier.
- Foundry init under `prod/contracts`; `forge install OpenZeppelin/openzeppelin-contracts`.

**Data layer:**

- **PostgreSQL 18.4** (no SQLite in PROD); **Drizzle ORM 0.45.x + drizzle-kit**, SQL-first.
- Double-entry invariant via a **`DEFERRABLE INITIALLY DEFERRED` constraint trigger** on `postings`, shipped as a **raw-SQL migration**.
- Versioned, **reversible migrations from the first commit**; migrations never edited after merge (forward + down only); CI runs forward/rollback.
- Coupled-pair field types frozen first: `anchor_price decimal(18,8)`, `leverage decimal`, `collateral_pool NUMERIC`, `floor decimal`, `state` enum, `reference_asset text`, `timestamptz`.
- **Zod** schemas at every boundary; domain types derived from Zod + Drizzle.

**On-chain stack:**

- EVM on **Sepolia testnet**; custom ERC-3643-compatible token on **OpenZeppelin Contracts 5.6.x**, referencing **Tokeny T-REX / ERC-3643** and **ONCHAINID (ERC-734/735)**.
- ONCHAINID registry, trusted **claim issuer**, claim-topics/trusted-issuers registries, curated allowlist.
- **Foundry** toolchain (forge/cast/anvil) with **fuzz + invariant tests**; deploy via `forge script` to Sepolia.
- **viem 2.52.x** for TS↔chain interaction (typed clients, ABI inference, event subscriptions).

**Consistency & rules:**

- **Single-source declarative rule-spec + codegen**: one versioned rule spec (JSON/DSL) emits both off-chain `flow_permissions`/`OffChainPolicyProvider` config and on-chain compliance config; shared **conformance test vectors** run against both planes.
- **Outbox/saga** with the on-chain tx as commit point, idempotency keys, compensation; chain events ingested via viem watchers into `outbox_events`/reconcile; on-chain tx hash recorded on related journal entries.
- **Reconciliation cadence (default):** per-event (on each confirmed mint/burn/transfer) **plus** on-demand `reconcile`; act on configured Sepolia confirmation depth; treat a reorg below that depth as a reconciliation event.

**API & surfaces:**

- Typed **REST over Fastify** with **Zod** validation and an **OpenAPI** document; structured error format `{ error: { code, message, details? } }`; money serialized as **decimal strings** (never JS number/float), each carrying/referencing `decimalScale`.
- **React 18 + Vite + TypeScript**, **TanStack Query + TanStack Router**, component library (shadcn/ui or Mantine); generated API types shared from backend; explicit loading/empty/error states; live data only.

**Config / security / ops:**

- **Typed config loader** that **refuses on absent parked parameters** (Note coupon, use-of-proceeds split, conversion-to-participation, backing-float floor, model floor params `m` and `g`). `.env` + `.env.example`; no secrets in client-side code; deployer/transfer-agent keys handled out-of-band.
- **No-accidental-real-money guardrail:** testnet/paper↔real is a gated runtime switch, never a config flip to mainnet/real capital.
- **TS-only in P0** with clean interface seams for Rust/Go hot paths post-P0 (NFR-7).
- Local dev via **docker-compose** (PostgreSQL 18 + Anvil/Sepolia RPC).
- **CI/CD GitHub Actions:** typecheck, ESLint, Vitest, `forge test` (incl. invariant/fuzz), drizzle migration check, regime dependency rule.
- **Structured logging** at key decision points (postTransfer authorize/deny, mint/burn, outbox commit, reconcile divergence/correction) including entity, account, journal-entry id, on-chain tx hash.

**Documentation handoff:**

- Update `docs/SPEC.md` to reflect PRD-governed P0 scope (EVM/ERC-3643/mint/subscription/paper execution now in P0).

**Deferred (product/legal/board — accommodate, do not resolve in P0):**

- **D1** Rose Note composition & reset loss-allocation (§8 Q1) — **RESOLVED 2026-06-16: separate L/S, zero-sum directional; losing-leg holder bears the locked loss.** **D1a RESOLVED: crystallised & withdrawable** — each reset realizes/settles the locked P&L (winner withdrawable, loser settled) and both legs re-base symmetric. Forward *implementation*: directional one-leg note shape → Epics 4–6; reset settlement (cash + journal) → Epics 5–7.
- Two offshore jurisdictions (§8 Q3); claim-issuer / transfer-agent operating model (§8 Q4) — config/role placeholders.
- Floor-parameter method for `m`/`g` (§8 Q7, SM-C1) — chosen by a stated, defensible method before observing reset rate; config-driven, refuse-if-absent.

### UX Design Requirements

A targeted UX Design Specification was produced this session for the four Engine Surfaces (FR-14): `ux-designs/ux-rose-engine-2026-06-15/DESIGN.md` (visual identity) and `EXPERIENCE.md` (behavior). Direction: **sober institutional fintech**, single **ROSE rosé** accent, **light + dark** semantic tokens, **shadcn/ui** on React 18 + Vite + TanStack; two form-factors (operator desktop / subscriber responsive). The following actionable UX-DRs are extracted; each is covered by at least one Epic 6 story.

- **UX-DR1: Sober-institutional design system as semantic tokens (light/dark toggle).** Implement the DESIGN.md token set on shadcn/ui — rosé `primary` (brand only), financial semantic tokens (`gain`/`loss`/`warn`/`info`), a monospace `numeric` type role, crisp radii, pill status badges. Components reference semantic tokens only (no raw hex); both modes first-class with a persisted toggle.
- **UX-DR2: Money & numeric display contract.** Every figure renders in tabular mono, right-aligned, sourced from **decimal strings** with asset symbol + decimal scale always shown; **no JS float**; no truncation of monetary values; deltas show sign + glyph (`▴`/`▾`) + semantic color (never color-only). Leg values shown with `V_A + V_B = K`, floor, anchor, and current P together (distance-to-floor legible).
- **UX-DR3: Lifecycle status-badge component.** A pill component mapping the six pair lifecycle states (`PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`) plus `live` / `divergent` / `pending`, always label-bearing.
- **UX-DR4: Live-data & consistency state patterns.** Live/stale indicator (green pulse → warn + last-updated), pending-on-chain-tx state, and a ledger↔chain **divergence banner** that states the correction-toward-chain and links to the journaled correcting entry. Every surface defines explicit loading / empty / error states (no implicit states; live data only, no mockups).
- **UX-DR5: Authorization Refusal UX (fail-closed, visible).** Refusals are surfaced explicitly with the **rule named** (Model-A bright line, eligibility, pair coupling, default-deny) using the machine `code` — never a silent success and never a generic error (NFR-4).
- **UX-DR6: Deliberate write actions — confirm + eligibility gate.** Subscribe/redeem use a **Review → Confirm** panel that states the on-chain consequence and stays **pending until the on-chain commit point** (pessimistic, no optimistic success); the subscribe path is gated on a valid ONCHAINID eligibility claim with an explicit reason when absent (no self-service KYC).
- **UX-DR7: Audit drill-down navigation.** Drill from group → entity → account → journal entry → on-chain tx hash, with a copy-tx-hash affordance — the audit trail is the surface (NFR-3).
- **UX-DR8: Two form-factors + accessibility floor.** Operator surfaces desktop-dense (≥1280px); Subscriber surfaces responsive (phone→desktop). **WCAG 2.2 AA** in both color modes; no color-only signaling; full keyboard operability; screen-reader announces money with unit + scale and lifecycle state.

**UX-DR coverage:** UX-DR1/2/3 → Story 6.5 (establishes the design system + shared data-product components, reused by 6.6); UX-DR4 → Stories 6.5, 6.6 (and the divergence banner consumes FR-10 from Epic 5); UX-DR5 → Stories 6.1, 6.2; UX-DR6 → Stories 6.2, 6.3; UX-DR7 → Story 6.5; UX-DR8 → Stories 6.5, 6.6.

### FR Coverage Map

> **Note on FR count:** the PRD/Architecture prose says "21 FRs", but the actual ID set is **FR-1 … FR-22 with no gaps = 22 FRs**. All 22 are mapped below.

- **FR-1** → Epic 1 — Record entities and typed accounts
- **FR-2** → Epic 1 — Record balanced journal entries with postings
- **FR-3** → Epic 1 — Enforce double-entry invariant in the database
- **FR-4** → Epic 2 — Represent the pair lifecycle states
- **FR-5** → Epic 3 — Authorization Provider substitutability
- **FR-6** → Epic 2 — Persist the coupled-pair shared data model (inter-track contract)
- **FR-7** → Epic 3 — Single off-chain capital-movement chokepoint (`postTransfer`)
- **FR-8** → Epic 3 — Default-deny authorization with the minimal P0 rule set
- **FR-9** → Epic 5 — Produce the consolidated group view
- **FR-10** → Epic 5 — Verify per-entity & ledger↔chain consistency; correct toward chain
- **FR-11** → Epic 6 — Live subscription and redemption of Rose Notes
- **FR-12** → Epic 2 — Embed a coupled pair in a Note, delta-neutral at issuance
- **FR-13** → Epic 2 — Record a coupled-pair issuance as one balanced entry
- **FR-14** → Epic 6 — Provide the Engine surfaces, all functional in P0
- **FR-15** → Epic 7 — Coupled-coin reference math with issuer-neutral invariant
- **FR-16** → Epic 7 — Simulate threshold-only rebalancing over historical ticks
- **FR-17** → Epic 7 — Prove no-negative-leg and journal every reset
- **FR-18** → Epic 5 — Mint paired ERC-3643 L/S tokens on Sepolia
- **FR-19** → Epic 4 — Enforce restrictions on-chain via custom ERC-3643-compatible contract
- **FR-20** → Epic 6 — Execute coupled-pair strategy (paper/testnet)
- **FR-21** → Epic 5 — Burn / retire tokens on redemption
- **FR-22** → Epic 4 — Privileged transfer-agent / agent powers

**NFR coverage:** NFR-1/2/3/5/6 → Epic 1 (data-layer integrity, exact arithmetic, auditability, reversible migrations, test-first); NFR-4/8 → Epic 3 (fail-closed, substitutability); NFR-9 → Epic 5 (ledger↔chain, chain authoritative); NFR-7 (real-time orientation, seams) → cross-cutting, honored in Epics 5 & 6.

## Epic List

### Epic 1: Project Foundation & Double-Entry Ledger Spine
Stand up the two-regime monorepo and the consolidated double-entry ledger so that an operator/engineer can record balanced journal entries across the four fixed entities and typed accounts, with the **database itself** rejecting any unbalanced entry. This is the accounting system of record and the bedrock of trust for everything that follows.
**FRs covered:** FR-1, FR-2, FR-3
**NFRs:** NFR-1, NFR-2, NFR-3, NFR-5, NFR-6
**Includes (additional reqs):** pnpm+Turborepo scaffold, `/prod`↔`/throwaway` regime CI guard, PostgreSQL 18 + Drizzle, double-entry `DEFERRABLE` trigger (raw SQL), reversible migrations, `shared` money/BigInt+decimal-scale utils, typed config loader (refuse-if-absent), CI scaffold.
**Standalone:** Yes — delivers a provably-balanced ledger independent of any later epic. Enables all others.

### Epic 2: Coupled-Pair Contract & Lifecycle
Persist and freeze the **coupled-pair shared data model** — the inter-track contract every downstream track consumes — with per-pair leverage L, the full lifecycle state machine, and issuance recorded as one balanced journal entry. The schema makes a persistent single-leg pair unrepresentable.
**FRs covered:** FR-6, FR-4, FR-12, FR-13
**Standalone:** Yes — builds only on Epic 1's ledger; the contract is consumed by authorization, chain, reconciliation, and surfaces, so it is frozen first.

### Epic 3: Capital-Flow Authorization — Single Chokepoint & Single-Source Rules
Route every off-chain capital movement through one default-deny `postTransfer` chokepoint, enforce the minimal P0 rule set (incl. the Model-A bright line), keep the Authorization Provider substitutable, and establish the **single-source rule-spec + codegen + conformance vectors** that both planes derive from.
**FRs covered:** FR-5, FR-7, FR-8
**NFRs:** NFR-4, NFR-8
**Includes (additional reqs):** `rule-spec` package (versioned DSL/JSON), codegen emitting off-chain `flow_permissions`, conformance test vectors (off-chain plane), `OffChainPolicyProvider`.
**Standalone:** Yes — builds on Epics 1–2; the rule-spec it creates is reused on-chain in Epic 4.

### Epic 4: On-Chain Permissioned Tokens & Compliance (ERC-3643 on Sepolia)
Deliver the custom ERC-3643-compatible token suite on Sepolia that enforces eligibility, the Model-A bright line, and pair coupling **on-chain** (compliance config derived from the same rule-spec as off-chain), plus ONCHAINID identity/allowlist infrastructure and transfer-agent agent powers.
**FRs covered:** FR-19, FR-22
**Includes (additional reqs):** OpenZeppelin 5.6 + Foundry, ONCHAINID registry + trusted claim issuer + claim-topics/trusted-issuers registries, curated allowlist, fuzz/invariant Solidity tests, `forge script` deploy to Sepolia, conformance vectors run against the on-chain plane.
**Standalone:** Yes — consumes Epic 3's rule-spec; delivers the on-chain enforcement plane and is deployable/testable on its own.

### Epic 5: Ledger↔Chain Integration — Mint, Burn & Reconciliation
Wire the off-chain spine to the chain: atomically mint paired L/S tokens on Sepolia (the commit point) and post matching balanced journal entries, burn the whole package on redemption, and run reconciliation that produces the group view and **corrects the ledger toward the chain** on token-ownership divergence.
**FRs covered:** FR-18, FR-21, FR-9, FR-10
**NFRs:** NFR-9
**Includes (additional reqs):** viem 2.52 clients, outbox/saga with on-chain tx as commit point, idempotency + compensation, reconciliation cadence (per-event + on-demand), finality-depth/reorg handling, group-view text+JSON.
**Standalone:** Yes — builds on Epics 1, 2, 4; delivers the consistency backbone proven by the deliberate-divergence reconcile-and-correct test.

### Epic 6: Live Rose Note Slice & Engine Surfaces
Prove the whole loop end-to-end on testnet/paper: an eligible Subscriber subscribes to / redeems Rose Notes, the Trading Co. executes strategy in paper mode, and all four **functional** Engine surfaces (Covenant Console, Coupled-Pair, Exchange/Trading, Subscriber) render live data.
**FRs covered:** FR-11, FR-20, FR-14
**NFRs:** NFR-7 (clean interface seams on execution paths)
**Includes (additional reqs):** Fastify REST + Zod + OpenAPI, React 18 + Vite + TanStack surfaces, money-as-decimal-strings over the wire, explicit loading/empty/error states.
**Standalone:** Yes — top of the stack; consumes all prior epics to deliver the Subscriber/operator-facing value.

### Epic 7: Coupled-Coin Model Validation — The Trial (Throwaway)
Put the coupled-coin model on trial in the **throwaway** regime: a reference-math library proving the issuer-neutral invariant `V_A+V_B=K` within the barrier and detecting floor breaches, and a threshold-only simulator that replays real EUR/USD and BTC ticks, journals every reset, proves no negative leg, and traverses the full lifecycle.
**FRs covered:** FR-15, FR-16, FR-17
**Standalone:** Yes — fully independent (`/prod` never imports `/throwaway`); can be built in parallel at any time. It is a genuine **risk boundary** (it can refute the model cheaply) and is isolated as disposable code.

---

## Epic 1: Project Foundation & Double-Entry Ledger Spine

Stand up the two-regime monorepo and the consolidated double-entry ledger so that an operator/engineer can record balanced journal entries across the four fixed entities and typed accounts, with the database itself rejecting any unbalanced entry.

### Story 1.1: Initialize the two-regime monorepo scaffold with regime-boundary CI guard

As a build engineer,
I want a pnpm + Turborepo monorepo with explicit `/prod` and `/throwaway` regimes and a CI guard enforcing the boundary,
So that I can move fast on validation code without any risk of it becoming a production dependency.

**Acceptance Criteria:**

**Given** a clean working tree
**When** I initialize the workspace following the architecture scaffold (Node 24 LTS, pnpm, Turborepo, `tsconfig.base.json`, ESLint, Prettier, Vitest, Foundry under `prod/contracts`)
**Then** `pnpm install`, typecheck, lint, and `pnpm test` all succeed on an empty scaffold
**And** top-level `/prod` and `/throwaway` regime roots exist with a `tools/check-regime-boundary.mjs` script
**And** the CI workflow (`.github/workflows/ci.yml`) runs typecheck, ESLint, Vitest, `forge test`, the migration check, and the regime guard

**Given** a file under `/prod` that imports from `/throwaway`
**When** the regime-boundary guard runs in CI
**Then** the check fails with an explicit error naming the offending import
**And** the reverse (`/throwaway` importing `/prod`) is tolerated

### Story 1.2: Provide exact-money utilities in the shared package

As a build engineer,
I want integer-smallest-unit money helpers with per-asset decimal scale and a deterministic rounding policy,
So that every PROD module represents money exactly and never uses binary float (NFR-2).

**Acceptance Criteria:**

**Given** the `shared` package
**When** I represent a monetary amount
**Then** it is stored as a `BigInt` integer in the smallest unit of its asset, with the asset's decimal scale available (EUR=2, BTC=8, token=`decimals()`)
**And** any attempt to construct an amount from a binary float is rejected at the boundary

**Given** a fractional intermediate such as `K/2` or `L·r`
**When** I apply the deterministic remainder/rounding policy (one leg absorbs the residual unit)
**Then** the posted integer amounts preserve `V_A + V_B = K` exactly
**And** the helpers serialize money as decimal strings (never JS `number`) for transport

### Story 1.3: Load configuration with refuse-if-absent for parked parameters

As an internal operator,
I want a typed config loader that refuses to start when a parked parameter is missing,
So that the system never silently defaults a correctness-critical value to zero (NFR-4, §11.2).

**Acceptance Criteria:**

**Given** a config with all required values present
**When** the typed config loader runs
**Then** it returns a validated, typed config object (Zod-validated) from `.env` / config sources

**Given** a config missing a parked parameter (Note coupon, use-of-proceeds split, conversion-to-participation, backing-float floor, model floor params `m` or `g`)
**When** the loader runs or that value is requested
**Then** it raises an explicit refusal error naming the missing parameter
**And** it never substitutes a default (e.g. 0) for the absent value

### Story 1.4: Model the four fixed entities and typed accounts with reversible migrations

As an internal operator,
I want the four fixed entities and five typed account kinds modeled in the database,
So that I have a correctly structured multi-entity book of record (FR-1).

**Acceptance Criteria:**

**Given** the ledger schema and its Drizzle migration
**When** I apply the migration and then roll it back
**Then** both the forward and down migrations succeed (versioned, reversible from the first commit — NFR-5), and CI verifies this

**Given** the migrated database
**When** I inspect the entities and accounts
**Then** exactly the four entity codes exist (`VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`), each with a `jurisdiction`, and no API path creates entities dynamically
**And** every account has one entity, one of the five types (`BACKING_FLOAT`, `DEPLOYED_CAPITAL`, `CLIENT_COLLATERAL`, `FEE_INCOME`, `NOTE_LIABILITY`), one asset, and a decimal scale
**And** account placement honors the routing rule (VCC = cash/NAV only; exchange accounts under `TRADING_CO`; coin treasury / on-chain liquidity under `COIN_ISSUER`)

### Story 1.5: Enforce the double-entry invariant in the database (test-first)

As a build engineer,
I want the double-entry balance invariant enforced by a database constraint trigger, with its tests written first,
So that an unbalanced journal entry can never persist regardless of application path (FR-3, NFR-1, NFR-6).

**Acceptance Criteria:**

**Given** the `journal_entries` and `postings` tables and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger shipped as a raw-SQL migration
**When** the invariant tests are written and run before any application recording logic exists
**Then** the tests assert that committing a journal entry where Σ debits ≠ Σ credits fails the transaction with no partial state

**Given** an attempt to write postings directly (bypassing application code)
**When** the transaction commits
**Then** the database still rejects the unbalanced set — the guarantee cannot be bypassed
**And** a balanced set of postings commits successfully

### Story 1.6: Record balanced journal entries with postings

As an internal operator,
I want to record an economic event as a balanced journal entry of two or more postings,
So that every movement is captured in the accounting system of record with an audit trail (FR-2, NFR-3).

**Acceptance Criteria:**

**Given** the ledger recording path
**When** I record a journal entry of two or more postings (debits/credits) against accounts
**Then** the entry persists only if balanced, carries a non-empty human-readable `description`, and may optionally link to a coupled pair
**And** every posting amount is an integer in smallest units (no binary-float amount can be stored)

**Given** a recorded journal entry
**When** I query the ledger
**Then** the entry is attributable and append-oriented, supporting the audit trail (NFR-3)

---

## Epic 2: Coupled-Pair Contract & Lifecycle

Persist and freeze the coupled-pair shared data model — the inter-track contract — with per-pair leverage, the full lifecycle state machine, and issuance recorded as one balanced journal entry.

### Story 2.1: Freeze and persist the coupled-pair shared data model

As a build engineer,
I want the coupled-pair schema frozen first with its exact field types,
So that every downstream track consumes one stable inter-track contract and a single-leg pair is unrepresentable (FR-6).

**Acceptance Criteria:**

**Given** the `coupled_pairs` schema and migration
**When** I inspect the persisted model
**Then** a pair carries identifier, `reference_asset` (text), `anchor_price` P₀ `decimal(18,8)`, `leverage` L `decimal` (per-pair), `collateral_pool` K (`NUMERIC`, smallest-unit), `floor` f `decimal`, `state` enum, and `timestamptz` timestamps

**Given** an attempt to persist a pair with only one leg
**When** the write is made
**Then** the schema makes a persistent single-leg pair impossible to represent
**And** `leverage` is read per-pair from the row and never hard-coded (EUR/USD and BTC both at L=1 in P0 validation)

### Story 2.2: Represent and enforce the pair lifecycle state machine

As an internal operator,
I want a pair to move only through valid lifecycle states,
So that the pair's status is always explicit and observable, including the transient mid-rebalance state (FR-4).

**Acceptance Criteria:**

**Given** an `ACTIVE` pair
**When** a lifecycle transition is requested
**Then** only transitions in `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED` are accepted, and any other transition is rejected explicitly
**And** `PARTIAL` is representable as a known transient mid-rebalance state

**Given** a pair created at `PENDING`
**When** it is driven through the complete lifecycle
**Then** the full path `PENDING → … → CLOSED` can be traversed and each state observed (supports SM-3)

### Story 2.3: Record a coupled-pair issuance as one balanced journal entry

As an internal operator,
I want issuing a pair to post both legs in a single balanced journal entry linked to the pair,
So that issuance is atomic in the accounting record and never recorded one leg at a time (FR-13).

**Acceptance Criteria:**

**Given** a pair to be issued
**When** the issuance is recorded
**Then** exactly one balanced journal entry is posted, linked to the pair, capturing both legs together
**And** the entry balances (Σ debits = Σ credits) and is reflected in per-entity/account balances

**Given** an attempt to record the issuance of a single leg
**When** the write is made
**Then** it is rejected — a single-leg issuance is impossible

### Story 2.4: Embed a coupled pair in a Rose Note, delta-neutral at issuance

As an Investment Manager,
I want a Rose Note to reference exactly one coupled pair whose legs offset at issuance,
So that the instrument is market-neutral on the underlying at issuance and directional risk comes only from strategy (FR-12).

**Acceptance Criteria:**

**Given** a Rose Note record
**When** it is created
**Then** it references exactly one coupled pair, and that pair's two legs are at equal notional (delta-neutral / market-neutral on the underlying) at issuance

**Given** the D1 product decision (was parked when Story 2.4 was built; **RESOLVED 2026-06-16: separate L/S, zero-sum directional, losing-leg holder bears the locked loss**)
**When** the Note↔pair model is implemented
**Then** the schema accommodated either interpretation without committing to one (Story 2.4 did not encode post-reset loss-allocation) — and the post-D1 changes are tracked forward, not retro-fitted into the delta-neutral issuance contract: the **one-directional-leg note shape** lands with the L/S token & position model (**Epics 4–6**, where holders first exist), and the **loss-allocation accounting** with the **reset machinery (Epics 5–7)** — now fully specified by **D1a (crystallised & withdrawable)**: each reset realizes the winner's gain, settles the loser's loss, and re-bases both legs symmetric, as a balanced settlement journal entry + cash movement

---

## Epic 3: Capital-Flow Authorization — Single Chokepoint & Single-Source Rules

Route every off-chain capital movement through one default-deny `postTransfer` chokepoint, keep the Authorization Provider substitutable, and establish the single-source rule-spec that both planes derive from.

### Story 3.1: Define the single-source rule specification and conformance vectors

As a build engineer,
I want one versioned declarative rule specification with shared conformance test vectors,
So that off-chain and on-chain authorization rules are derived from a single source and cannot silently diverge (FR-19 foundation, §8 Q5).

**Acceptance Criteria:**

**Given** the `rule-spec` package
**When** I author the rule specification
**Then** a single versioned DSL/JSON describes eligibility, transfer restrictions, the Model-A bright line, and pair coupling
**And** a shared set of conformance test vectors (allowed/denied cases) is defined to be executed against both the off-chain and on-chain planes

**Given** the rule-spec and its codegen entry point
**When** codegen runs
**Then** it produces consumable artifacts for the off-chain plane (and, later, the on-chain plane) — neither plane's rules are hand-edited independently

### Story 3.2: Provide the default-deny Authorization Provider interface (substitutable)

As a build engineer,
I want an `AuthorizationProvider` interface that defaults to deny and can be swapped without caller changes,
So that authorization is fail-closed and provider implementations are substitutable (FR-5, FR-8 default, NFR-4, NFR-8).

**Acceptance Criteria:**

**Given** the `AuthorizationProvider` interface
**When** a transfer is evaluated and no rule explicitly permits it
**Then** the provider returns deny by default (fail-closed)

**Given** a caller using the provider
**When** I substitute a fake/alternate provider implementation
**Then** no calling code changes are required (the substitution test passes)

### Story 3.3: Route all off-chain capital movement through the `postTransfer` chokepoint

As an internal operator,
I want every inter-account capital movement to pass through the single `postTransfer` function,
So that there is exactly one writer of transfer postings and it always consults authorization first (FR-7).

**Acceptance Criteria:**

**Given** the `postTransfer(from, to, amount, context)` function
**When** any inter-account capital movement occurs
**Then** it is the only path that writes transfer postings, and it consults the `AuthorizationProvider` before any write

**Given** the codebase
**When** the chokepoint guard test runs (static/dependency check + runtime guard)
**Then** it proves no module writes transfer postings outside `postTransfer`

### Story 3.4: Enforce the minimal P0 rule set via the generated off-chain policy provider

As an internal operator,
I want `OffChainPolicyProvider` to enforce the P0 `flow_permissions` rules generated from the rule-spec,
So that permitted flows pass and forbidden flows (incl. Model-A principal) are rejected off-chain (FR-8, NFR-4).

**Acceptance Criteria:**

**Given** `flow_permissions` generated from the rule-spec
**When** transfers are evaluated
**Then** `FEE_INCOME` (any entity) → treasury is **allowed**; yield on `CLIENT_COLLATERAL` → treasury is **allowed** (principal excluded)
**And** `CLIENT_COLLATERAL` *principal* → any destination outside the client account is **rejected** (Model-A bright line, UJ-3)
**And** any transfer pushing `BACKING_FLOAT` below its floor is **rejected**; if the floor config is absent it is **refused**, never treated as 0
**And** token/trading flows do not route through VCC accounts; a transfer not covered by any rule is **rejected by default**

**Given** the shared conformance vectors
**When** they are executed against the off-chain plane
**Then** they all pass, establishing the baseline the on-chain plane must also satisfy

---

## Epic 4: On-Chain Permissioned Tokens & Compliance (ERC-3643 on Sepolia)

Deliver the custom ERC-3643-compatible token suite on Sepolia that enforces eligibility, the Model-A bright line, and pair coupling on-chain, plus ONCHAINID identity infrastructure and transfer-agent powers.

### Story 4.1: Stand up ONCHAINID identity and eligibility infrastructure

As a claim issuer operator,
I want ONCHAINID identities, a trusted claim issuer, and the supporting registries,
So that only curated, allowlist-eligible holders carry the on-chain eligibility claim (FR-19 foundation).

**Acceptance Criteria:**

**Given** the Foundry contracts suite (OpenZeppelin 5.6.x base, ONCHAINID ERC-734/735 patterns)
**When** I register an ONCHAINID and issue an eligibility claim from the trusted claim issuer
**Then** the identity registry, claim-topics registry, and trusted-issuers registry record the eligible holder against the curated allowlist
**And** Foundry tests cover identity registration and claim issuance

### Story 4.2: Enforce eligibility on transfers in the custom ERC-3643-compatible token

As a transfer-agent,
I want a custom ERC-3643-compatible token whose transfers require a valid eligibility claim,
So that tokens can only be held/transferred by identity-verified, eligible holders (FR-19).

**Acceptance Criteria:**

**Given** the deployed custom token referencing the identity registry
**When** a token transfer targets a recipient with no valid ONCHAINID claim
**Then** the transfer is rejected on-chain

**Given** an eligible sender and eligible recipient
**When** a compliant transfer is made
**Then** it succeeds, and Foundry tests (incl. fuzz) cover both the allowed and rejected paths

### Story 4.3: Enforce pair coupling on-chain (atomic paired mint/burn, single-leg impossible)

As a transfer-agent,
I want the contract to enforce that legs are created, moved, and retired only as paired units,
So that the "never a single leg" rule holds on-chain (FR-19 coupling).

**Acceptance Criteria:**

**Given** the custom contract's coupling logic
**When** a paired mint or burn is requested
**Then** both legs are minted/burned atomically (both-or-neither) at equal notional

**Given** an attempt to transfer, mint, or burn a single leg that would break pair coupling
**When** the on-chain call is made
**Then** it is rejected, and a Foundry invariant test proves coupling cannot be broken

### Story 4.4: Enforce the Model-A bright line and principal/yield distinction on-chain

As an internal operator,
I want the contract to distinguish principal from yield and block principal from leaving the client position,
So that the Model-A segregation is enforced where the token moves (FR-19).

**Acceptance Criteria:**

**Given** segregated principal sub-positions in the custom contract
**When** an on-chain transfer would move client-collateral *principal* out of the client position
**Then** it is rejected on-chain (UJ-3)

**Given** a yield movement on the same collateral
**When** the on-chain transfer is made
**Then** it is permitted, and Foundry fuzz/invariant tests cover the principal-rejected and yield-allowed cases

### Story 4.5: Generate on-chain compliance config from the rule-spec and pass dual-plane conformance

As a build engineer,
I want the on-chain compliance configuration emitted from the same rule-spec as the off-chain rules,
So that the two planes are provably equivalent and cannot silently diverge (FR-19, §8 Q5, SM-4).

**Acceptance Criteria:**

**Given** the `rule-spec` codegen
**When** it emits the on-chain compliance configuration
**Then** the on-chain rules are generated (not hand-edited) from the single rule-spec, consistent with the off-chain `flow_permissions`

**Given** the shared conformance test vectors
**When** they are executed against the on-chain plane
**Then** they pass with the same allow/deny outcomes as the off-chain plane (SM-4 dual-plane equivalence)

### Story 4.6: Provide gated transfer-agent powers and deploy to Sepolia

As a transfer-agent / administrator,
I want forced transfer, recovery, freeze, and pause callable only by my role, deployed on Sepolia,
So that privileged lifecycle operations are available and safely restricted (FR-22).

**Acceptance Criteria:**

**Given** the deployed contract suite
**When** an agent power (forced transfer, recovery, freeze, pause) is called by a non-transfer-agent address
**Then** the call reverts; called by the authorized transfer-agent role it succeeds

**Given** a lost-key recovery
**When** the transfer-agent performs recovery
**Then** the holder's balance is reissued to a new wallet while preserving eligibility and the audit trail

**Given** the `forge script` deployment
**When** it runs against Sepolia
**Then** the token + registries are deployed and their addresses are recorded in config (role-holder entity is a parameterized placeholder, §8 Q4)

---

## Epic 5: Ledger↔Chain Integration — Mint, Burn & Reconciliation

Wire the off-chain spine to the chain: atomically mint/burn paired tokens with matching ledger entries, and run reconciliation that produces the group view and corrects the ledger toward the chain on divergence.

### Story 5.1: Connect to Sepolia via typed viem clients and event watchers

As a build engineer,
I want typed viem clients and chain-event watchers for the deployed contracts,
So that the chain package can read on-chain state and observe token events (NFR-9 foundation).

**Acceptance Criteria:**

**Given** the `chain` package configured with the Sepolia contract addresses
**When** I read on-chain token balances and total supply
**Then** the viem clients return typed results with ABI inference

**Given** mint/burn/transfer events on-chain
**When** the viem watchers run
**Then** confirmed events are ingested into the `outbox_events`/reconcile pipeline, and the `chain` package is the only module talking to Sepolia

### Story 5.2: Implement the outbox/saga dual-write with the on-chain tx as commit point

As an internal operator,
I want dual writes to use an outbox/saga with the on-chain transaction as the commit point,
So that ledger and chain stay consistent with idempotency and compensation on failure (NFR-9).

**Acceptance Criteria:**

**Given** a dual-write operation
**When** it executes
**Then** the off-chain intent is recorded → the on-chain tx is submitted (the commit point) → on confirmation the matching balanced journal entry (value + token quantity) is posted via `postTransfer`-governed flows

**Given** a retried or partially-failed dual write
**When** the saga runs
**Then** every step carries an idempotency key so retries are safe, and failures compensate or are caught by reconciliation; the on-chain tx hash is recorded on the related journal entry (NFR-3)

### Story 5.3: Mint paired ERC-3643 L/S tokens on Sepolia and record them in the ledger

As an Investment Manager,
I want issuing a pair to mint paired L/S tokens on Sepolia and record quantity + value in the ledger,
So that issuance is real on-chain and reconcilable to the books (FR-18).

**Acceptance Criteria:**

**Given** a pair issuance
**When** the mint executes
**Then** one L-Token and one S-Token are minted at equal notional via the custom contract on Sepolia (atomic), and the ledger records both quantity and value in one balanced entry (with FR-13)

**Given** the minted position
**When** reconciliation reads on-chain quantities
**Then** minted on-chain quantities match ledger token quantities, and a single-leg mint is impossible

### Story 5.4: Burn the coupled token package on redemption with matching ledger entries

As an Investment Manager,
I want redeeming a Note to burn the whole coupled package on-chain with matching ledger entries,
So that retirement is atomic and reconcilable (FR-21).

**Acceptance Criteria:**

**Given** a redemption
**When** the burn executes
**Then** the whole package (both legs) is burned on-chain and matching balanced ledger entries are posted

**Given** an attempt to burn a single leg
**When** the call is made
**Then** it is impossible; and post-redemption on-chain supply and ledger quantities reconcile

### Story 5.5: Produce the consolidated group view (text + JSON)

As an internal operator / steward,
I want `reconcile` to output per-entity, per-account-type balances and the consolidated group view,
So that I can see group NAV and balances for sign-off (FR-9).

**Acceptance Criteria:**

**Given** a populated ledger
**When** I run `reconcile`'s group-view output
**Then** it renders per-entity, per-account-type balances plus the consolidated group view, as both human-readable text and structured JSON

**Given** a balanced, chain-consistent ledger
**When** the group view runs
**Then** it reports no divergence

### Story 5.6: Reconcile ledger↔chain and correct the ledger toward the chain

As an internal operator / steward,
I want reconciliation to detect divergence and correct the ledger toward the chain on token-ownership mismatch,
So that the chain remains the source of truth and the books are kept honest (FR-10, NFR-9).

**Acceptance Criteria:**

**Given** a per-entity/consolidated inconsistency
**When** reconciliation runs
**Then** the divergence is reported explicitly

**Given** a deliberately introduced ledger↔chain token-quantity mismatch
**When** reconciliation runs
**Then** the mismatch is reported **and** the ledger is corrected to match the chain via a journaled correcting entry (P0 acceptance criterion)

**Given** the configured reconciliation cadence
**When** a confirmed mint/burn/transfer occurs (per-event) or `reconcile` is invoked on-demand
**Then** reconciliation runs; a reorg below the configured Sepolia confirmation depth is treated as a reconciliation event that re-derives ledger token quantities from the authoritative chain state

---

## Epic 6: Live Rose Note Slice & Engine Surfaces

Prove the whole loop end-to-end on testnet/paper — subscription, redemption, paper execution — and render all four functional Engine surfaces on live data.

> **UX contracts (binding):** `ux-designs/ux-rose-engine-2026-06-15/DESIGN.md` (visual identity) and `EXPERIENCE.md` (behavior). Stories below reference UX-DR1…UX-DR8; the spines win on conflict with any mock.

### Story 6.1: Expose the typed REST API boundary (Fastify + Zod + OpenAPI)

As a build engineer,
I want a typed Fastify REST API with Zod validation and an OpenAPI document,
So that surfaces and any audit consumers have an explicit, documented contract and authorization refusals surface cleanly (FR-14 foundation).

**Acceptance Criteria:**

**Given** the `api` package
**When** a request is handled
**Then** request/response bodies are Zod-validated, money is serialized as decimal strings (never JS `number`), and an OpenAPI document is generated

**Given** an authorization refusal or domain rejection
**When** the API responds
**Then** it returns the structured error `{ error: { code, message, details? } }` with the correct status (403 authorization refusal, 422 domain rule rejection, 409 invariant/idempotency conflict, 400 validation)
**And** the `code`/`message` are specific enough for the surface to name the refusing rule to the user (UX-DR5) — refusals are never collapsed into a generic error

### Story 6.2: Live subscription to a Rose Note end-to-end (testnet/paper)

As a Subscriber (Rose Member),
I want to subscribe to a Rose Note in fiat or crypto and have tokens issued to me,
So that I can participate in the live loop on testnet/paper (FR-11).

**Acceptance Criteria:**

**Given** an allowlist-eligible Subscriber with a valid ONCHAINID claim
**When** they subscribe to a Rose Note at the VCC level (fiat or crypto)
**Then** the subscription drives the paired mint (Epic 5) and produces balanced journal entries touching the appropriate accounts (incl. `NOTE_LIABILITY`), respecting the chokepoint and segregation rules

**Given** a non-eligible would-be subscriber
**When** they attempt to receive tokens
**Then** the on-chain eligibility rule rejects it (FR-19); the full subscribe → issue → mint → ledger loop runs end-to-end on Sepolia/paper at small scale (SM-1)

**Given** the Subscriber surface (UX-DR6)
**When** an eligible Subscriber subscribes
**Then** the action passes a **Review → Confirm** panel stating the amount, the embedded coupled pair, and the on-chain consequence, and stays **pending until the on-chain commit point** (no optimistic success)
**And** when the eligibility claim is absent/expired, the subscribe path is unavailable with an explicit reason (no self-service KYC), not a generic block

### Story 6.3: Live redemption of a Rose Note

As a Subscriber (Rose Member),
I want to redeem (buy back) a Rose Note,
So that I can exit my position with the books and chain staying consistent (FR-11).

**Acceptance Criteria:**

**Given** a Subscriber holding a Rose Note
**When** they redeem it
**Then** the redemption drives the package burn (Epic 5) and produces balanced journal entries, respecting the chokepoint and segregation rules
**And** the redemption is visible in the group view and reconciles supply ↔ ledger

**Given** the Subscriber surface (UX-DR6)
**When** the Subscriber initiates a redemption
**Then** it passes the **Review → Confirm** panel and shows a **pending** state until the burn's on-chain commit point resolves, then the position closes (no optimistic success)

### Story 6.4: Execute coupled-pair strategy in paper/testnet mode

As an Investment Manager,
I want the Trading Co. to execute strategy in paper/testnet mode behind a clean interface,
So that simulated positions/P&L flow to the ledger without any real venue or capital (FR-20, NFR-7).

**Acceptance Criteria:**

**Given** a strategy execution in paper/testnet mode (no real CEX, no real capital)
**When** it runs
**Then** it produces ledger entries tagged to the executing entity, and simulated P&L accrues to the VCC via its ownership chain and is visible in the group view

**Given** the execution path
**When** it is implemented
**Then** it sits behind a clean interface seam so it can be re-implemented in Rust/Go post-P0 without caller changes (NFR-7), and it is small-scale only

### Story 6.5: Covenant Console and Coupled-Pair surfaces on live data

As an internal operator / steward,
I want the Covenant Console and Coupled-Pair surfaces rendering live data on a sober, trustworthy design system,
So that I can see group NAV/exposure and live pair state with no mockups (FR-14, UX-DR1–4, UX-DR7, UX-DR8).

**Acceptance Criteria:**

**Given** the front-end app (per DESIGN.md / EXPERIENCE.md)
**When** the design system is set up
**Then** shadcn/ui carries the DESIGN.md semantic tokens with a persisted **light/dark toggle** (rosé `primary` for brand/actions only; `gain`/`loss`/`warn`/`info` for data) and shared data-product components exist: money cell, delta indicator, **status badge** (six lifecycle states + live/divergent/pending), live indicator, divergence banner (UX-DR1, UX-DR3)
**And** every figure renders in tabular mono from **decimal strings** with asset symbol + scale, right-aligned, no truncation, deltas as sign + glyph + color (UX-DR2)

**Given** a populated, reconciled system
**When** I open the Covenant Console
**Then** it renders live group NAV, per-entity balances, float yield, and exposure from the group view (FR-9), with explicit loading/empty/error states (UX-DR4)
**And** I can drill group → entity → account → journal entry → on-chain tx hash, with a copy-tx-hash affordance (UX-DR7)

**Given** an active pair
**When** I open the Coupled-Pair view
**Then** it renders live `V_A`, `V_B`, `K`, `floor`, `anchor`, current `P`, and the holding from live pair state (FR-6) — no hard-coded mockup data — with `V_A + V_B = K` and distance-to-floor legible (UX-DR2)
**And** the lifecycle status badge reflects the live state, and the live indicator flips to **stale** (warn + last-updated) when data ages beyond the refresh window (UX-DR3, UX-DR4)

**Given** a ledger↔chain divergence reported by reconcile (FR-10)
**When** it occurs on a surface
**Then** a divergence banner states the correction-toward-chain and links to the journaled correcting entry (UX-DR4)

**Given** the accessibility floor (UX-DR8)
**When** the surfaces are built
**Then** they meet WCAG 2.2 AA in both color modes, signal nothing by color alone, are fully keyboard-operable, and announce money with unit + scale and the lifecycle state to screen readers

### Story 6.6: Exchange/Trading and Subscriber surfaces on live data

As a Subscriber (Rose Member),
I want the Subscriber surfaces (and the Exchange/Trading view) functional on live data,
So that I can subscribe/redeem and view my position, and operators can see trading live (FR-14, UX-DR4, UX-DR6, UX-DR8).

**Acceptance Criteria:**

**Given** the live system (reusing the Story 6.5 design system + shared components)
**When** I open the Exchange/Trading view (operator desktop)
**Then** it renders live (paper/testnet) execution data, positions, and P&L by entity (no mockups), using the money cell / delta / live-indicator components and explicit loading/empty/error states (UX-DR1, UX-DR2, UX-DR4)

**Given** an eligible Subscriber on the **responsive** Subscriber surfaces (UX-DR8)
**When** they use the surfaces
**Then** the surfaces drive the live subscription/redemption flow (FR-11) via the Review→Confirm + pending pattern (UX-DR6) and display the live position and embedded pair state, with explicit loading/empty/error states
**And** the surfaces adapt single-column (phone) → centered reading column (desktop) and meet WCAG 2.2 AA in both color modes (UX-DR8)

---

## Epic 7: Coupled-Coin Model Validation — The Trial (Throwaway)

Put the coupled-coin model on trial in the throwaway regime: prove the issuer-neutral invariant and threshold-only rebalancing on real ticks. Fully independent of `/prod`.

### Story 7.1: Implement the coupled-coin reference math with the issuer-neutral invariant

As a stakeholder / board member,
I want a reference-math library proving the issuer-neutral invariant within the barrier,
So that I have evidence the coupled-coin model holds before production weight rests on it (FR-15, SM-2).

**Acceptance Criteria:**

**Given** the throwaway `coupled-math` library
**When** it computes leg values from price as `V_A = (K/2)(1 + L·r)` and `V_B = (K/2)(1 − L·r)` where `r = (P − P₀)/P₀`
**Then** across a price grid within the barrier, `V_A + V_B == K` exactly (model math may use higher precision; postings stay exact integers)
**And** no leg becomes negative while price stays within the barrier

**Given** the floor `f = m · L · g` with `m` and `g` read from config
**When** `m` or `g` is absent
**Then** the library refuses (never defaults); when present, a floor breach is detected

### Story 7.2: Simulate threshold-only rebalancing over historical ticks

As an analyst,
I want a simulator that replays historical ticks and rebalances only on a floor breach,
So that resets are event-driven (intrinsic time), never clock-driven (FR-16).

**Acceptance Criteria:**

**Given** an example tick CSV (`timestamp,price`) for EUR/USD and BTC at L=1
**When** the simulator replays the ticks
**Then** a reset fires **only** when a losing leg breaches floor `f`, and **never** on a time interval

**Given** a reset event
**When** it fires
**Then** current dollar values are locked, P₀ re-anchors to the current price, and the losing holder's loss is locked

### Story 7.3: Prove no-negative-leg, journal every reset, and traverse the full lifecycle

As a stakeholder / board member,
I want the simulator to report no-negative-leg, flag floor-gap breaches, and journal every reset over a tick set,
So that I can judge the model across a full lifecycle on real ticks (FR-17, SM-3, SM-C1).

**Acceptance Criteria:**

**Given** a full tick set run
**When** the simulator completes
**Then** it reports whether any leg went negative and whether any gap breached the floor (the issuer-neutrality break condition), and journals every reset (price, locked values, new anchor)

**Given** the run
**When** it executes
**Then** it exercises the full pair lifecycle end-to-end (`PENDING → … → CLOSED`)
**And** `m` and `g` are chosen by a stated, defensible method *before* observing the reset rate (SM-C1 falsifiability; EUR/USD reset rate must stay near zero with a plausible floor, BTC resets expected)
