---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - '_bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/prd.md'
  - '_bmad-output/planning-artifacts/prds/prd-rose-engine-2026-06-15/addendum.md'
  - 'docs/SPEC.md'
  - 'docs/ROSE PROJECT MEMO 20052026.pdf'
workflowType: 'architecture'
project_name: 'rose-engine'
user_name: 'Fabrice'
date: '2026-06-15'
lastStep: 8
status: 'complete'
completedAt: '2026-06-15'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

> **Glossary discipline.** This document uses PRD §3 terms exactly (Coupled pair, Leg, Rose Note, L-Token/S-Token, postTransfer, Authorization Provider, Model-A bright line, etc.). Synonyms are a discipline violation.
>
> **Governing precedence.** Where `docs/SPEC.md` and the PRD disagree, the **PRD governs** (PRD §0). SPEC.md is superseded on its P0 non-objectives — EVM, smart contracts, token minting, live subscription, and small-scale paper execution are **in P0** (on Sepolia testnet / paper). SPEC.md must be updated accordingly (handoff item).
>
> **Source of truth.** The **chain** is authoritative for token ownership/positions; the **off-chain ledger** is the authoritative accounting record, reconciled and corrected toward the chain on divergence (PRD NFR-9, FR-10).

---

## Project Context Analysis

### Requirements Overview

**Functional Requirements (21 FRs across 7 feature groups):**

The Engine is a **regulated real-time financial-infrastructure product**, sequenced Engine-first, with P0 as a **full vertical-slice MVP on testnet/paper, no real capital**. The FRs cluster into seven architectural concerns:

- **Consolidated double-entry ledger (FR-1, FR-2, FR-3, FR-13)** — the accounting system of record. Four fixed entities (`VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`), five account types, balanced journal entries with postings in **integer smallest units**, double-entry invariant enforced **in the database**. *Architecturally:* the integrity guarantee must live at the data layer, not the application layer (NFR-1).
- **Coupled-pair contract & lifecycle (FR-4, FR-6, FR-12)** — the **inter-track contract**, the single most important artifact. Schema must make a persistent single-leg pair **unrepresentable**; `L` is a per-pair parameter, never hard-coded; lifecycle `PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED`.
- **Capital-flow authorization (FR-5, FR-7, FR-8, FR-19)** — a single `postTransfer` chokepoint off-chain (default-deny `AuthorizationProvider`), **mirrored on-chain** by the custom ERC-3643-compatible contract's compliance rules. Same rule intent on both planes.
- **Reconciliation & group view (FR-9, FR-10)** — group view plus ledger↔chain verification that **corrects the ledger toward the chain** on token-ownership divergence, journaling the correction.
- **Rose Note lifecycle (FR-11, FR-12, FR-18, FR-20, FR-21, FR-22)** — live (testnet/paper) subscription/redemption, paired ERC-3643 mint+burn on Sepolia, paper/testnet strategy execution, privileged transfer-agent powers. Hybrid ledger: **value AND token quantity**.
- **Engine surfaces (FR-14)** — four surfaces, **all functional in P0** (no mockups): Covenant Console, Coupled-Pair view, Exchange/Trading view, Subscriber surfaces.
- **Coupled-coin model validation (FR-15, FR-16, FR-17)** — a **throwaway** library + threshold-only simulator that puts the model on trial (issuer-neutral invariant `V_A + V_B = K` within the barrier; reset only on floor breach, **never on a clock**).

**Non-Functional Requirements (9 NFRs):** integrity-by-construction (NFR-1); exact integer arithmetic, binary float prohibited in PROD (NFR-2); auditability (NFR-3); fail-closed authorization off-chain and on-chain (NFR-4); reversible migrations from first commit (NFR-5); test-first on invariants (NFR-6); real-time orientation with Rust/Go hot-path optionality, TS default (NFR-7); substitutability behind interfaces (NFR-8); ledger↔chain consistency with chain authoritative, dual writes via outbox/saga with the on-chain tx as the commit point (NFR-9).

### Scale & Complexity

- **Primary domain:** regulated full-stack financial infrastructure — off-chain accounting spine + on-chain permissioned security tokens + functional operator/subscriber surfaces.
- **Complexity level:** **high / enterprise**. Drivers: dual on/off-chain enforcement that must stay provably equivalent; database-enforced financial invariants; exact arbitrary-precision arithmetic; dual-write consistency between a ledger and a blockchain; a falsifiable model-validation harness; a hard PROD/throwaway and testnet/real-money boundary.
- **Estimated architectural components:** ~12 PROD modules + 1 Solidity contract suite + 2 throwaway modules (see Project Structure).

### Technical Constraints & Dependencies

- **Greenfield** build (PRD §0); Laplace (`laplace.digital`) is precedent, **not a code dependency**.
- **Two-regime discipline:** one repo, `/prod` and `/throwaway`; `/prod` never imports `/throwaway` (CI-enforced). Boundary is **orthogonal to language**.
- **No-accidental-real-money guardrail (§11.3):** the testnet/paper boundary is a runtime/config switch; moving to real capital/mainnet must be an explicit, gated, reviewed change — never a config flip.
- **Parked parameters (§11.2):** Note coupon, use-of-proceeds split, conversion-to-participation, backing-float floor, model floor params `m` and `g` — read from config, **refuse if absent**, never default to 0.
- **P0 dependency:** EVM / custom ERC-3643-compatible stack on **Sepolia**. No live OANDA/LMAX feed; historical CSV ticks. No real CEX/DEX.

### Cross-Cutting Concerns Identified

1. **Exact money arithmetic** — BigInt/NUMERIC, per-asset decimal scale, deterministic rounding preserving `V_A + V_B = K` (NFR-2).
2. **Fail-closed authorization** — default-deny on both planes; absent config ⇒ refusal (NFR-4).
3. **Auditability** — every movement attributable to a journal entry + `postTransfer` (off-chain) and an on-chain tx (on-chain); append-oriented (NFR-3).
4. **Ledger↔chain consistency** — outbox/saga, chain authoritative, reconcile-and-correct backstop (NFR-9).
5. **Off-chain ↔ on-chain rule equivalence** — single-source rule spec (FR-19, §8 Q5).
6. **Regime & money-boundary safety** — `/prod`↔`/throwaway` and testnet↔real gating.

### Deferred Dependencies (flagged, not resolved by architecture)

These are **product/legal decisions** the PRD parks; the architecture is built to *accommodate* them without committing:

- **D1 — Rose Note composition & reset loss-allocation (§8 Q1):** bundled (market-neutral holder) vs separate L/S (zero-sum, directional). The coupled-pair schema and contract are designed to support **either** interpretation; P0 model validation (§4.7) proves the *invariant*, not the *loss-allocation*. **Blocks final instrument design, not P0 spine.**
- **Two offshore jurisdictions (§8 Q3)** and **claim-issuer / transfer-agent operating model (§8 Q4)** — recorded as config/role placeholders; `jurisdiction` is a free-text entity field, roles are address-parameterized.
- **Reconciliation cadence & chain finality/reorg handling (§8 Q6)** — architecture below proposes a default; see Core Decisions.

---

## Starter Template Evaluation

### Primary Technology Domain

**Polyglot regulated full-stack**: a TypeScript backend + functional web surfaces, a Solidity contract suite, and a throwaway model-validation harness — inside one **two-regime monorepo**. No single off-the-shelf starter spans the off-chain ledger + on-chain ERC-3643 + functional surfaces + simulator with the required PROD/throwaway separation.

### Starter Options Considered

- **T3 / create-t3-app, RedwoodJS, Blitz** — full-stack TS starters. Rejected as the *base*: they impose opinions (tRPC/Prisma/Next conventions) that fight the DB-first integrity model and the two-regime layout, and none address the Solidity side.
- **Scaffold-ETH 2 / Foundry templates** — strong for the on-chain side, but only the on-chain side.
- **Tokeny T-REX reference / ERC-3643 suite** — the canonical ERC-3643 implementation; used as **reference and a Foundry dependency**, not as the repo base (P0 needs a *custom* ERC-3643-compatible contract with coupling + Model-A principal/yield logic that stock T-REX cannot express — PRD addendum §A).

### Selected Approach: Custom pnpm + Turborepo monorepo (no monolithic starter)

**Rationale:** the PRD/addendum already fix the load-bearing decisions (TypeScript/Node, PostgreSQL, BigInt/NUMERIC, custom ERC-3643 on OpenZeppelin, two-regime repo, greenfield). The right "starter" is a thin, explicit monorepo scaffold that enforces the regime boundary and composes best-in-class per-domain tools, rather than a heavy opinionated template we would have to fight.

**Initialization (first implementation story):**

```bash
# Node 24 LTS + pnpm
corepack enable && corepack prepare pnpm@latest --activate
pnpm init
pnpm add -D turbo typescript @types/node vitest tsx drizzle-kit eslint prettier
# workspace: pnpm-workspace.yaml + turbo.json + tsconfig.base.json + /prod, /throwaway, /prod/contracts
# Solidity (PROD) — in prod/contracts:
curl -L https://foundry.paradigm.xyz | bash && foundryup
forge init --no-git prod/contracts
forge install OpenZeppelin/openzeppelin-contracts
```

**Architectural decisions provided by this scaffold:**

- **Language & runtime:** TypeScript 5.x on **Node.js 24 LTS**; ES modules; `strict` everywhere.
- **Monorepo:** **pnpm workspaces + Turborepo** for task graph/caching; `/prod` and `/throwaway` as top-level regime roots; a CI guard asserts `/prod` never imports `/throwaway`.
- **Build tooling:** `tsx` for dev, `tsc` project references for builds, Turborepo pipeline.
- **Testing:** **Vitest** for TypeScript; **Foundry (`forge`)** for Solidity (incl. fuzz/invariant tests).
- **Linting/formatting:** ESLint + Prettier.
- **Code organization:** feature/domain packages under `/prod/packages`, the Solidity suite under `/prod/contracts`, throwaway under `/throwaway` (see Project Structure).

**Note:** Project initialization using the command above is the **first implementation story**. Versioned, reversible migrations and invariant tests precede application logic (PRD §6.1, NFR-5, NFR-6).

---

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (block implementation):** language/runtime, database + ORM + how the double-entry invariant is enforced, numeric representation, on-chain stack + contract toolchain, dual-write consistency mechanism, off-chain↔on-chain rule-equivalence mechanism.

**Important Decisions (shape architecture):** API style, frontend stack, config/secrets handling, hot-path strategy for P0, reconciliation cadence.

**Deferred (post-MVP / not architecture's call):** D1 instrument composition; jurisdictions; real venues/mainnet; Rust/Go hot-path *implementation* (seams designed now, NFR-7); cross-jurisdiction reconciliation.

### Data Architecture

- **Database: PostgreSQL 18.4.** No SQLite in PROD — the integrity constraints depend on Postgres (PRD addendum §A).
- **ORM / migrations: Drizzle ORM 0.45.x + drizzle-kit** *(decision — Fabrice, this session)*. SQL-first; coexists cleanly with hand-written triggers/constraints and gives full control over `NUMERIC` types. Migrations are **versioned and reversible from the first commit** (NFR-5). The double-entry trigger ships as a raw-SQL migration.
- **Double-entry invariant enforced IN the database (FR-3, NFR-1):** a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `postings` (checked at transaction commit) asserting `Σ debits = Σ credits` per `journal_entry`. An unbalanced entry **fails the transaction**; no partial state. The guarantee holds regardless of application path and cannot be bypassed by writing postings directly. *(This guarantees accounting balance only — agreement with the chain is FR-10.)*
- **Numeric representation (NFR-2):** monetary amounts are **integers in the smallest unit**; **binary float prohibited in PROD**. In TypeScript use native **`BigInt`**; in Postgres use `BIGINT` where int64 suffices and **`NUMERIC` (arbitrary precision)** where it does not — notably 18-decimal token amounts (int64 caps ~9 tokens at 18 decimals). Each account stores its asset's **decimal scale** (EUR=2, BTC=8, token=`decimals()`). A **deterministic remainder/rounding policy** (one leg absorbs the residual unit) preserves `V_A + V_B = K` exactly within the barrier; model math may compute at higher precision but postings stay exact integers.
- **Coupled-pair field types (frozen first — PRD addendum §D):** `anchor_price` (P₀) `decimal(18,8)`; `leverage` (L) `decimal`, per-pair; `collateral_pool` (K) integer smallest-unit, **`NUMERIC` not `bigint`** for 18-decimal tokens; `floor` (f) `decimal`; `state` enum `PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`; `reference_asset` text; timestamps `timestamptz`. Schema **cannot represent a persistent single-leg pair**.
- **Data modeling & validation:** **Zod** schemas at every boundary (API ingress, config load, chain-event ingest); domain types derived from Zod + Drizzle inferred types in a shared package.

### Authentication & Security

- **No self-service KYC / user-auth product in P0** (PRD §5). Eligibility is the **curated allowlist** materialized as **ERC-3643 ONCHAINID claims** issued by a ROSE-operated **claim issuer**; claims attest that off-chain KYC/AML/accreditation passed.
- **Operator/Subscriber surface access:** session-based auth for internal operators and allowlisted Subscribers, scoped to read live data and (for Subscribers) drive the subscription/redemption flow. *(Architecture default; the curated, small, sophisticated-client P0 audience keeps this simple — revisable.)*
- **Authorization (the core security control):**
  - **Off-chain:** every inter-account capital movement passes the single `postTransfer(from, to, amount, context)` chokepoint (FR-7); it consults a **default-deny `AuthorizationProvider`** before writing (FR-8). P0 implementation `OffChainPolicyProvider` reads a `flow_permissions` table.
  - **On-chain:** the custom ERC-3643-compatible contract enforces eligibility, transfer restrictions, the **Model-A bright line**, and pair coupling as compliance rules (FR-19).
  - **Substitutability (FR-5, NFR-8):** `AuthorizationProvider` is an interface; swapping a fake/alternate provider changes no caller.
- **Fail-closed (NFR-4):** unrecognized movement ⇒ "no", on both planes; absent config (e.g. missing `BACKING_FLOAT` floor) ⇒ **refusal, never permissive default**.
- **Secrets/config:** `.env` (+ `.env.example`); a typed config loader that **refuses on absent parked parameters** (§11.2). No secrets in client-side code; deployer/transfer-agent keys handled out-of-band.

### On-Chain Architecture

- **Network:** EVM on **Sepolia testnet** in P0.
- **Contract suite (custom ERC-3643-compatible):** built on **OpenZeppelin Contracts 5.6.x**, referencing the **Tokeny T-REX / ERC-3643** suite and **ONCHAINID** (ERC-734/735) patterns. The custom contract adds ROSE-specific compliance: **atomic paired mint/burn** ("never a single leg"), the **Model-A bright line** with **principal/yield distinction** (segregated principal sub-positions a plain fungible token cannot express), and pair coupling. Includes ERC-3643 **agent powers** — forced transfer, recovery, freeze, pause — gated to a **transfer-agent** role (FR-22; role-holder entity TBD, §8 Q4).
- **Identity/eligibility infrastructure:** ONCHAINID identity registry, trusted **claim issuer**, claim-topics/trusted-issuers registries, curated allowlist (FR-19, §4.5).
- **Contract toolchain: Foundry** (forge/cast/anvil) *(decision — Fabrice, this session)*. Solidity-native tests with **fuzzing and invariant testing** to prove compliance rules (coupling, Model-A, eligibility). Deployment scripts via `forge script` to Sepolia.
- **TS↔chain interaction: viem 2.52.x** — typed clients, ABI inference, contract reads/writes, event subscriptions.

### Ledger ↔ Chain Consistency (NFR-9, FR-10)

- **Chain authoritative** for token ownership/positions; ledger corrected toward chain.
- **Dual writes via an outbox/saga** with the **on-chain transaction as the commit point**, plus **idempotency keys** and **compensation**. Pattern: the off-chain intent is recorded → on-chain tx submitted → on confirmation, the matching balanced journal entry (value + token quantity) is posted; failures compensate or are caught by reconciliation.
- **Reconciliation backstop:** `reconcile` produces the consolidated group view (per entity, per account type) as text **and** JSON (FR-9), verifies per-entity/consolidated consistency **and** ledger token quantities vs on-chain balances, and on token-ownership divergence **corrects the ledger toward the chain with a journaled correcting entry** (FR-10).
- **Reconciliation cadence (default — §8 Q6, revisable):** **per-event** reconciliation triggered on each confirmed mint/burn/transfer, **plus** an on-demand `reconcile` command. **Chain finality:** act on a configured confirmation depth for Sepolia; treat a reorg below that depth as a reconciliation event that re-derives ledger token quantities from the (new) authoritative chain state.

### Off-Chain ↔ On-Chain Rule Equivalence (FR-19, §8 Q5)

- **Single-source declarative rule spec + codegen** *(decision — Fabrice, this session)*. A single versioned **rule specification** (a small JSON/DSL describing eligibility, transfer restrictions, the Model-A bright line, and pair coupling) is the source of truth. Codegen emits **both** the off-chain `flow_permissions`/`OffChainPolicyProvider` config **and** the on-chain compliance configuration. A shared set of **conformance test vectors** is executed against both planes so the two rule sets **cannot silently diverge** (NFR-8, SM-4).

### API & Communication Patterns

- **API style:** typed **REST** over **Fastify** (TypeScript) with **Zod** request/response validation and an OpenAPI document for auditability and any future external/audit consumers. *(Architecture default; chosen over tRPC because a regulated system benefits from an explicit, language-agnostic, documented contract — revisable.)*
- **Error handling standard:** structured `{ error: { code, message, details? } }` with stable machine `code`s; fail-closed defaults surface as explicit refusals, not silent successes.
- **Communication between modules:** in-process typed function calls within `/prod/packages`; the chain boundary is event-driven (viem watchers feeding the outbox/reconcile pipeline).

### Frontend Architecture (Engine Surfaces, FR-14)

- **Stack:** **React 18 + Vite + TypeScript**, **TanStack Query** (server-state) and **TanStack Router**, a component library (e.g. shadcn/ui or Mantine) for data-dense operator dashboards. *(Architecture default; Vite/SPA over SSR because these are internal/operational, gated, data-dense surfaces rather than public SEO pages — revisable.)*
- **All four surfaces functional (live data), no mockups:** Covenant Console (group view, FR-9), Coupled-Pair view (V_A, V_B, K, floor, anchor + holding, FR-6), Exchange/Trading view, Subscriber surfaces (subscribe/redeem/view position, FR-11). Generated API types are shared from the backend.

### Infrastructure & Deployment

- **Local dev:** `docker-compose` with PostgreSQL 18; Anvil (Foundry) or a Sepolia RPC for the chain.
- **Hot-path strategy for P0 (decision — Fabrice, this session): TS-only in P0, seams ready.** P0 is entirely TypeScript; latency-sensitive paths (execution, real-time pricing/rebalancing) sit behind **clean interfaces** so they can be re-implemented in **Rust/Go post-P0** without caller changes (NFR-7). The PROD/throwaway boundary remains orthogonal to language.
- **CI/CD:** GitHub Actions — typecheck, ESLint, Vitest, `forge test` (incl. invariant/fuzz), drizzle migration check, and the **regime dependency rule** (`/prod` must not import `/throwaway`). Migrations run forward/rollback in CI (NFR-5).
- **Monitoring/logging:** structured logging at key decision points — `postTransfer` authorize/deny, mint/burn, outbox commit, reconcile divergence/correction (CLAUDE.md §11). Include entity, account, journal-entry id, on-chain tx hash.

### Decision Impact Analysis

**Implementation sequence (dependency order):**

1. Monorepo scaffold + regime boundary CI guard (first story).
2. Drizzle schema + **double-entry trigger migration** + invariant tests (test-first, NFR-6).
3. Coupled-pair schema (the inter-track contract) — **freeze first** (PRD §4.2).
4. `postTransfer` chokepoint + default-deny `OffChainPolicyProvider` + `flow_permissions` (+ substitutability test).
5. **Rule-spec + codegen** scaffolding (so off-chain and on-chain derive from one source).
6. Solidity custom ERC-3643-compatible contract + ONCHAINID/claim-issuer + Foundry tests; deploy to Sepolia.
7. Chain integration (viem) + **outbox/saga** + mint/burn (FR-18, FR-21).
8. Reconciliation (group view + ledger↔chain reconcile-and-correct, FR-9/FR-10).
9. Rose Note subscription/redemption + paper execution (FR-11, FR-20).
10. Functional surfaces (FR-14).
11. **Throwaway** coupled-math + simulator (FR-15/16/17) — independent track, deletable.

**Cross-component dependencies:** the **coupled-pair contract** is consumed by ledger, authorization, chain, and surfaces — freeze it first. The **rule-spec** feeds both `postTransfer` and the on-chain compliance config. The **outbox** sits between Rose Note orchestration and the chain; **reconcile** depends on both ledger and chain reads.

---

## Implementation Patterns & Consistency Rules

### Critical Conflict Points Identified

~10 areas where independent AI agents could diverge — money representation, naming, the chokepoint, dual-write ordering, rule sourcing, regime boundary, error semantics. Rules below are **mandatory**.

### Naming Patterns

**Database (PostgreSQL):** `snake_case` for tables and columns; tables **plural** (`entities`, `accounts`, `journal_entries`, `postings`, `coupled_pairs`, `flow_permissions`, `outbox_events`). Primary key `id` (uuid). Foreign keys `<singular>_id` (`entity_id`, `journal_entry_id`, `account_id`, `coupled_pair_id`). Enums use the exact PRD-glossary uppercase codes (`VCC`, `BACKING_FLOAT`, `PENDING`…). Indexes `idx_<table>_<cols>`.

**API (REST):** kebab/plural resource paths (`/coupled-pairs`, `/journal-entries`, `/reconcile`); route params `:id`; JSON bodies **camelCase**. Status codes: 200/201 success, 400 validation, 403 authorization refusal, 409 invariant/idempotency conflict, 422 domain rule rejection.

**TypeScript code:** files `kebab-case.ts`; React components `PascalCase.tsx`; types/interfaces/classes `PascalCase`; functions/variables `camelCase`; constants `UPPER_SNAKE_CASE`. Domain function names use glossary verbs exactly: `postTransfer`, `issueCoupledPair`, `mintPair`, `burnPair`, `reconcile`.

**Solidity:** contracts/events `PascalCase`; functions/vars `camelCase`; constants/immutables `UPPER_SNAKE_CASE`; custom errors `PascalCase` (prefer `revert CustomError()` over `require`-strings).

### Structure Patterns

- **Tests co-located** for TS unit tests (`*.test.ts` next to source) under Vitest; cross-module/integration tests in a package-level `tests/`; Solidity tests in `prod/contracts/test/` (`*.t.sol`).
- **Modules organized by domain** under `/prod/packages` (not by technical layer), each exporting a narrow `index.ts` public surface.
- **Shared code** (money/BigInt helpers, decimal-scale utilities, error types, glossary enums, generated API/contract types) lives in `/prod/packages/shared`.
- **Migrations** live with the ledger package; **never edited after merge** — only new forward+down migrations (NFR-5).

### Format Patterns

- **Money in transit:** integer smallest-units serialized as **decimal strings** in JSON (never JS `number`, never binary float); each carries or references its asset's `decimalScale`. Reject any float amount at the boundary (NFR-2).
- **API error format:** `{ "error": { "code": "STRING_CODE", "message": "...", "details": {} } }`.
- **Dates:** ISO-8601 UTC strings in APIs; `timestamptz` in Postgres.
- **JSON field naming:** `camelCase` over the wire; `snake_case` only inside Postgres.

### Communication Patterns

- **Single chokepoint, no exceptions:** no module writes transfer `postings` except through `postTransfer` (FR-7). A test proves this (e.g. static/dependency check + runtime guard).
- **Dual-write ordering (NFR-9):** intent → on-chain tx (**commit point**) → on confirmation, post the balanced journal entry. Every dual-write step carries an **idempotency key**; retries are safe; failures compensate or are reconciled.
- **Chain events:** ingested via viem watchers into `outbox_events`/reconcile; on-chain tx hash recorded on the related journal entry (NFR-3).
- **Rules come from one place:** off-chain `flow_permissions` and on-chain compliance config are **generated from the rule-spec** — never hand-edited independently (FR-19).

### Process Patterns

- **Authorization is fail-closed (NFR-4):** default branch is deny/refuse on both planes; absent config refuses (never treats as 0).
- **Error handling:** domain rejections (authorization, invariant, rule) are **explicit typed errors**, surfaced as refusals — never swallowed into a success path. Throwaway code may be loose; **PROD invariants are never weakened for speed (SM-C2)**.
- **Loading/empty/error states** are explicit on every surface; surfaces read live data only (no hard-coded mockup data in P0).

### Enforcement Guidelines

**All AI agents MUST:**

- Use PRD §3 glossary terms exactly (names, enum codes, state machine).
- Represent money as integer smallest-units (`BigInt`/`NUMERIC`); **never** binary float in PROD.
- Route every capital movement through `postTransfer`; honor default-deny.
- Derive off-chain and on-chain rules from the **single rule-spec**; never edit one side by hand.
- Keep the on-chain tx as the dual-write commit point; make every write idempotent.
- Never import `/throwaway` from `/prod`; never let throwaway code become a PROD dependency (SM-C2).
- Never invent a parked-parameter value; read config and **refuse** if absent (§11.2, NFR-4).
- Write invariant tests **before** application logic (NFR-6).

**Anti-patterns (forbidden):** float money math; bypassing `postTransfer`; permissive default in authorization; hand-editing on-chain rules out of sync with off-chain; persisting a single-leg pair; defaulting an absent floor to 0; `/prod` importing `/throwaway`.

---

## Project Structure & Boundaries

### Complete Project Directory Structure

```
rose-engine/
├── package.json                       # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .eslintrc.cjs
├── .prettierrc
├── .env.example
├── docker-compose.yml                 # PostgreSQL 18 (local dev)
├── README.md
├── .github/
│   └── workflows/
│       └── ci.yml                     # typecheck, lint, vitest, forge test, migration check, regime guard
├── docs/
│   └── SPEC.md                        # existing — to UPDATE (superseded P0 non-objectives)
├── prod/                              # [PROD] — depends on NOTHING in /throwaway
│   ├── packages/
│   │   ├── shared/                    # money/BigInt + decimal-scale utils, glossary enums, error types, shared/generated types
│   │   ├── config/                    # typed config loader; refuse-if-absent for parked params (§11.2, NFR-4)
│   │   ├── ledger/                    # FR-1, FR-2, FR-3, FR-13
│   │   │   ├── src/
│   │   │   │   ├── schema/            # drizzle: entities, accounts, journal_entries, postings, coupled_pairs
│   │   │   │   ├── migrations/        # versioned/reversible SQL incl. double-entry DEFERRABLE trigger
│   │   │   │   ├── repositories/
│   │   │   │   └── index.ts
│   │   │   └── *.test.ts
│   │   ├── coupled-pair/              # FR-4, FR-6, FR-12 — the inter-track contract (freeze first)
│   │   ├── authorization/             # FR-5, FR-7, FR-8
│   │   │   ├── src/
│   │   │   │   ├── post-transfer.ts   # the single chokepoint
│   │   │   │   ├── authorization-provider.ts        # interface
│   │   │   │   └── providers/off-chain-policy-provider.ts
│   │   │   └── *.test.ts
│   │   ├── rule-spec/                 # FR-19 / §8 Q5 — single source of truth
│   │   │   ├── spec/                  # versioned declarative rule spec (DSL/JSON)
│   │   │   ├── codegen/               # emits off-chain flow_permissions + on-chain compliance config
│   │   │   └── conformance/           # shared test vectors run against BOTH planes
│   │   ├── chain/                     # FR-18, FR-21, FR-22, NFR-9
│   │   │   ├── src/
│   │   │   │   ├── viem-clients.ts
│   │   │   │   ├── outbox/            # outbox/saga, idempotency, compensation
│   │   │   │   └── services/          # mint/burn/agent-power orchestration
│   │   │   └── *.test.ts
│   │   ├── reconcile/                 # FR-9, FR-10 — group view + ledger↔chain correct-toward-chain
│   │   ├── rose-note/                 # FR-11, FR-20, FR-21 — subscription/redemption/paper execution
│   │   ├── api/                       # Fastify REST + Zod + OpenAPI (boundary for surfaces)
│   │   └── web/                       # React + Vite surfaces (FR-14)
│   │       └── src/surfaces/          # covenant-console, coupled-pair, exchange-trading, subscriber
│   └── contracts/                     # [PROD] Solidity / Foundry
│       ├── foundry.toml
│       ├── src/                       # custom ERC-3643-compatible token, compliance modules, ONCHAINID integ
│       ├── test/                      # *.t.sol — unit + fuzz + invariant
│       ├── script/                    # deploy to Sepolia
│       └── lib/                       # forge deps: openzeppelin-contracts, T-REX/ONCHAINID refs
├── throwaway/                         # [JETABLE] — deletable with NO impact on /prod
│   ├── coupled-math/                  # FR-15 — reference math + issuer-neutral invariant
│   ├── simulator/                     # FR-16, FR-17 — threshold-only rebalancing
│   │   └── fixtures/                  # EUR/USD + BTC tick CSVs (timestamp,price)
│   └── mockups/                       # historical only (surfaces are functional in P0)
└── tools/
    └── check-regime-boundary.mjs      # CI: assert /prod never imports /throwaway
```

### Architectural Boundaries

- **API boundary:** Fastify REST is the only network ingress to PROD logic; surfaces consume it. Authorization refusals surface as 403/422.
- **Capital-movement boundary:** `postTransfer` is the **only** writer of transfer postings (FR-7). The double-entry trigger is the database-level backstop (FR-3).
- **Chain boundary:** the `chain` package is the only module talking to Sepolia (viem). Dual writes cross this boundary via the **outbox** with the on-chain tx as commit point.
- **Rule boundary:** the `rule-spec` package is the only source of authorization rules; `authorization` (off-chain) and `contracts` (on-chain) consume generated artifacts + conformance vectors.
- **Regime boundary:** `/prod` ↮ `/throwaway` (CI-enforced, orthogonal to language).
- **Money boundary:** testnet/paper vs real is a gated runtime switch — never a config flip to mainnet/real capital (§11.3).

### Requirements-to-Structure Mapping

| Area | FRs | Location |
|---|---|---|
| Double-entry ledger | FR-1, FR-2, FR-3, FR-13 | `prod/packages/ledger` |
| Coupled-pair contract & lifecycle | FR-4, FR-6, FR-12 | `prod/packages/coupled-pair` |
| Authorization chokepoint (off-chain) | FR-5, FR-7, FR-8 | `prod/packages/authorization` |
| Rule equivalence (single source) | FR-19, §8 Q5 | `prod/packages/rule-spec` |
| On-chain compliance / mint / burn / agent powers | FR-18, FR-19, FR-21, FR-22 | `prod/contracts` + `prod/packages/chain` |
| Reconciliation & group view | FR-9, FR-10 | `prod/packages/reconcile` |
| Rose Note lifecycle & paper execution | FR-11, FR-20, FR-21 | `prod/packages/rose-note` |
| Engine surfaces (all functional) | FR-14 | `prod/packages/api` + `prod/packages/web` |
| Coupled-coin model validation | FR-15, FR-16, FR-17 | `throwaway/coupled-math`, `throwaway/simulator` |

**Cross-cutting:** money/scale → `shared`; parked-param config + refuse-if-absent → `config`; logging/audit → all PROD modules (NFR-3).

### Data Flow

Subscription (UJ-1/UJ-5): Subscriber (allowlisted, valid ONCHAINID claim) → `api` → `rose-note` → `chain` mints paired ERC-3643 L/S on Sepolia (commit point) → on confirmation `ledger` posts one balanced journal entry (value + token quantity) via `postTransfer`-governed flows → `reconcile` confirms ledger↔chain → surfaces render live (`web`). Forbidden flows (UJ-3) are rejected by `postTransfer` (off-chain) and the compliance rule (on-chain), both derived from `rule-spec`.

---

## Architecture Validation Results

### Coherence Validation ✅

- **Decision compatibility:** TypeScript/Node 24 + Drizzle/PostgreSQL 18 + viem 2.52 + Foundry/OZ 5.6 + Fastify/React-Vite are mutually compatible, current (verified June 2026), and consistent with PRD addendum §A. The chain-authoritative + outbox model aligns with NFR-9.
- **Pattern consistency:** integer-money + glossary naming + single-chokepoint + single-rule-source patterns directly support the data, authorization, and consistency decisions. No contradictory decisions found.
- **Structure alignment:** the `/prod` (+ `contracts`) / `/throwaway` tree realizes the two-regime discipline and maps 1:1 to FR groups; `coupled-pair` is positioned to be frozen first.

### Requirements Coverage Validation ✅

- **Functional coverage:** all 21 FRs map to a concrete module (see table). User journeys UJ-1…UJ-5 are realizable end-to-end.
- **NFR coverage:** NFR-1 (DB trigger), NFR-2 (BigInt/NUMERIC + scale + rounding), NFR-3 (journal+postTransfer+tx hash, append-oriented), NFR-4 (fail-closed both planes), NFR-5 (drizzle reversible migrations + CI), NFR-6 (invariant tests first), NFR-7 (TS-only P0 with seams), NFR-8 (provider/interface substitutability), NFR-9 (outbox/saga + reconcile-and-correct) — all addressed.
- **Acceptance criteria:** every P0 acceptance criterion has a home (ledger trigger test, postTransfer reject test, on-chain compliance reject test, paired mint/burn reconcile test, agent-power authz test, deliberate-divergence reconcile-and-correct test, provider substitution test, end-to-end subscription, simulator invariant + lifecycle).

### Implementation Readiness Validation ✅

- **Decision completeness:** all critical decisions documented with verified current versions and rationale; the 4 genuine forks resolved with Fabrice this session.
- **Structure completeness:** complete tree with every module, the contracts suite, and throwaway harness defined; boundaries explicit.
- **Pattern completeness:** naming, format, communication, and process patterns cover the identified conflict points with mandatory rules and anti-patterns.

### Gap Analysis Results

**Critical gaps:** none blocking P0 spine.

**Important gaps (tracked, non-blocking — owned by PM/legal/board, not architecture):**

- **D1** Rose Note composition & reset loss-allocation (§8 Q1) — schema/contract support both interpretations; blocks *final instrument design*, not P0 validation.
- **Floor-parameter method** for `m`/`g` (§8 Q7, SM-C1) — must be chosen by a stated, defensible method *before* observing reset rate, else the metric is unfalsifiable. (Parked param; config-driven, refuse-if-absent.)
- **Jurisdictions (§8 Q3)** and **claim-issuer/transfer-agent operating model (§8 Q4)** — parameterized placeholders; legal/business inputs.

**Minor gaps (architecture defaults, revisable):** frontend stack (React+Vite), API style (Fastify REST), operator/Subscriber session auth, reconciliation cadence (per-event + on-demand) and finality depth — all documented as defaults open to revision; none block implementation.

### Validation Issues Addressed

The four genuine forks (ORM, contract toolchain, hot-path strategy, rule-equivalence mechanism) were resolved with Fabrice. SPEC.md supersession is flagged as a documentation handoff item.

### Architecture Completeness Checklist

**Requirements Analysis**

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**Architectural Decisions**

- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed (real-time orientation; TS-only P0 with seams for Rust/Go, NFR-7)

**Implementation Patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**Project Structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION (all 16 checklist items `[x]`; no Critical Gaps open — the Important gaps are product/legal/board items the PRD already parks and which do not block the P0 spine).

**Confidence Level:** high — the PRD/addendum pre-decided the load-bearing stack; the remaining forks are resolved and current versions verified.

**Key Strengths:** integrity-by-construction (DB-enforced invariant); dual-plane authorization derived from a single rule source; chain-authoritative consistency with an outbox/saga and reconcile-and-correct backstop; strict two-regime + money-boundary safety; falsifiable model validation isolated in throwaway.

**Areas for Future Enhancement:** resolve D1; Rust/Go hot-path implementation at scale-up; real-venue/mainnet (board-gated); cross-jurisdiction reconciliation; broader Subscriber surfaces.

### Implementation Handoff

**AI Agent Guidelines:** follow these decisions exactly; use glossary terms; keep integer money; route through `postTransfer`; derive rules from `rule-spec`; respect the regime and money boundaries; write invariant tests first; refuse on absent parked params.

**First Implementation Priority:** the monorepo scaffold + regime-boundary CI guard, then the Drizzle schema with the **double-entry DEFERRABLE trigger** and its invariant tests (test-first), then freeze the **coupled-pair** inter-track contract.

**Documentation handoff:** update `docs/SPEC.md` to reflect the PRD-governed P0 scope (EVM/ERC-3643/mint/subscription/paper execution now in P0).
