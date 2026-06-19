---
baseline_commit: 8beba739bd3b32f1dcedb36912718ad136904a58
---

# Story 8.1: Substitutable price-oracle port + mark-to-market service

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a build engineer,
I want a substitutable `PriceOracle` port with a CSV/replay (and testnet) adapter and a mark-to-market service that prices a pair from its real parameters,
So that the position layer can compute entry/mark/unrealized P&L from live prices without ever fabricating a mark or coupling callers to a feed (FR-24, NFR-8).

## Acceptance Criteria

**Given** the `price-oracle` package
**When** an adapter is wired
**Then** a substitutable `PriceOracle` port supplies the reference-asset price, the P0 adapter is **CSV/replay or a testnet feed** (no live OANDA/LMAX), and swapping the adapter changes no caller (NFR-8)
**And** the oracle is **read-only market data** — it has no path that writes postings

**Given** a connected feed and an issued coupled pair
**When** the mark-to-market service runs
**Then** it computes entry (anchor P₀), current mark, and unrealized P&L from the **real pair parameters** (`legsAtPrice` / floor / distance-to-floor) — not from invented numbers
**And** each mark carries **provenance and a freshness/staleness bound**

**Given** the freshness bound is exceeded, or the feed is absent, or the oracle figure diverges implausibly from the pair's own anchor/params
**When** a mark is requested
**Then** a price older than the bound yields an explicit **stale-mark** state (never a silently-stale P&L), an absent feed yields an explicit **"no price feed"** state, and an implausibly divergent figure is **flagged, not trusted** (§15 oracle integrity) — a mark is **never fabricated**

### Scope boundary (P0, this story only)

- **IN:** a new PROD package `prod/packages/price-oracle` with (a) a substitutable **`PriceOracle` port** (read-only market-data interface, NFR-8), (b) a **P0 CSV/replay adapter** (`timestamp,price`, no live OANDA/LMAX), (c) an exact-rational helper (NFR-2; `/prod` cannot import the `/throwaway` copy), and (d) a **mark-to-market service** that prices a coupled pair from its real parameters (`anchorPrice`, `leverage`, `collateralPool`, `floor`, `longLegValue`, `shortLegValue`) producing entry/mark/unrealized-P&L + floor + distance-to-floor, each mark carrying **provenance + freshness bound** and an explicit status (`OK | STALE | NO_FEED | DIVERGENT`). Wire the package into the root `tsconfig.json` references + `pnpm install`.
- **OUT (later stories, do NOT pull forward):** the `positions` table / per-user position entity (8.2), `openPosition`/`closePosition` over subscribe/redeem (8.3), the API endpoints + Exchange-terminal wiring (8.4), position↔pair reconciliation (8.5), the single-side-close solvency guardrail (8.6). No user/owner/side ownership is modelled here — the mark-to-market service prices the **pair** (both legs) from public params; mapping a leg to a user is 8.2+.
- **OUT:** any change to `@rose/ledger` / `coupled_pairs` schema, to on-chain coupling, or to `postTransfer`. The oracle never writes postings (read-only).

## Tasks / Subtasks

- [x] Task 1 — Scaffold the `@rose/price-oracle` PROD package (AC: #1)
  - [x] Add `prod/packages/price-oracle/{package.json,tsconfig.json,src/index.ts}` mirroring the `@rose/reconcile` scaffold (ESM, composite, `rootDir: src`/`outDir: dist`). Dependency: `@rose/shared` only (`workspace:*`) — the mark-to-market service takes a **structural** pair-params input, not a hard `@rose/ledger` dependency (keeps the read-only compute service decoupled and substitutable, NFR-8).
  - [x] Register the package in root `tsconfig.json` `references` (after `reconcile`); add a `references` entry to `../shared` in the package tsconfig. Run `pnpm install`.
- [x] Task 2 — Exact-rational helper (NFR-2) (AC: #2)
  - [x] Add `src/rational.ts`: a `/prod` exact rational-over-`bigint` (`parseDecimal`, `mul`, `sub`, `abs`, `cmp`, `lte`, `gte`, `toApproxString`). `/prod` cannot import the `/throwaway` `coupled-math` copy (regime boundary); this is a clean, self-contained reimplementation with the same NFR-2 guarantee (decimal strings in, exact fractions internally, never JS `number`).
- [x] Task 3 — The substitutable `PriceOracle` port + P0 CSV/replay adapter (AC: #1)
  - [x] `src/price-oracle.ts`: `PriceQuote` (`referenceAsset`, `price` decimal string, `asOf: Date`, `source`, optional `sequence`) and the `PriceOracle` port — **read-only**: `source` + `getPrice(referenceAsset): Promise<PriceQuote | null>` (no write/post method anywhere; a `null` return is an explicit absence, never a fabricated price).
  - [x] `src/adapters/csv-replay-adapter.ts`: `CsvReplayPriceOracle` parsing `timestamp,price` CSV (header/comment/blank tolerant, matching the throwaway tick format) keyed per reference asset; replays against a clock cursor (`asOf(now)` returns the latest tick at/before `now`); unknown asset / empty feed ⇒ `null` (no-feed). Strictly-positive decimal prices only (NFR-2).
- [x] Task 4 — The mark-to-market service (AC: #2, #3)
  - [x] `src/mark-to-market.ts`: a `MarkablePair` structural input (the real pair params), `MarkOptions` (`freshnessBoundMs`, `maxRelativeDivergence` decimal string, optional `now`), `MarkStatus = 'OK'|'STALE'|'NO_FEED'|'DIVERGENT'`, and `markToMarket(pair, quote, options): Mark`.
  - [x] OK path: `legsAtPrice` = exact integer leg split V_A(P)/V_B(P) (reuse `@rose/shared` `allocate`, summing to K exactly), `entryLegs` = symmetric split at P₀ (`splitInTwo(K)`), `unrealizedPnl` = legsAtPrice − entryLegs per leg (bigint smallest-units, sum to 0 — delta-neutral), `floor` (decimal), `distanceToFloor` = buffer(1−|L·r|) − f. `entryPrice`/`markPrice`/`floor`/`distanceToFloor` are decimal strings; leg/PnL fields are `bigint`. Each mark carries `provenance` (`source`, `asOf`, `sequence`) + `freshnessBoundMs` + `ageMs`.
  - [x] Refusal/guard paths (never fabricate): `quote === null` ⇒ `NO_FEED` (trusted fields null); `ageMs > freshnessBoundMs` ⇒ `STALE` (price surfaced for transparency, trusted P&L null); `|r| > maxRelativeDivergence` **or** `|L·r| > 1` (a leg would be negative) ⇒ `DIVERGENT` (figure flagged, not trusted). `freshnessBoundMs`/`maxRelativeDivergence` are **required** trust inputs (fail-closed — never silently defaulted, §15/NFR-4); invalid options throw a typed `MarkOptionsError`.
- [x] Task 5 — Tests (consequences testable, test-first) (AC: #1–#3)
  - [x] Substitutability: a second in-memory adapter implementing `PriceOracle` is swapped into the same `markToMarket` caller with no caller change (NFR-8); the port type has no write method.
  - [x] CSV/replay adapter: parses the `timestamp,price` format, replays latest-at-or-before-`now`, returns `null` for an unknown asset and an empty feed; rejects a non-positive / float price.
  - [x] Mark OK: from real params (P₀, L, K, f) at a within-barrier price ⇒ legsAtPrice sum to K, unrealizedPnl sums to 0, distance-to-floor/floorBreached correct, provenance + ageMs present; a price = P₀ ⇒ both legs K/2 and zero P&L.
  - [x] Stale / no-feed / divergent: age past bound ⇒ `STALE` + null trusted fields; `null` quote ⇒ `NO_FEED`; an implausible figure (|r| past the bound, and a beyond-barrier figure) ⇒ `DIVERGENT`, flagged not trusted; assert no path ever returns a fabricated mark.
  - [x] Fail-closed options: missing/negative `freshnessBoundMs` or invalid `maxRelativeDivergence` ⇒ `MarkOptionsError` (never a permissive default).
- [x] Task 6 — Wire into the gate & validate (AC: #1)
  - [x] `vitest.config.ts` already matches `prod/packages/**/*.test.ts` — no config change. Full gate green: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format` + `format:check`, `pnpm check:regime`, `pnpm check:migrations`, `(cd prod/contracts && forge test)`.

## Dev Notes

### Scope & interpretation (P0)
- **The mark-to-market service prices the PAIR, not a user position.** Story 8.1 has no `owner`/`side`-ownership concept — that is the 8.2 position entity. The service therefore returns **both** legs' marks + P&L (long and short) from the public pair params; a later story maps a leg to a Subscriber. This keeps 8.1 strictly to "port + adapter + mark-to-market + explicit states" with no scope creep. **[P0 interpretation, documented]**
- **`legsAtPrice` / `floor` / `distance-to-floor` semantics** come from the coupled-coin reference model (architecture §4.2 freeze; `/throwaway` `coupled-math`): `r = (P − P₀)/P₀`, `V_A = (K/2)(1 + L·r)`, `V_B = (K/2)(1 − L·r)`, `V_A + V_B = K` exactly; `buffer = 1 − |L·r|`; `distance-to-floor = buffer − f`. Entry (P₀) ⇒ `r = 0` ⇒ both legs `K/2`. Unrealized P&L per leg = `legAtPrice − legAtEntry`; the two sum to 0 (delta-neutral) — a strong invariant to assert. [Source: `_bmad-output/planning-artifacts/architecture.md` §"Secondary-Trading Position Layer (Option C)" L184; `throwaway/coupled-math/src/coupled-math.ts`]
- **Freshness bound + divergence bound are PARKED TRUST INPUTS (§15 oracle integrity), required not defaulted.** Consistent with the codebase's fail-closed stance for parked params (`loadFloorParams` `FloorParamRefusalError`, `@rose/config` `ConfigRefusalError`): `markToMarket` requires `freshnessBoundMs` and `maxRelativeDivergence` from the caller and throws `MarkOptionsError` on absence/invalidity — never a permissive default that would silently trust a stale or implausible figure. **[P0 interpretation, documented]**
- **Divergence rule:** flagged when `|r| > maxRelativeDivergence` (caller-stated plausibility band) OR `|L·r| > 1` (the figure would drive a leg strictly negative — issuer-neutrality could not hold; not trustable as a live mark). At `|L·r| = 1` exactly the losing leg is `0` (a valid boundary), so it is an `OK` mark with `floorBreached = true`, not a fabrication. [Source: `throwaway/coupled-math/src/coupled-math.ts` `legValues`/`evaluate`]

### Architecture & convention constraints (cite)
- New PROD package `prod/packages/price-oracle` (FR-24): substitutable `PriceOracle` port + mark-to-market; P0 adapter = CSV/replay or testnet (no live OANDA/LMAX, §14); oracle is **read-only market data — never a writer of postings**; absent feed ⇒ "no price feed"; each mark carries provenance + freshness bound; stale ⇒ stale-mark; implausibly divergent ⇒ flagged not trusted (§15). [Source: `architecture.md` L184, L339–L344, L387; `epics.md` Epic 8 L917–L943]
- **Money exactness (NFR-2):** leg values + P&L are integer smallest-units as `bigint`; prices/floor/distance are decimal strings; never binary float. Reuse `@rose/shared` `allocate` (largest-remainder, parts sum to total) + `splitInTwo`. [Source: CYCLE-BRIEF "Money"; `prod/packages/shared/src/money.ts`]
- **Package wiring:** add to root `tsconfig.json` `references` + a `references` entry to `../shared` in the package tsconfig + `workspace:*` dep; run `pnpm install`; tsconfig must NOT exclude `*.test.ts`. ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Files `kebab-case.ts`. [Source: CYCLE-BRIEF "Established project conventions"; `prod/packages/reconcile/{package.json,tsconfig.json}`]
- **Regime:** PROD, TypeScript; `/prod` never imports `/throwaway` (so `rational.ts` is a clean prod reimplementation, not an import of the throwaway copy). `pnpm check:regime` + eslint `no-restricted-imports` stay green. [Source: `architecture.md` L190, L374; `eslint.config.mjs`]

### Prior-story learnings reused
- **Decimal-string validation pattern** (strict `^-?\d+(\.\d+)?$`, reject JS `number`/float, reject silent precision loss) from `coupled-pairs` repo + `coupled-math` `rational.parseDecimal`. [Source: `prod/packages/ledger/src/repositories/coupled-pairs.ts`; `throwaway/coupled-math/src/rational.ts`]
- **CSV `timestamp,price` tolerance** (header / blank / `#`-comment lines, strictly-positive decimal price, fail-loud on malformed data) from `/throwaway` `parseTicks`. Reimplemented in prod (regime). [Source: `throwaway/simulator/src/ticks.ts`]
- **Exact leg split** `allocate(K, [b+a, b−a])` for `L·r = a/b` (b > 0), parts sum to K exactly; throws past the barrier. [Source: `throwaway/coupled-math/src/coupled-math.ts` `legValues`]

### Testing standards
- Vitest, co-located `*.test.ts`. This package is **pure compute + in-memory adapters — no DB, no network, no clock-driven behaviour** (the `now` is injected for determinism). Test-first on the invariants (NFR-6): legs sum to K, P&L sums to 0, every refusal state is explicit and never fabricates a mark. [Source: CYCLE-BRIEF "Tests"; `vitest.config.ts`]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log References

- Full gate (Node 20 local; engine warns, non-fatal): `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm test` → 838 passed / 101 files (27 new in `price-oracle`), `pnpm format` + `format:check` ✓, `pnpm check:regime` ✓ (`/prod` ↮ `/throwaway`), `pnpm check:migrations` ✓ (up→down→up over 8 migrations), `forge test` → 171 passed.

### Completion Notes

- New PROD package `@rose/price-oracle` (deps: `@rose/shared` only). Read-only `PriceOracle` port (`getPrice → PriceQuote | null`, no write/post method); P0 `CsvReplayPriceOracle` (`timestamp,price`, deterministic injected clock, `null` for unknown asset / empty feed / pre-first-tick). Mark-to-market `markToMarket(pair, quote, options)` prices the **pair** (both legs) from real params via exact rational + `@rose/shared` `allocate`/`splitInTwo`: legs sum to K, P&L is delta-neutral (sums to 0). Money exact (bigint legs/P&L; decimal-string prices/floor/distance).
- Explicit price states, never fabricated: `NO_FEED` (null quote), `STALE` (`ageMs > freshnessBoundMs`), `DIVERGENT` (`|r| > maxRelativeDivergence` or `|L·r| > 1`, or an `INVALID_PRICE` feed figure). Non-OK ⇒ trusted fields null; the offending figure is surfaced + flagged but never trusted. Trust inputs `freshnessBoundMs`/`maxRelativeDivergence` are fail-closed (required, never defaulted — `MarkOptionsError`).
- Scope held to 8.1: no `positions` table, no open/close, no API/web, no reconciliation, no leverage guardrail. `/prod` cannot import the `/throwaway` `coupled-math`/`rational`; a clean prod `rational.ts` was reimplemented (regime boundary).

### File List

- `prod/packages/price-oracle/package.json` (new)
- `prod/packages/price-oracle/tsconfig.json` (new)
- `prod/packages/price-oracle/src/index.ts` (new)
- `prod/packages/price-oracle/src/rational.ts` (new)
- `prod/packages/price-oracle/src/rational.test.ts` (new)
- `prod/packages/price-oracle/src/price-oracle.ts` (new — the port)
- `prod/packages/price-oracle/src/adapters/csv-replay-adapter.ts` (new)
- `prod/packages/price-oracle/src/adapters/csv-replay-adapter.test.ts` (new)
- `prod/packages/price-oracle/src/mark-to-market.ts` (new)
- `prod/packages/price-oracle/src/mark-to-market.test.ts` (new)
- `tsconfig.json` (edit — add `price-oracle` to references)
- `pnpm-lock.yaml` (edit — register `@rose/price-oracle`)

## Change Log

| Date       | Version | Description                                                                  | Author |
| ---------- | ------- | ---------------------------------------------------------------------------- | ------ |
| 2026-06-19 | 0.1     | Story drafted (create-story), ready-for-dev                                  | Amelia |
| 2026-06-19 | 0.2     | Implemented `@rose/price-oracle` (port + CSV/replay adapter + mark-to-market); gate green; status review | Amelia |
| 2026-06-19 | 0.3     | Adversarial review (3 lenses) + live-Postgres probe; 2 regression tests added; gate green; status done | Amelia (review) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (adversarial, fresh-context). **Date:** 2026-06-19. **Outcome:** APPROVE — merge-ready.

### Scope & method
Reviewed across three lenses — Correctness (logic, money/precision, fabrication paths), Edge-cases (probed live Postgres on :5544 against a real `coupled_pairs` row), Acceptance (every AC element; no scope creep into 8.2–8.6). Full gate re-run green after changes.

### Correctness
- **Money exactness (NFR-2):** leg split + P&L are integer smallest-units (`bigint`) via `@rose/shared` `allocate`/`splitInTwo`; deviations/floor/divergence are exact rationals (`rational.ts`); prices/floor/distance cross as decimal strings. No binary float on any money/price path. Verified invariants in tests: `legsAtPrice.long + legsAtPrice.short === K` and `unrealizedPnl.long + unrealizedPnl.short === 0` (delta-neutral) at multiple prices incl. the barrier boundary.
- **Never fabricates a mark:** the only path that produces trusted compute fields requires `quote !== null && !stale && !divergent && valid price`. Every other path returns `legsAtPrice/entryLegs/unrealizedPnl/distanceToFloor/floorBreached = null` with an explicit status — confirmed by assertion in each refusal test.
- **Read-only oracle:** the `PriceOracle` port exposes only `source` + `getPrice`; no write/post method anywhere; the package does not import `@rose/ledger` or `postTransfer` and writes no postings (AC1 "no path that writes postings" met by construction).

### Edge-cases (live Postgres probe)
Seeded + read a real `coupled_pairs` row (`EUR/USD`, P₀ `1.08500000`, L `1`, K `1000000`, f `0.30`) and ran `markToMarket`: at anchor ⇒ `OK` legs `500000/500000`, P&L `0/0`, distance `0.70000000`; +5% ⇒ `OK`, legs sum to K, P&L sums to 0; stale quote ⇒ `STALE`; null ⇒ `NO_FEED`; 2× anchor ⇒ `DIVERGENT`. The ledger `CoupledPairView` is structurally assignable to `MarkablePair` (no `@rose/ledger` coupling needed — NFR-8 seam holds). DB reset to a clean migrated state afterward.
- Boundary `|L·r| = 1` (loser leg exactly 0) is a valid `OK` mark with `floorBreached = true` — not a fabrication, not divergent — covered by a regression test.
- Divergence is symmetric (price below the anchor past the band ⇒ `DIVERGENT`) — covered by a regression test.
- `freshnessBoundMs = Infinity` is rejected (would defeat the staleness guard — fail-closed); `K = 0` degrades to all-zero legs without throwing.

### Acceptance
- **AC1 (port + adapter + substitutable + read-only):** MET — `PriceOracle` port, `CsvReplayPriceOracle` P0 adapter (CSV/replay, no live OANDA/LMAX), swap-no-caller test, no postings path.
- **AC2 (entry/mark/unrealized P&L from real params + provenance + freshness):** MET — `entryPrice = P₀`, `legsAtPrice`, `unrealizedPnl`, `floor`, `distanceToFloor` from real pair params; each mark carries `provenance {source, asOf, sequence}` + `freshnessBoundMs` + `ageMs`.
- **AC3 (stale / no-feed / divergent explicit, never trusted):** MET — `STALE`, `NO_FEED`, `DIVERGENT` (incl. `INVALID_PRICE` and beyond-barrier) are explicit; offending figures surfaced but never trusted.
- **No scope creep:** no `positions` table, open/close, API/web, reconciliation, or leverage guardrail. Package depends on `@rose/shared` only.

### Findings & Action Items
- **No High/Med findings.** No code changes required beyond the two regression tests added during review.
- **[Low — documented, no fix]** A future-dated quote (`now < asOf`, negative `ageMs`) is treated as fresh; the freshness bound intentionally guards only staleness (too-old). Flagging clock-skewed *future* quotes would need a separate skew bound that is not part of this story's ACs — deferred (note for 8.4 wiring if a UI surfaces it).
- **[Low — by design]** `distanceToFloor` is a lossy `toApproxString` decimal for display only; never used in money assertions (the exact `bigint` legs/P&L are the trusted figures).
