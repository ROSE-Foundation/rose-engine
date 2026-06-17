# ROSE Engine — Demo Guide

This is a **P0 vertical-slice demo** of the ROSE Engine. It runs on **paper/testnet with no real
capital**. Its purpose is to let participants **exercise the screens and the end-to-end flows** of
the product on real backend logic — while being explicit about which parts are **real** and which
are **simulated (mocked)**.

> **One-line summary:** every screen is live and fully navigable, and you can complete a
> subscription, a redemption, and a strategy reset end-to-end — but the on-chain settlement
> underneath those actions is **simulated in-process**, not a real blockchain transaction.

---

## 1. What the demo contains

The application is a **single web service**: a typed REST API that also serves the web UI on the
same origin, behind one shared login. Four operator/subscriber surfaces are available:

- **Covenant Console** — the consolidated group view: the four entities (`VCC`, `HOLDING`,
  `TRADING_CO`, `COIN_ISSUER`), their accounts and balances, and overall state. Read-only.
- **Coupled-Pair** — a coupled pair's live state: the two legs (`V_A` / `V_B`), anchor price `P₀`,
  floor, leverage, and the lifecycle badge (`PENDING → ACTIVE → REBALANCING → … → CLOSED`).
- **Exchange / Trading** — paper trading positions and realized P&L by entity, derived from the
  group view and the open coupled-pair legs.
- **Subscriber** — the participant-facing surface: browse a Rose Note, then **subscribe** or
  **redeem** through a Review → Confirm flow with a pending state.

On boot the server applies database migrations and (in paper mode) seeds representative demo data:
the typed accounts, **one delta-neutral coupled pair**, **one embedded Rose Note**, the token-leg
accounts, and a starting minted position so that redemptions and strategy resets have supply to act
against.

---

## 2. How to access and test

### Identities — two distinct things

1. **Site login (HTTP Basic Auth).** A single **shared** username/password that gates the whole
   site. It is **chosen by whoever runs the deployment** via environment variables
   (`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`) — there is no predefined account. Your browser shows
   its native login dialog.
2. **Participant identity (for subscribe/redeem).** The Subscriber surface acts as a fixed,
   allowlist-eligible address: **`0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`**. This identity is
   **baked into the web build** (there is no address field in the UI). Any other address would be
   refused with `403` (the eligibility analogue). You do not log in as this address — the app
   already carries it.

### Option A — Hosted (Railway)

Open the deployment URL and authenticate with the shared Basic Auth credentials the operator gave
you. That is all a participant needs.

### Option B — Run locally with Docker

```bash
docker compose up -d postgres
docker build -t rose-engine .
docker run --rm -p 8080:8080 \
  -e BASIC_AUTH_USER=demo \
  -e BASIC_AUTH_PASSWORD=change-me \
  -e ENGINE_MODE=paper \
  -e DATABASE_URL=postgres://rose:rose@host.docker.internal:5544/rose_engine \
  rose-engine

# In another shell, seed the demo data into the SAME database (one-off):
DATABASE_URL=postgres://rose:rose@localhost:5544/rose_engine pnpm --filter @rose/api seed:demo
```

Then open <http://localhost:8080> and log in with `demo` / `change-me`.

### A suggested walkthrough

1. Open **Covenant Console** — see the four entities and their balances.
2. Open **Coupled-Pair** — see the seeded pair's legs, anchor, floor, and lifecycle badge.
3. Open **Subscriber** — pick the Rose Note, **Subscribe** for an amount, Confirm. The position
   shows **pending**, then flips to **confirmed** (a balanced ledger entry is recorded).
4. **Redeem** the position — it confirms and the note liability is extinguished.
5. (If exposed) push a price **tick** that breaches the floor on the strategy surface — a reset is
   triggered and realized P&L lands on `TRADING_CO`.

The machine-readable API contract is always available at **`/openapi.json`**.

---

## 3. What works (real)

- **All read surfaces** render from the **real** double-entry ledger and group-view logic
  (PostgreSQL): entities, accounts, balances, coupled-pair state, Rose Notes.
- **The full write flows in paper mode** (`ENGINE_MODE=paper`): subscribe, redeem, and strategy
  reset each run the **real** domain logic end-to-end —
  - real eligibility / authorization checks (fail-closed **before** any write),
  - the real **outbox/saga dual-write** with the confirmed event as the commit point,
  - a real **balanced double-entry** posted to the ledger (e.g. `NOTE_LIABILITY` credited on
    subscribe, extinguished on redeem),
  - the real **pending → confirmed** lifecycle.
- **Money is exact** everywhere: integer smallest-units, no floating point.
- **Access control is enforced**: the server refuses to start without the Basic Auth credentials,
  and the gate covers every route (API, UI, OpenAPI).

---

## 4. What is simulated / does NOT work (mocked)

These are deliberate P0 boundaries — the system is **testnet/paper, no real capital**.

- **No real blockchain.** In paper mode the on-chain mint/burn is executed by an **in-process
  simulator**: a network-free transport stands in for the chain and the confirmation event
  (`PairMinted` / `PairBurned`) is **synthesized in-process**. There is **no Sepolia, no RPC, no
  wallet, no gas, and no real transaction hash**. A subscription "confirms" because the simulator
  immediately confirms it — not because a block was mined.
- **No real token transfers / balances on-chain.** The ERC-3643 token suite, ONCHAINID identity,
  and on-chain compliance exist in the codebase and are fully tested against a local Foundry EVM,
  but the demo does **not** talk to a deployed contract.
- **No real user management / product authentication.** The login is a **single shared** Basic Auth
  credential — there is no per-user account, no roles, no logout, no password recovery. The product's
  intended identity model (wallet sign-in carrying the ONCHAINID claim + eligibility) is **deferred**.
- **The participant identity is fixed.** Everyone using the Subscriber surface acts as the same
  baked-in eligible address; you cannot switch identities or test a non-eligible user from the UI.
- **Write flows are disabled when not in paper mode.** Without `ENGINE_MODE=paper` (and without real
  chain configuration), subscribe/redeem/strategy return a typed **`503`** by design — paper mode is
  never enabled silently. Read surfaces still work.
- **Seeded, not historical, data.** The pair, note, accounts, and starting position are demo seed
  data, not a real book of business. Re-running the seed is idempotent (no duplicates).
- **Reconciliation against a real chain is not exercised.** The ledger↔chain reconciliation logic
  exists and is tested, but there is no live chain to reconcile against here.

---

## 5. Why it's built this way

P0 is a **demonstration of structural coherence**, not a production launch: a full vertical slice
(double-entry ledger → coupled-pair contract → single-chokepoint authorization → on-chain compliance
→ ledger↔chain integration → live surfaces) proven **locally and in paper mode**, with the
real-network steps (Sepolia broadcast, real wallet/ONCHAINID auth) intentionally **deferred** behind
out-of-band secrets. This lets reviewers validate the product's logic and screens **without real
capital and without secrets**, while keeping the path to a real testnet deployment open.

The deferred, real-network items are tracked in
`_bmad-output/implementation-artifacts/deferred-work.md`.
