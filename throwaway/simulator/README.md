# @throwaway/simulator (FR-16)

**THROWAWAY** — threshold-only rebalancing simulator over historical ticks. Deletable with **no**
impact on `/prod`. May import `/prod` and `@throwaway/coupled-math`; `/prod` must **never** import
this. Not a pnpm-workspace member and not part of the `/prod` build graph (regime defense).

## What it does (Story 7.2)

Replays historical ticks in CSV `timestamp,price` form against a coupled pair and fires a **reset
only when a losing leg breaches the floor `f = m·L·g`** — i.e. on a **price event (intrinsic
time)**, **never on a clock/interval**. Clock-based rebalancing of a leveraged position would
import leveraged-ETF volatility decay (the "intrinsic time" trap), which this design avoids.

At each reset it records: the **locked** current integer leg values, the **re-anchored** P₀ (the
breaching price), and the **locked loss** of the losing holder (`K/2 − locked losing-leg value`).
The cycle then re-bases to a fresh symmetric `K/2 : K/2` split at the new anchor (D1a: crystallised
& withdrawable, no carried P&L).

## API

- `parseTicks(csv) → Tick[]`, `loadTicksFromFile(path) → Tick[]` — CSV ingestion (header / blank /
  `#`-comment tolerant; prices stay decimal strings, never JS `number`).
- `simulate(ticks, config) → SimResult` — the threshold-only replay. `config = { initialAnchorPrice,
  leverage, collateralPool /* K */, floorParams }`. The reset decision reads **price only** —
  `tick.timestamp` never drives it.
- `ResetEvent` — `{ tickIndex, timestamp, price, anchorBefore, losingLeg, lockedLong, lockedShort,
  lockedLoss, newAnchorPrice, gapPastFloor, leveragedDeviationApprox }`.

The model itself (deviation, leg split, floor, breach detection) is **not** re-implemented here — it
is consumed from the Story 7.1 library `@throwaway/coupled-math` (`evaluate`, `loadFloorParams`,
the exact `Rational` core). Floor params `m`/`g` are **refuse-if-absent** (never defaulted).

## Fixtures

- `fixtures/eurusd.csv` — EUR/USD ticks; under a plausible floor at L=1 they fire **zero** resets.
- `fixtures/btc.csv` — BTC ticks with a bear-market drawdown that crosses the **same** floor at L=1,
  firing at least one reset (higher-vol stress of the same invariant).

## Scaling-law floor corroboration ("Lever 2")

`scaling-law.ts` is an **independent second opinion** on the pre-registered worst-plausible-gap
`g = 0.30` (`floor-method.ts`, SM-C1). It derives a data-driven `g` from a tick series' **own**
directional-change / overshoot structure (intrinsic time + the empirical scaling laws of
Glattfelder/Houweling/Olsen, *A Modern Paradigm for Algorithmic Trading*, 2025) and **compares** it
to the pre-registered value. It **never** back-fits and **never** changes the committed floor.

**Method.**

1. **Intrinsic-time DC decomposition** — `decomposeDirectionalChanges(prices, δ)` registers a
   directional change when price reverses by ≥ δ from the last local extreme; the continuation to the
   next extreme is the **overshoot**. It returns `N_dc(δ)` and `⟨ω(δ)⟩`. Pure, deterministic, with
   **exact-Rational** comparisons (no binary float on the price path).
2. **Scaling-law fit** — `fitPowerLaw(samples)` fits `f(δ) = C·δ^α` by log-log least squares over a
   geometric threshold grid self-calibrated to the series (`thresholdGrid`: `R_max/16 … R_max/2`,
   where `R_max` is the worst single-tick move). Returns `C`, `α`, `R²`.
3. **Derive `g`** — `deriveGapFromScaling(overshootFit, δ*)` protects against a **flash reversal**
   whose confirmation threshold equals the asset's own worst single-tick move `δ* = R_max`, continued
   by the overshoot the fitted law predicts there: `g_scaling = δ* + C·(δ*)^α`.
4. **Corroboration report** — `buildScalingLawReport(asset, ticks)` → `{ thresholds, decompositions,
   nDcFit, overshootFit, stressThreshold δ*, gScaling, gPreRegistered, verdict, rationale }`, with
   `scalingLawReportToJson` / `scalingLawSummaryLine` serializers. Verdict is **CORROBORATES** when
   the pre-registered `g ≥ g_scaling` (the committed floor conservatively covers the derived gap),
   else **DIVERGES** (flag for review — the committed floor is left untouched).

**Falsifiability stance (the whole point).** The derivation reads **only the price series**. It never
calls `simulate`, never reads the reset rate, and only **reads** `PRE_REGISTERED_FLOOR.g` for the
side-by-side comparison — never mutates it. So `g_scaling` is identical no matter how many resets
ever fire (proven by a guard test). The pre-registered `g = 0.30` remains the committed floor; this
lever **strengthens** SM-C1's "stated, defensible method", it does not replace it.

**How to read it (current fixtures).**

- **EUR/USD** — calm: `δ* ≈ 0.0101`, overshoot fit `C ≈ 0.017, α ≈ 0.38, R² ≈ 0.86`,
  `g_scaling ≈ 0.013`. `0.30 ≥ 0.013` ⇒ **CORROBORATES** — the floor is conservative.
- **BTC/USD** — stress: `δ* ≈ 0.4286`, overshoot fit `C ≈ 0.77, α ≈ 0.54, R² ≈ 0.93`,
  `g_scaling ≈ 0.915`. `0.915 > 0.30` ⇒ **DIVERGES** — the asset's own structure implies gaps beyond
  the committed floor, correctly flagging the high-volatility stress asset for review.

The qualitative ordering `g_scaling(EUR/USD) ≪ g_scaling(BTC)` falls straight out of each series'
intrinsic-time structure — independent corroboration that the pre-registered floor is calm-asset
conservative while exposing the stress asset, exactly as SM-C1 intends.

## Out of scope (Story 7.3)

Formal no-negative-leg proof + gap/issuer-neutrality-break reporting, **journal-every-reset** as the
audit artifact, the full pair lifecycle traversal (`PENDING → … → CLOSED`), and the stated,
defensible method for choosing `m`/`g` before observing the reset rate (SM-C1 falsifiability).

## Run

```
pnpm exec vitest run throwaway/simulator
pnpm exec tsc -p throwaway/simulator/tsconfig.json --noEmit
```
