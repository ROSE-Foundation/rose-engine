# rose-engine

A regulated real-time financial-infrastructure product. P0 is a full vertical-slice MVP
on **Sepolia testnet + paper execution, with no real capital**.

## Two-regime monorepo

This repository is split into two regimes with a **hard, CI-enforced boundary**:

- **`/prod`** — production code. Depends on **nothing** in `/throwaway`.
- **`/throwaway`** — disposable model-validation / mockup code. May depend on `/prod`,
  and can be deleted with zero impact on `/prod`.

> **The rule:** `/prod` must never import from `/throwaway`. The reverse is tolerated.
> Enforced by `tools/check-regime-boundary.mjs` (run in CI and via `pnpm check:regime`).

## Layout

```
prod/
  packages/        # PROD TypeScript domain packages (pnpm workspace)
    shared/        # @rose/shared — money/BigInt + decimal-scale utils, glossary enums, error types
    config/        # @rose/config — typed, fail-closed config loader (refuse-if-absent, Zod)
    ledger/        # @rose/ledger — double-entry ledger: schema, reversible migrations, repositories (Drizzle + pg)
    rule-spec/     # @rose/rule-spec — single-source rule DSL (Zod), off-chain/on-chain policy codegen, dual-plane conformance vectors
    authorization/ # @rose/authorization — default-deny authorization provider + the single postTransfer capital-flow chokepoint
    chain/         # @rose/chain — typed viem clients, event watchers, and the mint/burn dual-write onto the outbox/saga
    reconcile/     # @rose/reconcile — ledger↔chain reconciliation, correcting the ledger toward the chain (chain is source of truth)
  contracts/       # Solidity / Foundry — custom ERC-3643-compatible token suite (ONCHAINID identity, atomic paired mint/burn, Model-A bright line, agent powers)
throwaway/
  mockups/         # historical HTML mockups (surfaces are functional in P0)
tools/
  check-regime-boundary.mjs   # CI: assert /prod never imports /throwaway
```

## Status

P0 vertical slice, built epic by epic (all on-chain/network flows proven locally —
real Sepolia broadcast is a deferred ops step, no secrets committed):

- **Epic 1 — Foundation & double-entry ledger spine.** ✅ done
- **Epic 2 — Coupled-pair contract & lifecycle** (incl. Rose Note embedding). ✅ done
- **Epic 3 — Capital-flow authorization** (single-source rules, default-deny provider, `postTransfer` chokepoint). ✅ done
- **Epic 4 — On-chain permissioned tokens & compliance** (ERC-3643 on OpenZeppelin: identity, eligibility, atomic paired mint/burn, Model-A, dual-plane conformance, agent powers). ✅ done
- **Epic 5 — Ledger↔chain integration** (typed clients, outbox/saga dual-write, mint/burn, group view, reconciliation). ✅ done
- **Epic 6 — Live Rose Note slice & engine surfaces.** ⏳ next

## Toolchain

- **Node.js 24 LTS** (CI target; see note below), **pnpm** workspaces + **Turborepo**.
- **TypeScript 5.x**, ES modules, `strict` everywhere; `tsx` for dev, `tsc` for builds.
- **Vitest** (TypeScript) + **Foundry/`forge`** (Solidity).
- **ESLint** + **Prettier**.
- **PostgreSQL 18** + **Drizzle ORM** / **pg** (ledger data layer), with reversible migrations.
- **Zod** for the typed, fail-closed configuration loader.

> **Node version note:** the architecture targets Node 24 LTS and CI pins it. Local
> development also works on Node 20+ (the toolchain is compatible); `engines.node` is set
> to `>=24` and enforced in CI, not as a hard local install gate.

## Commands

```bash
pnpm install          # install workspace dependencies
pnpm typecheck        # TypeScript project-wide typecheck (tsc -b)
pnpm lint             # ESLint
pnpm test             # Vitest (unit tests)
pnpm format           # Prettier (write)  /  pnpm format:check
pnpm check:regime     # enforce /prod ↮ /throwaway boundary
pnpm check:migrations # prove migration reversibility (up → down → up) via @rose/ledger
pnpm build            # build all packages (tsc -b)

# Local database (PostgreSQL 18, host port 5544 → container 5432)
docker compose up -d postgres

# Ledger migrations (run from repo root; requires DATABASE_URL)
tsx prod/packages/ledger/src/migrate-cli.ts up        # apply pending migrations
tsx prod/packages/ledger/src/migrate-cli.ts down [n]  # roll back n migrations (default 1)
tsx prod/packages/ledger/src/migrate-cli.ts reset      # roll all back, then re-apply
tsx prod/packages/ledger/src/migrate-cli.ts verify     # reversibility check (= pnpm check:migrations)

# Solidity (in prod/contracts)
cd prod/contracts && forge build && forge test
```

## Local setup

```bash
cp .env.example .env       # then fill DATABASE_URL / SEPOLIA_RPC_URL (no secrets committed)
docker compose up -d postgres
pnpm install
pnpm check:migrations      # verifies the ledger schema migrates and reverses cleanly
```

> The typed config loader is **fail-closed**: it refuses to start when a parked,
> correctness-critical parameter is absent rather than defaulting it. See `.env.example`.
