---
title: 'Exchange trading terminal (3-column) — coupled-package model'
type: 'feature'
created: '2026-06-18'
status: 'done'
baseline_commit: '26b11d6'
context:
  - '{project-root}/docs/mocks/exchange.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Exchange surface is two stacked tables; the mock `exchange.html` is a 3-column trading terminal (market list | chart + pair strip | order ticket) with an open-positions table. The mock's interaction model — buying a NAKED long or short leg with leverage and a per-position P&L — conflicts with ROSE's core invariant (L and S are minted/burned ONLY as an atomic pair; single-leg is impossible on-chain — Epic 4, stories 4-3/4-4) and would also need a per-user position model + a live price oracle that do not exist.

**Approach:** Build the 3-column terminal UI faithfully, but HONESTLY ADAPTED to ROSE's real coupled-package model: market list from the live `coupledCoinBook`, a pair strip with the two real leg tokens, an order ticket that drives the REAL subscribe/redeem coupled-PACKAGE flow (atomic L+S), and an open-positions table from real coupled pairs with mark-to-market computed from real params. Price-feed-dependent elements (price chart, live mark, 24h hi/lo/OI) render explicit "requires a price feed" empty-states — never fabricated data. The naked-leg secondary-trading + per-user position model + price oracle + contract changes are deferred to a Correct Course re-plan (see companion doc), NOT implemented here.

## Boundaries & Constraints

**Always:** Web only. Reuse live `useGroupView` data incl. `coupledCoinBook` (spec #3) + `coupledPairs`, and the existing real derivations (`deriveExecution`, per-entity P&L). Leg token symbols are DERIVED deterministically (`r` + `referenceAsset` without `/` + `-L`/`-S`) — real, not invented. Mark-to-market uses `pair-math` (`legsAtPrice`/`deriveFloorUnits`/`distanceToFloor`) on REAL pair params. "Max loss" = the floor-derived real relationship. The order ticket reuses the existing subscribe/redeem flow (or routes to the Subscriber surface) — it acquires the atomic coupled package, framed truthfully. Spec-#1 tokens + directional `long`/`short`/`gold`; money via `MoneyCell`; leg units as "units" (coupled_pairs has no scale). Preserve the existing live execution/P&L-by-entity data.

**Ask First:** (none — autonomous; the contract-level conflict is handled by deferring to Correct Course, not by changing contracts)

**Never:** Do NOT implement naked single-leg trading or anything that violates the atomic-coupling invariant. Do NOT touch smart contracts or the ledger schema. Do NOT fabricate price/chart/24h/мark data — use explicit empty-states. Do NOT delete the existing real execution/positions data.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Terminal mount | live group view | 3-column layout; market list from `coupledCoinBook`; first market selected | loading/error/empty in container |
| Select a market | click a market | center + ticket + positions scope to that `referenceAsset` | N/A |
| Price chart | no price feed | explicit "Live price chart — price feed not connected" empty-state (NOT fabricated) | N/A |
| Pair strip | a market | two leg tokens (derived `r…-L`/`-S` symbols) + real leg notionals from the book | N/A |
| Order ticket | a market | real package terms (leverage, collateral, floor-derived max loss); CTA → real subscribe/redeem flow | surfaces typed refusal |
| Open positions | real coupled pairs | per-pair: entry (anchor), leg values, collateral, distance-to-floor, floor-derived max loss; live "mark"/P&L column shows "— (price feed)" | N/A |
| No markets/pairs | empty ledger | terminal shows empty-states, no crash | N/A |

</frozen-after-approval>

## Code Map

- `prod/packages/web/src/surfaces/exchange-trading/exchange-trading.tsx` -- rebuild into the 3-column terminal; KEEP `deriveExecution` + per-entity P&L data
- `prod/packages/web/src/surfaces/exchange-trading/*` -- NEW sub-components: `market-list.tsx`, `pair-strip.tsx`, `order-ticket.tsx`, `positions-table.tsx`, `chart-placeholder.tsx` (honest empty-state)
- `prod/packages/web/src/lib/leg-symbols.ts` (+ test) -- deterministic `legTokenSymbols(referenceAsset)` → `{ long, short }`
- `prod/packages/web/src/surfaces/exchange-trading/exchange-trading.test.tsx` -- market select, derived symbols, empty-states (no fabricated chart/mark), positions math, package-terms ticket
- (reuse) subscribe/redeem flow from the Subscriber surface / its service for the ticket CTA

## Tasks & Acceptance

**Execution:**
- [x] `leg-symbols.ts` (+ test) -- deterministic `legTokenSymbols(referenceAsset)` (strip non-alphanumerics + uppercase) → `{long,short}`
- [x] `market-list.tsx` -- left column from `coupledCoinBook`; selectable buttons with `aria-pressed` active state (review fix)
- [x] `pair-strip.tsx` + `chart-placeholder.tsx` -- pair strip (derived leg tokens + real notionals) + explicit price-feed empty-states (chart, live price, 24h hi/lo, OI); real TVL (collateral) + pair count
- [x] `order-ticket.tsx` -- real package terms (leverage, collateral, floor-derived max loss) + an actionable CTA → Subscriber surface via `onNavigate` (review fix; navigates, never writes); truthful coupled-package framing
- [x] `positions-table.tsx` -- real coupled pairs + per-entity execution; entry=anchor, size/collateral (K), distance-to-floor, floor-derived max loss; live mark/P&L = explicit "— (price feed)" empty-state
- [x] `exchange-trading.tsx` (+ `app.tsx`) -- composes the 3-column terminal; preserves real execution/P&L-by-entity; threads `onNavigate`; container keeps loading/error/empty
- [x] tests -- market-select scoping, derived symbols, price-feed empty-states asserted (no fabrication), positions math, package-terms ticket, CTA navigate, real execution preserved

**Acceptance Criteria:**
- Given live data, when the terminal mounts, then a 3-column layout renders with a market list from `coupledCoinBook`, a pair strip with derived leg-token symbols, an order ticket of real package terms, and an open-positions table of real pairs.
- Given no price feed, when the chart / live-mark / 24h-stats would render, then each shows an explicit "requires a price feed" empty-state (no fabricated numbers).
- Given a market selection, when chosen, then center + ticket + positions scope to it.
- Given the existing real execution/P&L-by-entity data, when the terminal renders, then it is preserved (not lost in the rebuild).
- Given `pnpm --filter @rose/web build`, `pnpm vitest run prod/packages/web`, `pnpm lint`, when run, then all pass.

## Design Notes

The honest adaptation: ROSE's "exchange" trades atomic coupled-coin PACKAGES (the real subscribe/redeem flow), not naked perp legs. The terminal presents real markets/pairs/positions and the real package economics; everything requiring a price oracle is an explicit empty-state. The genuinely-new capability the mock implies — naked single-leg secondary trading, a per-user position ledger with live-mark P&L, a price oracle, and the contract changes to allow single-leg positions (which conflict with the atomic-coupling safety invariant) — is a PRD/architecture-level change captured in the companion Correct Course recommendation (`correct-course-exchange-trading.md`), to be planned and human-signed-off, NOT auto-implemented against deployed/audited contracts.

## Verification

**Commands:**
- `pnpm --filter @rose/web build` -- expected: succeeds
- `pnpm vitest run prod/packages/web` -- expected: all pass incl. new terminal + leg-symbol tests
- `pnpm lint` -- expected: clean

## Spec Change Log

- **2026-06-18 — review pass (2 Opus reviewers: acceptance/no-fabrication + correctness/edge/a11y).** Both CRITICAL gates PASS: NO fabricated price/chart/mark data (all price-oracle elements are explicit empty-states), NO contract/schema change (web-only), no naked-leg write; real per-entity execution/P&L preserved; market-selection state robust (stale-on-refetch + empty-book guarded). Patches applied (no loopback):
  - **Order-ticket CTA wired** to the Subscriber surface via `onNavigate` (was static text) — navigates, never writes; resolves the ticket-a11y note.
  - **Market-list a11y** — removed the invalid `listbox`/`option` composite; buttons carry `aria-pressed` so the active market is announced.
  - **Decorative glyphs** (◤/◢/◈) `aria-hidden`.
  - **Leg symbols** uppercase-normalized for robustness.
  - **Positions columns** — collapsed the duplicate Size/Collateral (both K in this model) into one labelled column.
- **Scope handled by Correct Course (NOT implemented):** naked single-leg secondary trading, a per-user position ledger, a price oracle, and the contract changes they require (which conflict with the atomic-coupling safety invariant) — see `correct-course-exchange-trading.md`.

## Suggested Review Order

- Entry point — terminal composition (3 columns), market-selection state, preserved real execution, `onNavigate` threading.
  [`exchange-trading.tsx`](../../prod/packages/web/src/surfaces/exchange-trading/exchange-trading.tsx)
- Market list from the live `coupledCoinBook` (a11y-correct selectable buttons).
  [`market-list.tsx`](../../prod/packages/web/src/surfaces/exchange-trading/market-list.tsx)
- Order ticket — real package terms + the Subscriber-routing CTA (no write).
  [`order-ticket.tsx`](../../prod/packages/web/src/surfaces/exchange-trading/order-ticket.tsx)
- Positions table — real pairs, mark-to-market on real params, price-feed empty-states.
  [`positions-table.tsx`](../../prod/packages/web/src/surfaces/exchange-trading/positions-table.tsx)
- Honest price-feed empty-state (no fabricated chart).
  [`chart-placeholder.tsx`](../../prod/packages/web/src/surfaces/exchange-trading/chart-placeholder.tsx)
- Deterministic real leg-token symbols.
  [`leg-symbols.ts`](../../prod/packages/web/src/lib/leg-symbols.ts)
- **The deferred architectural change (read this):** naked-leg trading + position model + oracle + contracts.
  [`correct-course-exchange-trading.md`](./correct-course-exchange-trading.md)
