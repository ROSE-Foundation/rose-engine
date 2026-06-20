# @throwaway/delta-engine (Delta Engine PoC)

> **Note** — Renamed from `@throwaway/alpha-engine` on 2026-06-20. The original PoC spec and
> reviews are kept under their historical name in `_bmad-output/implementation-artifacts/`
> (`spec-alpha-engine-poc.md`, `gap-analysis-alpha-engine-poc-2026-06-18.md`, `review-alpha-*`).

**THROWAWAY / R&D** — a closed agent-based market simulation. Deletable with **no** impact on
`/prod`; `/prod` must **never** import this. Not a pnpm-workspace member and not part of the
`/prod` build graph (regime defense). **Binary floats are intentional here** — NFR-2 (exact
arithmetic) binds `/prod` only, never this disposable package.

Implements exactly `docs/alpha_engine_poc_v1.pdf` v1 scope (no Part X deferred features).

## What it does

Two fixed populations of agents — **longs** (EUR-heavy, offer EUR) and **shorts** (BTC-heavy,
offer BTC) — repeatedly try to exchange. **No price is programmed.** Each agent carries a
carry-cost *pressure* `phi` that accrues a flat `c` per tick; when `phi >= d_i` it fires a
home-currency order (`d_i` scales with the agent's initial capital `K0_i`, so large agents fire
rarely — a power-law firing rhythm). Orders accumulate in a rolling `W`-tick queue; at the end of
each tick a **Dutch auction** clears the queue and the internal price `p_int` **emerges**. Trades
are zero-sum exchanges at `p_int`; the only leak is the proportional **carry drain** on each
agent's home leg (toward "the house"), so `total_capital` falls monotonically while the price is
flat. Agents whose capital falls to `<= epsilon` go **bankrupt**, are removed, and their queued
orders are purged. No replenishment.

### Why — intrinsic time at the *market* level

This is the macro/market-level companion to `@throwaway/simulator`'s instrument-level
exploration. Both probe the same **intrinsic-time** thesis — *financial time measured by
meaningful events, not the wall clock*:

- `@throwaway/simulator` (**micro / instrument**): a coupled pair resets only on a **floor-breach
  price event**, never on a clock.
- `@throwaway/delta-engine` (**macro / market**): each agent's **carry-pressure** clock fires by
  threshold; the whole market's price is event-paced and endogenous, with no wall clock anywhere.

These two models are **disjoint** — this PoC shares nothing with the P0 coupled-coin model
(ledger, ERC-3643, compliance, coupled pair, floor-breach reset) and does **not** advance P0. See
`_bmad-output/implementation-artifacts/gap-analysis-delta-engine-poc-2026-06-18.md`.

## Frozen design decisions

The spec is loose on order **denomination**; the implemented (frozen) reading:

- Orders are in the agent's **home currency** — a long offers EUR, a short offers BTC.
- Long demand (EUR) is **price-independent**; short supply in EUR terms is `Σ b_j·p` and **rises
  with price**. The clearing price is the **two-sided crossing** `p_int = D / Btot` (`D` = total
  long EUR demand, `Btot` = total BTC offered by shorts) — the lowest price where short supply
  meets long demand. There is **no `max(prev, …)` floor**: `p_int` is free to both **rise** (longs
  fire more → `D` up) and **fall** (shorts fire more → `Btot` up), so it is *not* a ratchet. The
  previous price is reused **only** in the genuine no-crossing case (one side empty, `Btot = 0`, or
  `D = 0`).
- Cleared volume `V = D` EUR (`= min(D, Btot·p_int)`); both sides fill **largest-first**, the
  marginal order partially fills and its residual stays queued. Per-trade conservation is exact
  (V EUR long→short, V/price BTC short→long). Each offer is capped against the agent's **remaining**
  home inventory as it is decremented within the auction (an agent with ≥2 live same-side orders
  never oversells), so **balances never go negative**.
- The single `c` (= 0.001) drives **both** pressure accrual (`phi += c`, flat) and capital drain
  (`-= c·home`, proportional), exactly as the spec's §6 and §14 state.

## Run

```sh
# Simulate with the Part VIII defaults and write CSV + JSON + a self-contained HTML
# visualisation under throwaway/delta-engine/out/
pnpm exec tsx throwaway/delta-engine/src/run.ts

# Then open the visualisation in a browser (no server needed — data is inlined):
open throwaway/delta-engine/out/index.html   # macOS

# Tests
pnpm exec vitest run throwaway/delta-engine

# Typecheck
pnpm exec tsc -p throwaway/delta-engine/tsconfig.json --noEmit
```

Outputs (`out/series.csv`, `out/series.json`) carry the five §18 series per tick: `p_int`,
`queue_depth` (long/short), `alive_count` (long/short), `total_capital`, `matched_volume`.

`out/index.html` is a **self-contained** visualisation (`viz.ts`): the run data is inlined and all
charts are drawn with vanilla `<canvas>` (no libraries, no network) — open it straight from disk.
It shows the run parameters, a derived-stats grid (distinct prices, range, rises/falls, pool
drained, bankruptcies, total matched volume…), and six interactive (hover) charts: `p_int(t)`,
pool `total_capital(t)`, surviving agents (long/short), queue depth (long/short), matched volume,
and a price histogram. It is **not** part of the ROSE web app — the regime boundary forbids `/prod`
(including the web surfaces) from importing `/throwaway`.
