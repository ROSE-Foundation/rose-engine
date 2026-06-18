# Correct Course — Secondary single-leg trading, position model & price oracle

**Status:** recommendation (awaiting product/architecture sign-off — NOT implemented)
**Raised by:** mock-faithful redesign program, spec #5 (Exchange terminal), 2026-06-18
**Companion:** `spec-exchange-terminal.md` (the honest terminal UI that WAS built)

## The change the mock implies

`docs/mocks/exchange.html` is a perp-style trading terminal where a user:

- buys a **naked LONG or naked SHORT leg** of a market (not the coupled package),
- chooses **leverage** per position,
- sees a **live mark price**, **entry price**, **per-position P&L**, and **max loss**,
- holds **per-user positions** listed with size / entry / mark / P&L / collateral.

## Why this is a Correct Course, not a Quick Dev increment

It is not one cohesive feature on the existing architecture — it is three new capabilities that cross PRD, architecture, and the deployed contracts:

1. **Conflicts with the core atomic-coupling invariant.** ROSE's safety property (FR / Epic 4, stories **4-3** "atomic paired mint/burn — single-leg impossible" and **4-4** Model-A bright line) is that L and S are **only ever minted/burned as a pair**. The `CoupledPair`/`CoupledLeg` ERC-3643 contracts enforce single-leg-impossible **on-chain** and are **deployed/tested (and audit-shaped) toward Sepolia**. A "buy a naked long" order cannot be honored without either breaking this invariant or introducing a counterparty mechanism. Changing the invariant is a **product-safety decision**, not an implementation detail — CLAUDE.md forbids silently changing core functionality to fit a UI.
2. **Needs a per-user position model that doesn't exist.** The ledger tracks the **issuer's** coupled pairs and double-entry balances; there is no per-user position entity (owner, side, size, entry price, collateral, realized/unrealized P&L). This is a new schema + repo + API surface.
3. **Needs a price oracle / market-data feed.** Entry/mark/P&L, the chart, and 24h stats all require live + historical prices. There is **no price feed or tick store** in the system today (the reconcile/divergence path reads on-chain supply, not market prices).

Any one of these is epic-sized; together they redefine the product from a primary-issuance engine into a secondary-trading venue.

## Resolution options (starting point for the re-plan)

**A. Order-book matching (atomic coupling preserved).** A long order and a short order on the same market **match** to mint one coupled pair, split between the two users. Each user "owns" one leg; the pair is always whole on-chain. Needs: a matching engine, per-user leg-ownership tracking, an oracle for marks, and redemption/settlement that burns the pair when both legs unwind. **Invariant intact.** Highest build cost.

**B. Market-maker / AMM counterparty (atomic coupling preserved).** A liquidity provider always holds the opposite leg; the trader gets one leg, the MM the other; the pair mints atomically. Needs MM capital, pricing/spread, inventory risk management, oracle. **Invariant intact.** Medium-high cost.

**C. Off-chain synthetic position layer (least contract change).** On-chain stays atomic-pair issuance; per-user "positions" are tracked **off-chain** against issued pairs, with P&L marked from an oracle. No contract change to the coupling invariant; the on-chain truth remains paired. Needs the position ledger + oracle + a custody/assignment model. **Invariant intact; lowest on-chain risk.** Recommended first analysis.

**D. Redefine the contracts to allow single-leg positions.** Directly enables the mock's naked-leg model but **breaks the atomic-coupling safety invariant** on deployed/audited contracts. **Not recommended** without an explicit product decision and a fresh audit.

## Recommended next steps (BMad)

1. **`bmad-correct-course`** — assess scope; this will likely route to:
2. **PRD update** — does ROSE offer secondary single-leg trading at all, and under which option (A/B/C/D)? This is a product/regulatory decision (segregation, leverage, who bears leg risk — cf. `[[d1-rose-note-loss-allocation]]`).
3. **`bmad-create-architecture`** (or an architecture decision) — position model, oracle integration, matching/AMM (if A/B), and the on-chain vs off-chain boundary.
4. **New epic + stories** — implement on top of the chosen architecture, with the full plan→dev→adversarial-review→Sepolia cycle the contracts demand.

## What spec #5 delivered honestly (so this isn't blocking the UI)

The Exchange terminal UI ships now (`spec-exchange-terminal.md`): the 3-column layout, the market list from the live `coupledCoinBook`, the pair strip with real derived leg-token symbols, an order ticket of **real package terms** wired to the **real subscribe/redeem coupled-package flow**, and an open-positions table of **real coupled pairs** with mark-to-market from real params. Every price-oracle-dependent element (chart, live mark, 24h stats, live P&L) is an **explicit empty-state**, not fabricated data. Naked-leg trading, the per-user position ledger, the oracle, and any contract change are the scope of this Correct Course.
