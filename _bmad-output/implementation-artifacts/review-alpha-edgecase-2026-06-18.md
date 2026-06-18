# Edge-Case Hunt — @throwaway/alpha-engine PoC

**Date:** 2026-06-18
**Method:** Walk every branching path / boundary condition in the change at `/tmp/alpha-engine-review.txt`
(new package `throwaway/alpha-engine/`). Report only **unhandled edge cases** — not style, not general
bugs unless edge-case-driven. Line numbers are for the on-disk source files.

**Scope note:** This is explicitly disposable R&D (floats permitted, NFR-2 binds /prod only), so several
findings below are "only reachable via non-default params." They are still listed because the code accepts
arbitrary `Params` and the boundaries are genuinely unhandled; severity is calibrated to default-run impact.

---

## CRITICAL

_None found._ The auction's zero-supply / zero-demand / empty-queue / one-sided guards and the
non-negativity caps hold on the **shipped default run**.

---

## HIGH

### H1 — Multiple live orders from the same agent oversell its balance → negative balance
**File:** `src/auction.ts:91` (per-order independent inventory cap) feeding `src/auction.ts:97-98`
(`demandEur`/`supplyBtc` reduce) and the fill loops `:108-128`; applied in `src/simulation.ts:91-95`
(`a.eur += fill.eurDelta; a.btc += fill.btcDelta`).

**Boundary input/state:** An agent has **two or more live orders of its own side** in the queue
simultaneously. This happens whenever a side's firing period `d_i/c` is ≤ the window `W` (e.g.
`dBase=1, c=0.5, W=5` → period ≈ 2 ticks, orders live `W+1` ticks → 2-3 concurrent orders per agent).

**What happens now:** Each order's `avail` is computed **independently** as `min(order.size, a.eur)`
(or `a.btc`) — both reference the *same* balance. So `demandEur` double-counts the agent's inventory,
and in the fill loop each of the agent's orders can give up to its own `avail`, with deltas summing to
**more than the agent actually holds**. The caller blindly applies both deltas → **balance goes
negative**, violating the package's central frozen invariant ("balances never go negative",
README + `auction.ts` header). Zero-sum conservation still nets to zero globally, but an individual
agent's `eur`/`btc` can be < 0, which then poisons `K`, bankruptcy, and `total_capital`.

**What should happen:** Cap per *agent* across all of that agent's orders for the tick (track a running
remaining-inventory per agentId), not per order. Or document/forbid the `d_i/c ≤ W` parameter regime.

**Severity:** HIGH (breaks a stated core invariant; silent; **untested** — the forced/partial tests use
`dBase=1e9` or period ≫ W so they never exercise concurrent same-agent orders). Not reachable on the
shipped defaults (`dBase/c = 1000 ≫ W=5`), hence HIGH not CRITICAL.

---

## MEDIUM

### M1 — `x0 = 0` (or negative) → division by zero in balance init; degenerate `p_int(0)`
**File:** `src/init.ts:53` (`btc = (K0 * (1 - f)) / x0`) and `src/init.ts:55` (`btc = (K0 * f) / x0`);
also `src/simulation.ts:65` (`pInt = params.x0`).

**Boundary input/state:** `Params.x0 = 0` (allowed by the interface; spec uses it as both the init
price and `p_int(0)`).

**What happens now:** `btc` becomes `Infinity` (or `NaN` if `K0*(1-f)=0`), then `K = eur + btc*x0 =
NaN`, and the `NaN`/`Infinity` propagates into every downstream computation (auction `crossing`,
`matchedBtc`, capital, bankruptcy comparisons silently false). The auction's `price > 0` guarantee
also relies on a sane `prevPrice`. Negative `x0` produces negative balances/prices.

**What should happen:** Validate `x0 > 0` at the `Params` boundary (or in `makeDefaultParams`/`initAgents`)
and fail fast. Default `x0=1.0` is safe; this is a misconfiguration boundary that fails silently with NaN
rather than loudly.

**Severity:** MEDIUM (misconfig-only, but fails silently and corrupts the entire run).

### M2 — `xMin ≤ 0` or `alpha ≤ 0` in the Pareto init → `NaN` capital cascade
**File:** `src/init.ts:38` (`const scale = K / 2 / sum`) with samples from `src/rng.ts:33-36`.

**Boundary input/state:** `xMin = 0` → every `paretoSample` returns `0` → `sum = 0` → `scale = K/2/0 =
Infinity` → `K0 = 0 * Infinity = NaN`. `alpha = 0` → `pow(u, -1/0) = pow(u, -Infinity) = Infinity` →
`sum = Infinity` → `scale = 0` → `K0 = Infinity*0 = NaN`. `alpha < 0` inverts the tail (large→small).

**What happens now:** Whole population initialised to `NaN`; `d_i`, balances, every series value become
`NaN`; no error is raised.

**What should happen:** Validate `xMin > 0` and `alpha > 0`. Defaults (`xMin=K/(n*10)=2000`, `alpha=1.5`)
are safe; this is the unguarded misconfig boundary.

**Severity:** MEDIUM (misconfig-only, silent NaN).

### M3 — Firing with zero / near-zero home balance silently discards accumulated pressure
**File:** `src/simulation.ts:83-96` — guard `phi < d` (`:83`), `size = Math.min(rawSize, home)` (`:87`),
`if (size > FIRE_EPSILON)` (`:88`), and unconditional `a.phi = 0` (`:96`).

**Boundary input/state:** A live agent reaches `phi ≥ d` but its **home leg is 0 / below `FIRE_EPSILON`**.
This is a reachable steady state: a LONG only ever *loses* EUR (carry drain + trades; it receives BTC,
never EUR), so once `eur → ~0` it stays there, yet `K = btc·p_int` can keep it alive (and `p_int`
ratchets up, so it can be immortal). With `f=0`, longs start with `eur=0` from tick 1.

**What happens now:** No order is queued (`size ≤ FIRE_EPSILON`), but `a.phi` is still reset to 0
(`:96`). The agent perpetually accrues and **discards** pressure, firing nothing forever — a live agent
that can never participate yet keeps "resetting." No bankruptcy (its away-leg keeps `K > ε`).

**What should happen:** Decide intent: either *don't* reset `phi` when no order is placed (so pressure is
retained), or document that a no-inventory fire is a deliberate forfeit. Currently it is neither stated
nor tested.

**Severity:** MEDIUM (reachable in normal dynamics for spent-out longs and for any `f=0` run; affects the
emergent behaviour the PoC exists to measure, though it does not crash).

---

## LOW

### L1 — Window expiry keeps orders for `W+1` ticks (off-by-one vs "older than W ticks")
**File:** `src/auction.ts:60` — `o.tickPlaced >= t - W`.
**Boundary:** An order placed at `t0` is retained while `t - t0 ≤ W`, i.e. it survives the placing tick
**plus** `W` further ticks (`W+1` total). An order "exactly `W` ticks old" is **kept**, dropped only at
`W+1`. Internally consistent with the package's own comments, but if §10's "expire after W ticks" means a
strict `W`-tick lifetime this is off by one. Worth confirming against the PDF.
**Severity:** LOW (spec-conformance ambiguity, no crash).

### L2 — Bankruptcy boundary uses `<=` (`K == epsilon` ⇒ dead)
**File:** `src/simulation.ts:120` — `if (a.K <= epsilon)`.
**Boundary:** Capital exactly equal to `epsilon` is treated as bankrupt. Matches the README ("falls to
**`<=` epsilon**"), so internally consistent — flagged only so the `<=` vs `<` choice is a conscious one
and traces to the PDF §15.
**Severity:** LOW.

### L3 — Stale residual `order.size` not re-capped to current inventory; inflates `queue_depth`
**File:** `src/auction.ts:108-128` mutate `order.size -= give`; `purgeConsumed` (`src/auction.ts:62-69`)
only drops `size ≤ FILL_EPSILON`.
**Boundary:** A long order of `size=100` fills only 40 (capped at drained `eur=40`); residual `order.size`
stays at 60 though the agent now holds ~0 EUR. The order is **not** purged (60 > ε) and lingers until
window expiry. Harmless to balances (each tick re-caps `avail = min(size, balance) ≈ 0`), but it is
counted as a live order in `queueDepthLong/Short` (`src/simulation.ts` record step) — a cosmetic
inaccuracy in a §18 output series.
**Severity:** LOW (metric only).

### L4 — One-sided wipeout does not terminate; survivors can be immortal → full `T` frozen run
**File:** `src/simulation.ts:160` — termination only on `aliveLong + aliveShort === 0`.
**Boundary:** All agents on one side die first. The auction then always hits the "no crossing" guard
(`auction.ts:101`), so `p_int` freezes and no trades occur. Survivors' home leg drains only multiplicatively
(never to 0) and their away leg is untouched by carry, so `K` floors at `K0·(1-f)` (e.g. `0.1·K0 = 200 >
ε=20` on defaults) → they **never** die. The sim runs all `T=10000` ticks in a frozen, no-trade state and
reports `reason='max-ticks'`. Possibly intended, but there is no early-stop for a dead market.
**Severity:** LOW (no crash; wasted compute / possibly-unintended semantics).

### L5 — `n = 0` produces an empty population reported as `'all-dead'`
**File:** `src/init.ts:38` (`scale = K/2/sum` with `sum=0` → `Infinity`, but `map` over empty raws is `[]`),
then `src/simulation.ts:160`.
**Boundary:** `n=0` → no agents; tick 1 records an all-zero row and the termination check fires →
`reason='all-dead'` despite nothing ever having been alive. Degenerate, misleading reason.
**Severity:** LOW (misconfig).

### L6 — `q = 0` silently flips the firing regime to all-in instead of erroring
**File:** `src/simulation.ts:86-87` — `rawSize = a.K >= baselineK0 ? home / q : home` then
`size = Math.min(rawSize, home)`.
**Boundary:** `q=0` → `home/0 = Infinity` → `min(Infinity, home) = home` → every fire is all-in. No
division-by-zero crash (the `min` cap absorbs it), but the order-size law is silently nullified.
**Severity:** LOW (misconfig; absorbed, not crashed).

### L7 — `p_int(0) = x0` is never emitted in the series
**File:** `src/simulation.ts:65` sets `pInt = x0`; the loop records from `t=1` only.
**Boundary:** First recorded `p_int` is at `t=1` (post first auction). The initial `p_int(0)=x0` boundary
value is absent from the §18 output. If §18 wants the `t=0` baseline row, it is missing.
**Severity:** LOW (output-completeness).

---

## Boundaries checked and found SOUND (no action)

- **Empty queue / single order / one-sided queue / all orders expire same tick:** `auction.ts:101` guard
  (`longs.length===0 || shorts.length===0 || demandEur<=0 || supplyBtc<=0`) returns `prevPrice`, no fills,
  queue carries forward. Covered by tests.
- **Zero total supply / zero total demand:** same guard; the `<=0` clauses also catch float-tiny sums
  (each `avail` must exceed `FILL_EPSILON` to enter `longs/shorts`).
- **Division by zero in the auction:** `crossing = demandEur/supplyBtc` (`auction.ts:106`) — `supplyBtc>0`
  guaranteed by the guard; `matchedBtc = matchedVolumeEur/price` (`:110`) — `price = max(prevPrice,
  crossing) ≥ crossing > 0` (given a sane `prevPrice` — see M1's `x0=0` caveat). No div-by-zero on the
  default run.
- **Supply == demand / partial fill of marginal order / single huge vs many tiny:** largest-first sweep
  distributes exactly `V` EUR and `V/price` BTC; the marginal order partially fills and its residual stays
  queued; aggregate EUR and BTC each net to 0 by construction.
- **Balance driven to 0 or below by carry:** carry is **multiplicative** (`eur -= c·eur`,
  `simulation.ts:111-112`) → asymptotic to 0, never negative, never exactly 0. Trades cap at inventory
  (`auction.ts:91`). So a *single* order per agent never drives a balance negative (the H1 exception is
  *multiple* orders).
- **`u = 0` from the PRNG in the Pareto sampler:** guarded at `rng.ts:35` (`u <= 0 ? Number.EPSILON : u`).
  `u = 1` cannot occur (`mulberry32` returns `[0,1)`); `pow(1,·)=1` would be harmless anyway.
- **All agents dead mid-run:** termination at `simulation.ts:160`; queued orders of the dead are purged
  (`simulation.ts` bankruptcy filter + `purgeConsumed`). Covered by the forced-mortality test.
- **Float drift over 10000 ticks in `total_capital`:** recomputed fresh each tick from balances
  (`a.eur + a.btc·pInt`), not accumulated, so the metric carries no compounding error.
- **`d_i ∝ K0` scaling at the `K0_min` agent:** `d = dBase·(K0/min)` (`init.ts`), `min` is the fixed
  initial population minimum; smallest agent gets `d = dBase`. Sound.
