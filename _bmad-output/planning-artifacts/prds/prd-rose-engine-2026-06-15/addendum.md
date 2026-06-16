# ROSE Engine PRD — Addendum

Downstream depth that belongs to architecture / engineering rather than the PRD's main narrative. The PRD states *what* and *why*; this captures *how* and *rationale*, preserved so it is not lost.

## A. Technical stack (PROD regime) — updated by review decisions

- **Default language: TypeScript (Node 20+).** Chosen over Python because the EVM/ERC-3643 ecosystem is natively TS (viem/ethers, Hardhat/Foundry tooling, T-REX reference implementation) and `BigInt` is native. Supersedes SPEC's "pick TS *or* Python".
- **Performance-critical modules: Rust or Go.** High-frequency / latency-sensitive paths (execution/matching, real-time pricing/rebalancing engine) are written in Rust or Go. The PROD/throwaway regime boundary is **orthogonal to language** — a Rust/Go hot-path module is still PROD.
- **Database:** PostgreSQL. **No SQLite in PROD** — the integrity constraints depend on it.
- **Numeric representation (see NFR-2):** amounts are **integers in smallest units**, never binary float. Use **`BigInt` in code**; use **`NUMERIC` (arbitrary precision) when `bigint`/int64 is insufficient** — int64 caps ~9 tokens at 18 decimals, so 18-decimal ERC-3643/ERC-20 amounts need `NUMERIC`. Store **decimal scale per asset** (EUR=2, BTC=8, token=`decimals()`). **Supersedes SPEC's `bigint` for `collateral_pool K` and `amount`.** Apply a **deterministic remainder/rounding policy** (e.g. one leg absorbs the residual unit) so posted integers preserve `V_A+V_B=K` exactly; model math may compute at higher precision but postings stay exact integers.
- **On-chain stack (P0):** EVM on **Sepolia testnet**; a **custom ERC-3643-compatible security token built on OpenZeppelin** with ROSE-specific compliance rules (eligibility, the Model-A bright line, pair coupling, principal/yield handling); **ONCHAINID** identity registry; a trusted **claim issuer**; standard ERC-3643 **agent powers** (forced transfer, recovery, freeze, pause) gated to a transfer-agent role. Plain stock ERC-3643/T-REX is insufficient because (a) it is per-token, so "never a single leg" + atomic paired mint need bespoke coupling logic, and (b) a fungible token cannot distinguish principal from yield, which the custom rules handle (e.g. segregated principal sub-positions). Claim-issuer / transfer-agent operating model TBD (Open Qs).
- **Source of truth (D3):** the **chain is authoritative** for token ownership/positions; the off-chain ledger is the accounting record and is **corrected toward the chain** on conflict. Dual writes use an **outbox/saga with the on-chain tx as the commit point** (idempotency + compensation); reconciliation is the backstop and journals any correcting entry. Chain finality/reorg handling TBD with architecture.
- **Migrations:** versioned and reversible from the first commit (Prisma/Drizzle).
- **Tests:** double-entry, authorization, and on-chain compliance invariants are covered by tests *before* any application logic is layered on top.

## B. Double-entry invariant — implementation options

Enforce in-database, not in application code: a PostgreSQL `AFTER INSERT/UPDATE` trigger on `postings`, or a `DEFERRABLE` constraint checked at transaction end. An unbalanced entry must fail the transaction. Non-negotiable even past v1 — "the only thing that distinguishes a ledger from a spreadsheet."

## C. Authorization chokepoint — interface design

- `postTransfer(from_account, to_account, amount, context)` is the single writer of transfer postings.
- It consults an `AuthorizationProvider` interface **before** writing; default-deny.
- P0 off-chain implementation: `OffChainPolicyProvider` reading a local `flow_permissions` table.
- **On-chain enforcement is now P0 (not P3+):** the same rule *intent* also lives on-chain as compliance rules in the **custom ERC-3643-compatible contract** (eligibility + Model-A + pair coupling). Off-chain `flow_permissions` and on-chain rules must stay equivalent; the design goal is to derive both from a **single rule specification** so they cannot silently diverge (FR-19) — the exact single-source mechanism is an open architecture question (§8 Q5).
- The original SPEC framing ("on-chain provider = P3+ substitution, app-level enforcement as accepted v1 debt") is **superseded**: on-chain compliance arrives in P0.

## D. Coupled-coin reference math (Throwaway regime) — from SPEC

```
r   = (P − P₀) / P₀          # reference deviation from the anchor
L   = leverage factor         # 1× by default
K   = collateral pool (cash, sum of both legs)
V_A = (K/2)·(1 + L·r)         # long leg
V_B = (K/2)·(1 − L·r)         # short leg
INVARIANT : V_A + V_B = K  for all P  → issuer net = 0
floor f = m · L · g           # g = worst plausible gap over the reaction window; m = safety margin
```

- Unit tests: `V_A + V_B == K` across a price grid **within the barrier** (issuer-neutral invariant).
- Tests: no leg goes negative while P stays within the barrier; floor-breach detection; explicit test for a gap **past** the floor (the condition under which issuer-neutrality can break — the key model risk).

**Scope of the formula & open economics.** `(K/2)(1±L·r)` describes the **issuance/active state only**. It does NOT define the **post-reset asymmetric state**, **who bears the losing holder's locked loss**, or **what a holder holds after a reset** — that is the deferred D1 product decision (PRD §4.2 note, §8 Q1). "Delta-neutral at issuance" = "market-neutral on the underlying"; it does not imply a holder stays neutral after a reset. **`m` and `g` are parked parameters** (config, refuse-if-absent — PRD §11.2); SM-C1 requires choosing them by a stated method *before* observing the reset rate, else the metric is unfalsifiable.

### Coupled-pair field types (from SPEC §3.4 — freeze first)
`anchor_price` (P₀) `decimal(18,8)`; `leverage` (L) `decimal` (per-pair); `collateral_pool` (K) integer smallest-unit (**`NUMERIC` not `bigint`** for 18-decimal tokens — see §A); `floor` (f) `decimal`; `state` enum `PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`; `reference_asset` text; timestamps `timestamptz`.

### Simulator rationale
- **Threshold-only** rebalancing — reset fires *only* when a losing leg breaches floor `f`, **never on a clock**. Clock-based rebalancing would import leveraged-ETF volatility decay — the trap to avoid.
- At reset: lock current dollar values, re-anchor P₀ to current price; the losing holder's loss is locked.
- Refutation objective: at L=1 on EUR/USD the barrier should be ~100% away and almost never trigger. BTC (P0 second pair) is a higher-volatility stress test of the same invariant — confirm intended L/barrier for BTC.
- Input: example tick CSV `timestamp,price`. No live OANDA/LMAX integration in P0.

## E. Suggested repository organization — from SPEC

```
/prod/            # [PROD] — depends on nothing in /throwaway
  ledger/
  entities/
  authorization/  # AuthorizationProvider + OffChainPolicyProvider
  reconcile/
  migrations/
  tests/
/throwaway/       # [JETABLE] — deletable with no impact on /prod
  coupled-math/
  simulator/
  mockups/
SPEC.md
```
**Dependency rule, CI-enforced where possible:** `/prod` never imports `/throwaway`; the reverse is tolerated.

## F. Legal / tokenisation structure (from the May 2026 structure memo) — context the Engine is built toward

- **ROSE VCC – Rose Perpetual Strategies Sub-Fund:** Note issuer; controls the group; issues Rose Notes embedding a coupled L+S perpetual-token package, delta-neutral at issuance.
- **Namara Wealth Advisors:** licensed investment manager of the VCC.
- **Rose Holding Pte. Ltd. (Singapore):** 100% owned by the VCC; holds all shares of trading and coin-issuance entities; governance flows VCC → Holding → operating cos.
- **Rose Offshore Trading Co. (Jurisdiction 1):** trading engine — ARP + perpetual-futures strategies across CEX/DEX, treasury & FX, own bank/brokerage/exchange accounts.
- **Rose Coin Issuer Co. (Jurisdiction 2):** issuance/lifecycle of synthetic L-Token/S-Token, coin treasury, on-chain liquidity (wallets, DEX pools).
- **Flow conventions:** solid = legal ownership; green = cash/NAV; red dashed = token/crypto operational flows (do not change legal ownership). P&L accrues to the VCC via equity ownership.

**Entity-code mapping to the PRD ledger (reconciled with the memo):** PRD entity codes are `VCC`, `HOLDING`, `TRADING_CO`, `COIN_ISSUER`. The original SPEC code `ISSUER_EXCHANGE` is **renamed `COIN_ISSUER`** — it conflated issuance with the exchange, but the memo places **exchange/CEX/DEX accounts under `TRADING_CO`** and **coin treasury / on-chain liquidity under `COIN_ISSUER`**. **VCC accounts are cash/NAV only** (subscriptions/redemptions, NAV) plus a wallet/custodian for cash rails; token and trading flows route through the operating entities. Coupled packages move between entities as **whole L+S units** (collateral, hedging, liquidity inventory) — never single legs — and the hybrid ledger tracks + reconciles those cross-entity package flows.

## G. Laplace precedent (greenfield reference, NOT a code dependency)

- Laplace group already runs a closely mirroring structure; **Laplace AM** is sole subscriber to a VCC sub-fund and issues tokenised notes to sophisticated clients via **laplace.digital** using smart-contract tokenisation.
- The memo framed the need as "upgrade the current platform stack." **User decision overrides this: ROSE Engine is greenfield** — Laplace is proof the pattern works in production and a reference for UX/compliance/reporting expectations, not the basis codebase.

## H. Broader ROSE context (why the Engine matters) — not Engine scope

- ROSE = six interdependent domains (Money System, Engine, EDIN, Living Movement, Balanced Governance, Commons). Living-systems framing: the Engine is the "mitochondria" generating energy for the organism; coupled coins are the "circulating molecules."
- "Engine-first → Funding-first" is the decided sequencing across the whole ROSE corpus.
- The Commons allocation (Swiss non-profit) ultimately funds societal/scientific/environmental work (up to a hardware lab near Geneva). The Engine's soundness is the precondition for any of it.

## I. Parked questions carried from source (do not invent values)

- Coupon of the Rose Note; use-of-proceeds split; conversion-to-participation; backing-float contractual floor. Read from config; absence → explicit refusal.
