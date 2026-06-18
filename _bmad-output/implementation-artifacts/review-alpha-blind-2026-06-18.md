# Blind Hunter review — @throwaway/alpha-engine PoC (2026-06-18)

Adversarial, spec-blind review of the single self-contained diff `/tmp/alpha-engine-review.txt`
(new package `throwaway/alpha-engine/`). Only the code itself was read. Findings are about
correctness, conservation (zero-sum), negative balances, NaN/Inf, aliasing, PRNG, partial-fill
accounting, and test strength.

---

## Verdict

The core machinery (Pareto init, threshold scaling, EMA-free Dutch auction, carry drain, bankruptcy
loop) is internally consistent and aggregate zero-sum holds **for the case of at most one queued
order per agent** — which is the only case the shipped default params and all tests ever reach. There
is one genuine, latent conservation/negative-balance bug in the auction that triggers when an agent
holds more than one order on the same side simultaneously, plus a couple of low-severity test/spec
nits. No bug is reachable with `DEFAULT_PARAMS` (firing period `d/c ≈ 1000` ≫ `W = 5`), so the bug is
latent rather than active, but it lives in the public `runAuction` surface and violates the function's
own stated invariant.

---

## HIGH

### H1 — Per-order inventory cap double-counts an agent with multiple queued orders → negative balance + currency creation
**File:** `src/auction.ts`, `runAuction` — availability build at lines 333-340, and the fill loops at
lines 367-373 (longs) / 377-383 (shorts).

The offer cap is computed independently per order against the agent's *full* balance:
```ts
const avail = order.side === 'LONG' ? Math.min(order.size, a.eur) : Math.min(order.size, a.btc);
```
If a single agent has two (or more) orders on its side in the rolling-`W` queue at the same tick,
each order is capped at the *same* full balance. Consequences:

1. `demandEur = longs.reduce((s,o)=>s+o.avail,0)` (line 342) — equivalently `supplyBtc` (343) —
   **over-counts** that agent's inventory (counts it once per order).
2. The fill loop debits each of the agent's orders up to its own `avail`, e.g. an agent with
   `eur = 40` and two orders of size 30 yields `avail = 30` twice; with `V ≥ 60` the loop pushes
   `eurDelta = -30` twice → the caller applies `a.eur += -60` (simulation.ts line 980) → **`eur = -20`**.
   That is a negative balance **and** 20 EUR transferred to the counterparties that never existed —
   a direct break of the zero-sum/conservation invariant.
3. Because `crossing = demandEur / supplyBtc` (line 351) feeds the clearing price, the *emergent
   price itself* is also skewed whenever any agent is double-counted.

This directly contradicts the function's own documented guarantee (lines 266-267 / 70):
"Orders are capped at the agent's CURRENT home-currency inventory at fill time, so a balance can
never go negative." The cap is per-order, not per-agent, so the guarantee is false for multi-order
agents.

**Why it's only latent (not active in the shipped run):** an agent fires at most once per
`period = d_i / c` ticks (phi resets to 0 on firing, simulation.ts line 968), and orders expire after
`W` ticks (`expireOrders`, line 304-306). With `DEFAULT_PARAMS` the smallest agent's period is
`dBase/c = 1/0.001 = 1000` ≫ `W = 5`; the `partial`/`forced` test params give periods of `200`/`∞`,
also ≫ `W`. So no agent ever holds two live orders at once, and conservation holds in every shipped
path and test. But `runAuction` is exported and accepts an arbitrary queue, and any param set with
`d_i / c ≤ W` (small `dBase`, small `c`, or large `W`) makes it active. Fix: aggregate available
inventory per agent (decrement a running per-agent budget as orders consume it) rather than capping
each order against the full balance.

---

## LOW

### L1 — Weak/one-sided test assertion lets a wrong-signed fill pass
**File:** `src/auction.test.ts`, "caps an offer at the agent's current home inventory", line 214.
```ts
expect(res.fills.find((f) => f.agentId === 0)?.eurDelta).toBeGreaterThanOrEqual(-40);
```
This only bounds the *magnitude* of the long's payment from below. It would still pass if `eurDelta`
were `0` or **positive** (a long *receiving* EUR — economically backwards) or if the fill were missing
entirely (`undefined ?. ` → `undefined`, and `undefined >= -40` ... actually evaluates against
`undefined`, which Jest/Vitest treats as a failing compare — but a `0`/positive value would silently
pass). The real check (`matchedVolumeEur ≈ 40`, line 213) is fine; the per-fill assertion should also
pin the sign, e.g. assert `eurDelta` is in `[-40, 0)` and `btcDelta > 0`.

### L2 — Rolling-window expiry keeps W+1 ticks, not W
**File:** `src/auction.ts`, `expireOrders`, lines 304-306: `o.tickPlaced >= t - W`.
At tick `t` this retains orders with age `0..W` inclusive — i.e. `W + 1` distinct placement ticks —
whereas "older than W ticks expire" most naturally means a `W`-tick window. The code matches its own
inline comment ("keeps `tickPlaced ≥ t - W`"), so this is a defensible boundary choice rather than a
defect, but it is a classic off-by-one to confirm against the PDF's §10 definition of `W`.

---

## Notes / non-issues checked and cleared

- **Aggregate zero-sum (single order per agent):** longs give `Σgive = V` EUR and receive `V/price`
  BTC; shorts give `matchedBtc = V/price` BTC and receive `matchedBtc·price = V` EUR. EUR and BTC both
  net to zero across fills (auction.test.ts confirms). Correct.
- **`matchedBtc ≤ supplyBtc` and `V ≤ demandEur`:** both follow from `V = min(demandEur, supplyBtc·price)`
  and `price ≥ crossing = demandEur/supplyBtc`, so both fill loops can always drain `rem` to ~0 and the
  marginal order partially fills with its residual left queued. Partial-fill accounting is correct.
- **Single-order negative balance:** `give ≤ avail ≤ balance`, so a lone order can never drive a balance
  negative. Only the multi-order case (H1) breaks this.
- **Division by zero / NaN:** `price = max(prevPrice, crossing)` with `prevPrice = x0 = 1.0` ratcheting
  up ⇒ `price > 0`, so `matchedVolumeEur / price` is safe. `paretoSample` guards `u ≤ 0` against `Infinity`
  (rng.ts line 682). The no-crossing guard (auction.ts line 346) covers empty sides / zero supply/demand.
- **Pareto inverse-CDF:** `xMin / u^(1/alpha)` is the correct inverse of `F(x)=1-(xMin/x)^alpha`; result `≥ xMin`.
- **mulberry32:** standard, deterministic; same seed ⇒ identical stream. Determinism test is meaningful.
- **Aliasing:** `agents` array and `agentsById` map share the same `Agent` references intentionally;
  mutations stay consistent. Fills are computed read-only then applied, with no interleaving mutation.
- **`total_capital` monotonicity on flat ticks:** trades are K-neutral at the clearing price (K is
  recomputed at the same `pInt`), so the only flow on a flat tick is the carry drain (`home *= (1-c)`,
  never negative) → strictly non-increasing. Price ratchet (`pInt` non-decreasing) is enforced by
  `max(prevPrice, crossing)`. Both simulation.test.ts invariants are sound (not tautological).
- **`FIRE_EPSILON` declared after use (simulation.ts line 1047 vs use at 965):** no TDZ problem because
  `runSimulation` is only invoked after module evaluation completes.
- **Dead code:** `capital()` and `homeBalance()` (agent.ts) are exported but unused internally
  (the loop inlines both). Not a correctness bug; style only.
