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
    rose-note/     # @rose/rose-note — Rose Note composition layer: subscription, redemption & coupled-pair strategy execution (paper/testnet)
    api/           # @rose/api — typed REST boundary (Fastify + Zod + OpenAPI): read + subscribe/redeem/strategy write endpoints
    web/           # @rose/web — operator & subscriber surfaces (React + Vite + Tailwind v4 + TanStack Query) on the OpenAPI-typed contract
  contracts/       # Solidity / Foundry — custom ERC-3643-compatible token suite (ONCHAINID identity, atomic paired mint/burn, Model-A bright line, agent powers)
throwaway/
  coupled-math/    # @throwaway/coupled-math — exact-BigInt reference math: leg values, issuer-neutral invariant, floor detection
  simulator/       # @throwaway/simulator — threshold-only rebalancing simulator + the trial (no-negative-leg proof, journal-every-reset, lifecycle traversal)
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
- **Epic 6 — Live Rose Note slice & engine surfaces** (typed REST API, live subscription/redemption, paper strategy execution, Covenant Console + coupled-pair + exchange/trading + subscriber surfaces). ✅ done
- **Epic 7 — Coupled-coin model validation** (throwaway trial: exact reference math, threshold-only rebalancing simulator, no-negative-leg proof + full lifecycle traversal). ✅ done

**All seven epics complete.** The trial confirms the model's issuer-neutral invariant
`V_A + V_B = K` **conditionally** — it holds exactly within the barrier and the simulator
explicitly detects/reports the break condition (a price gap past the floor), matching the
PRD's stated key model risk (§15).

> The real Sepolia broadcast (deploy + live mint/burn/subscription confirmation) is a
> deferred ops step gated on out-of-band secrets; all on-chain flows are proven locally
> (Foundry EVM + mock transports). No secrets are committed.

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

## Shared live environment (PaaS)

> **Participants:** see **[DEMO.md](DEMO.md)** for what the demo contains, how to test, and exactly
> what is real vs simulated (mocked).

For letting participants exercise the screens, the app deploys as **one web service**: the Fastify
API (`@rose/api`) serves the `@rose/web` static build on the **same origin** (no CORS), all behind
**one shared basic-auth gate**. The entrypoint is `prod/packages/api/src/serve.ts`.

**Access control — refuse-if-absent.** The server **refuses to start** unless **both**
`BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are set (a live environment is never exposed without
protection), and unless `DATABASE_URL` is set (no silent local-default in a deployment). The gate
protects **every** route — the API, `/openapi.json`, the static front-end, and the SPA fallback.
Credentials are compared in constant time and are read **only** from the environment (no secret is
committed or baked into the image).

**Paper mode — `ENGINE_MODE=paper` (fully interactive, simulated).** Set `ENGINE_MODE=paper` and the
chain-dependent **write** services (subscribe / redeem / strategy) are composed as an **in-process
simulation**: every screen becomes fully interactive and a subscription / redemption / strategy reset
completes end-to-end (`pending → confirmed`, with a balanced ledger entry) — but the **on-chain effects
are SIMULATED, not real**. There is **no Sepolia, no RPC, and no secret**: a network-free transport
stands in for the chain and the on-chain confirmation event is synthesized in-process (the exact seam
the `@rose/chain` 5.3/5.4 and `@rose/rose-note` 6.2/6.3/6.4 test suites already prove). The server logs
a clear `PAPER MODE: on-chain effects are simulated, not real …` banner at boot. On boot it also seeds a
demo coupled pair / Rose Note, the typed accounts, and a starting position; the **allowlist-eligible**
subscriber address for the demo is `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (any other address is
refused with `403`, the FR-19 eligibility analogue). The front-end carries this participant identity
via `VITE_SUBSCRIBER_ADDRESS`, **baked at web build time** (real session auth carrying the ONCHAINID
claim is deferred); the `Dockerfile` defaults that build arg to the eligible address above, so the
deployed UI can actually subscribe/redeem. Override it with
`docker build --build-arg VITE_SUBSCRIBER_ADDRESS=0x…`. The demo blueprint (`render.yaml`) sets
`ENGINE_MODE=paper` by default — it is a **non-secret** value, safe to commit.

> Without `ENGINE_MODE=paper` (and with no real chain config), the write routes return the existing
> typed `503` (refuse-if-absent) — paper mode is **never** enabled silently. The read surfaces and the
> whole UI render fully regardless. The migrations run automatically on boot.

> For **real** on-chain writes (a true Sepolia broadcast + live `PairMinted`/`PairBurned` confirmation)
> the deployment needs the out-of-band Sepolia secrets (`SEPOLIA_RPC_URL` + the deployed contract
> addresses + an out-of-band signer); that path remains **deferred** and is not wired here.

### Deploy on Railway (primary)

Railway builds the single-service image straight from the repo `Dockerfile` (config in
`railway.toml`). No secret is committed — credentials are Railway service variables.

1. Push this repo, then in Railway: **New Project → Deploy from GitHub repo**, select it (the
   `Dockerfile` + `railway.toml` are detected automatically).
2. Add a **Postgres** plugin to the project (**New → Database → Add PostgreSQL**). It exposes a
   `DATABASE_URL` variable on the database service.
3. On the **app service → Variables**, set:
   - `DATABASE_URL` → reference the plugin's value: `${{Postgres.DATABASE_URL}}`
   - `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` → your shared login/password (secrets)
   - `ENGINE_MODE` → `paper` (fully-interactive simulated write flows; non-secret)
   - `PORT` is injected by Railway and already honored by `serve.ts`.
4. Deploy. On boot the server applies migrations and listens on `$PORT`. (No healthcheck path is
   configured because the basic-auth gate also covers `/health`; Railway's port check is used.)
5. Seed the demo data once so the screens aren't empty — from the service shell (or `railway run`):

   ```bash
   node /app/prod/packages/api/dist/seed-demo.js
   ```

6. Open the Railway-provided URL and authenticate with the credentials above.

### Deploy on Render (blueprint, alternative)

1. Push this repo (the blueprint is `render.yaml`: one Docker web service + one managed Postgres).
2. In Render: **New → Blueprint**, select the repo. Render provisions the Postgres database and
   wires `DATABASE_URL` into the web service automatically (via `fromDatabase`).
3. Set the **two secrets** in the service's **Environment** tab (they are `sync: false`, so they
   are never read from the committed file): `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`.
4. Deploy. On boot the server applies migrations, then listens on `$PORT`.
5. Seed the demo data once (so the screens aren't empty) from the service **Shell**:

   ```bash
   node /app/prod/packages/api/dist/seed-demo.js
   ```

> **Fly.io** works the same way with the **same `Dockerfile`**: provision a managed Postgres, then
> set `DATABASE_URL`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD`, and `ENGINE_MODE=paper` (`PORT` is
> provided by the platform).

### Test the same image locally

Build and run the production image exactly as the PaaS does (the gate is mandatory — omit either
credential and the container exits immediately with a clear refusal):

```bash
docker build -t rose-engine .

# Point at a reachable Postgres. For the local docker-compose DB, use host.docker.internal:5544.
# Add `-e ENGINE_MODE=paper` for the fully-interactive SIMULATED write flows (no Sepolia, no secret);
# omit it to keep the write routes at the typed 503.
docker run --rm -p 8080:8080 \
  -e BASIC_AUTH_USER=demo \
  -e BASIC_AUTH_PASSWORD=change-me \
  -e ENGINE_MODE=paper \
  -e DATABASE_URL=postgres://rose:rose@host.docker.internal:5544/rose_engine \
  rose-engine

# In another shell, seed the demo data into the SAME database:
DATABASE_URL=postgres://rose:rose@localhost:5544/rose_engine \
  pnpm --filter @rose/api seed:demo
```

Then open <http://localhost:8080> and authenticate with the credentials above. Local dev without
Docker: `pnpm --filter @rose/api serve:dev` (after `pnpm build`), with the four env vars set.
