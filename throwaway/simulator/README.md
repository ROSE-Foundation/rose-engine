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

## Out of scope (Story 7.3)

Formal no-negative-leg proof + gap/issuer-neutrality-break reporting, **journal-every-reset** as the
audit artifact, the full pair lifecycle traversal (`PENDING → … → CLOSED`), and the stated,
defensible method for choosing `m`/`g` before observing the reset rate (SM-C1 falsifiability).

## Run

```
pnpm exec vitest run throwaway/simulator
pnpm exec tsc -p throwaway/simulator/tsconfig.json --noEmit
```
