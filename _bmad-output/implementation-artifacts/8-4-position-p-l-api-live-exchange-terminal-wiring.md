---
baseline_commit: 8beba739bd3b32f1dcedb36912718ad136904a58
---

# Story 8.4: Position P&L API + live Exchange-terminal wiring

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Subscriber (Rose Member),
I want typed endpoints for my positions and live P&L, and the Exchange/Trading terminal wired to them,
So that I see my live mark and P&L (or an honest empty-state) in place of the price-feed placeholders shipped earlier (FR-26, FR-14, UX-DR2/4/6).

## Acceptance Criteria

**Given** the `api` package
**When** position/P&L endpoints respond
**Then** typed REST endpoints expose per-user positions and live P&L with money as **decimal strings at the API boundary** (serialization only — storage/compute stay integer-smallest-unit / `NUMERIC`, NFR-2), validated by Zod and surfaced in the OpenAPI document

**Given** the Exchange/Trading surface and the **existing Story-6.6 terminal components** (`market-list`, `pair-strip`, `order-ticket`, `positions-table`, `chart-placeholder`)
**When** the oracle is connected
**Then** the terminal renders **live positions + marks + P&L** (UX-DR2 money display), replacing the price-feed empty-states — **behavioural wiring only, no new visual design**
**And** when the oracle is absent or stale, it shows the documented **"no price feed" / stale-mark** state (UX-DR4) — never a fabricated mark

**Given** the open/close actions on the terminal
**When** a Subscriber acts
**Then** they pass the **Review → Confirm** panel that states the on-chain consequence and stays **pending until the commit point** (UX-DR6), and the leverage selector renders a **disabled / fixed-1x** state in P0

### Scope boundary (P0, this story only)

- **IN:**
  - (a) **`@rose/positions` read primitive** — an additive `listPositionsByOwner(db, { owner, referenceAsset? })` repository read (no change to the 8.2/8.3 write/lifecycle core).
  - (b) **`@rose/api` position P&L endpoint** — `GET /positions?owner=<>&referenceAsset=<>` returns the per-user positions (8.2/8.3) each with a **live mark** computed by the 8.1 `markToMarket` over the linked coupled pair. The `PriceOracle` (8.1) + the parked trust inputs (`freshnessBoundMs`, `maxRelativeDivergence`, §15) are **injected ports** on `ApiDeps` (the API reads no env). Money crosses the boundary as **strings** (NFR-2): genuinely-decimal fields (entry P₀, mark price, floor, distance-to-floor, leverage) as decimal strings; smallest-unit magnitudes (size, collateral, realized/unrealized P&L) as raw smallest-unit integer strings (the reviewed 6.1 no-fabricated-scale precedent). Zod-validated, surfaced in the OpenAPI document. Reuses the existing `{ error: { code, message } }` contract.
  - (c) **Web wiring (`@rose/web`)** — extend the typed client (`getPositions`) + the contract-types barrel + a `usePositions` hook; wire the **existing** terminal components so the `positions-table` Mark/P&L columns + the chart-head price block render **live marks + directional P&L** when the oracle is connected, and the documented **"no price feed" / stale-mark** state (UX-DR4) when it is absent/stale/divergent — **behavioural wiring only, no new visual design**.
  - (d) **Open/close on the terminal** — the `order-ticket` exposes Open/Close that pass the **existing 6.6 `ConfirmActionPanel`** (Review → Confirm, pending until the polled commit point, UX-DR6) and a **disabled / fixed-1x** leverage selector.
- **OUT (later stories, do NOT pull forward):** position↔pair reconciliation / residual-backing invariant (8.5); the **independent single-side close** (D1 topology) + its §11.4 solvency guardrail (8.6). The independent single-side close stays gated/absent.
- **OUT:** any change to the deployed coupling contracts (no re-audit), to `postTransfer`, to the 5.2 outbox/saga, the 5.3/5.4 mint/burn, the 6.2/6.3 subscribe/redeem, the 8.2 positions schema/migration, or the 8.3 open/close service core. The oracle stays **read-only** (writes no postings). No new visual design / no new UX-DR.

## Tasks / Subtasks

- [x] Task 1 — `@rose/positions`: additive `listPositionsByOwner` read (AC: #1)
  - [x] Add `listPositionsByOwner(db, { owner, referenceAsset? })` to `repositories/positions.ts` (validates a non-empty owner; filters by owner + optional referenceAsset; orders by `created_at`). Reuses the existing `toView`. No change to create/reset/close/lifecycle.
- [x] Task 2 — `@rose/api`: inject the oracle + trust ports; the position P&L schemas (AC: #1)
  - [x] `ApiDeps` gains optional `priceOracle?: PriceOracle` + `markTrust?: { freshnessBoundMs; maxRelativeDivergence }` (injected ports — the API reads no env, mirrors `covenantThresholds`).
  - [x] `schemas.ts`: `MarkStatusSchema` (`OK|STALE|NO_FEED|DIVERGENT`), `PositionMarkSchema` (status + entryPrice/markPrice/floor/distanceToFloor decimal strings, `unrealizedPnl` signed integer string, provenance, ageMs, freshnessBoundMs, flags — trusted fields null unless `OK`, markPrice null only for `NO_FEED`), `PositionSchema` (the position row + `mark`), `PositionsResponseSchema`, `PositionsQuerySchema`. Export the inferred types.
- [x] Task 3 — `@rose/api`: the `GET /positions` route + serializer (AC: #1)
  - [x] `routes/positions.ts`: validate `?owner` (Zod, 400 on absent/empty); `listPositionsByOwner`; for each, `getCoupledPair` → `MarkablePair`; quote via `deps.priceOracle?.getPrice(referenceAsset)` (no oracle ⇒ explicit `NO_FEED`, never fabricated); `markToMarket(pair, quote, trust)`; directional P&L = `mark.unrealizedPnl[side]`. Serialize bigint→string, Date→ISO. Register in `app.ts`; export from `index.ts`.
  - [x] **Fail-closed trust:** when an oracle IS configured but `markTrust` is absent ⇒ typed **503** `POSITION_MARK_TRUST_UNAVAILABLE` (never silently default a trust bound, §15). No oracle ⇒ the honest `NO_FEED` mark (no trust needed).
- [x] Task 4 — `@rose/web`: client + hook + contract types (AC: #2)
  - [x] `contract-types.ts`: re-export `PositionsResponse`/`Position`/`PositionMark` (TYPE-only). `api-client.ts`: `getPositions(owner, opts?)` → `GET /positions?owner=…`. `queries.ts`: `usePositions(owner)` (polls the refresh window, `enabled` only for a non-empty owner).
- [x] Task 5 — `@rose/web`: terminal wiring — live marks / no-feed / stale (AC: #2)
  - [x] `positions-table.tsx`: render the per-user positions + marks — Mark column = live `markPrice` (OK) / "no price feed" (NO_FEED) / "stale" + surfaced untrusted price (STALE) / "flagged" (DIVERGENT); P&L column = directional `unrealizedPnl` via `DeltaIndicator` (glyph+sign, never color-only) when OK, else the documented empty-state. Distance-to-floor from the mark (OK) else the existing pair-math fallback. No new visual design.
  - [x] `exchange-trading.tsx`: fetch `usePositions(owner)`; pass the scoped positions to `PositionsTable`; the chart-head price block shows the selected market's live mark (OK) / stale label / the existing "price feed not connected" when absent. 24h hi/lo / open-interest stay honest empty-states (no historical/candle feed in P0).
- [x] Task 6 — `@rose/web`: open/close via Review→Confirm + disabled-1x leverage (AC: #3)
  - [x] `order-ticket.tsx`: a **disabled / fixed-1x** leverage selector (`1× (fixed)`, P0) + Open/Close actions that open the existing `ConfirmActionPanel` inline (driving `useSubscribe`/`useRedeem` + `useSubscription`/`useRedemption` polling) — pending until the on-chain commit point (UX-DR6), the on-chain consequence stated, no optimistic success. Available only when the market's pair carries a `noteId`.
- [x] Task 7 — Tests (test-first on the invariants) (AC: #1–#3)
  - [x] API (local Postgres + injected fake oracle): OK mark (LONG gains when price ↑, SHORT mirror; P&L decimal exact, money strings); NO_FEED (no oracle / null quote — never a fabricated price); STALE (old quote ⇒ trusted fields null, price surfaced); DIVERGENT (2× anchor); CLOSED position surfaced; `?owner` required (400); the OpenAPI document lists `/positions` + types money as strings; an NFR-2 large-magnitude P&L survives the serialize path exactly.
  - [x] Web: `getPositions` sends the owner query + parses the typed body; the terminal renders a live mark + directional P&L (OK), the "no price feed" state (NO_FEED) and the "stale" state (STALE) — never a fabricated mark; the order-ticket leverage selector is disabled/fixed-1x; Open passes the Review→Confirm panel and stays pending until confirmed.
- [x] Task 8 — Runtime composition (paper mode) + gate (AC: all)
  - [x] `serve.ts` paper mode: inject a read-only replay `PriceOracle` (honestly replaying the seeded pair anchor) + explicit paper trust inputs, so the live terminal shows OK marks in paper mode. Read-only deployment stays `NO_FEED` (no oracle composed). Full gate green.

## Dev Notes

### Scope & interpretation (P0)

- **Money at the boundary: decimal strings for prices, raw smallest-unit integer strings for token magnitudes.** NFR-2's "money over the wire = a string (never a JS number/float)" is satisfied two ways already in this codebase: the `MoneySchema` envelope (group-view entity accounts, which carry a real ledger `decimal_scale`) and **scale-less smallest-unit integer strings** for the coupled-pair magnitudes K/V_A/V_B (the reviewed Story-6.1 decision — the `coupled_pairs` row stores no per-leg scale, so the boundary fabricates none). A position's `size_units`/`collateral`/`realized_pnl`/`unrealized_pnl` are the SAME token smallest-units as the pair (1:1 in paper, 8.3) with no stored scale, so they cross as raw smallest-unit integer strings (consistent with the pair, no fabricated 18-scale). The genuinely-decimal fields — entry P₀, mark price, floor, distance-to-floor, leverage — cross as **decimal strings**. Both forms are exact strings, never a JS number/float (NFR-2). **[P0 interpretation, documented — follows the reviewed 6.1 precedent]** [Source: `6-1-...md` "Coupled-pair magnitudes are smallest-unit integer strings (no fabricated scale)"; `architecture.md` L183, L187]
- **Directional P&L = the position's side leg of the pair-level mark.** `markToMarket` (8.1) prices the PAIR (both legs, P&L delta-neutral, sums to 0). A per-user position has a `side` (LONG|SHORT); its live unrealized P&L is `mark.unrealizedPnl.long` (LONG) or `mark.unrealizedPnl.short` (SHORT). Realized P&L is the position row's `realized_pnl` (crystallised at resets, 8.2). When the mark is not `OK` (NO_FEED/STALE/DIVERGENT) the directional P&L is `null` — never fabricated. **[P0 interpretation, documented]** [Source: `mark-to-market.ts` `unrealizedPnl`; `architecture.md` L182, L184]
- **Trust inputs are injected ports, fail-closed (§15).** The freshness bound + divergence band are parked trust inputs (8.1 `MarkOptions`, required-never-defaulted). The API does not read env; the composition root injects `markTrust`. If an oracle IS configured but `markTrust` is absent, the `/positions` route returns a typed **503** (`POSITION_MARK_TRUST_UNAVAILABLE`) — never a silent default that would trust a stale/implausible figure. With **no** oracle configured the marks are the honest `NO_FEED` state (no trust input needed to say "no feed"). **[P0 interpretation, documented]** [Source: `mark-to-market.ts` `validateOptions`/`MarkOptionsError`; `app.ts` injected `covenantThresholds` precedent]
- **The terminal shows the per-user (injected demo owner) positions — operator surface, paper/local.** The 6.6 terminal showed the coupled-pair book as a stand-in (no position layer existed yet). 8.4 wires the REAL per-user positions (`@rose/positions`) into the SAME `positions-table` columns (Market/State/Size/Entry/Mark/P&L/Distance — every column maps to a position) + the chart-head price. The owner is an injected prop in paper/local (the `VITE_SUBSCRIBER_ADDRESS` precedent from 6.6); the deployed session/ONCHAINID source stays ops-deferred. **Behavioural wiring only — the table/columns/components are unchanged visually.** [Source: `architecture.md` L188; `6-6-...md` `VITE_SUBSCRIBER_ADDRESS`]
- **Open/close on the terminal reuse the 6.6 subscribe/redeem flow (the package-level acquire/release).** AC-3's "open/close … Review → Confirm … pending until the commit point" is the existing pessimistic `ConfirmActionPanel` + `useSubscribe`/`useRedeem` + status polling (6.6), surfaced inline on the order-ticket. The leverage selector is a disabled `1× (fixed)` control (P0 pins leverage to 1x). The independent single-side close (D1 topology) stays gated/absent (8.6). **[P0 interpretation, documented]** [Source: `confirm-action-panel.tsx`; `architecture.md` L186]

### Architecture & convention constraints (cite)

- **API (FR-26):** per-user positions + live P&L over the existing **Fastify + Zod + OpenAPI** boundary (6.1); money as **decimal strings at the boundary** only (storage/compute stay integer / NUMERIC, NFR-2); refusals use the existing `{ error: { code, message } }` contract. [Source: `architecture.md` L187; `6-1-...md`]
- **Web wiring (FR-26, FR-14):** replace the price-feed empty-states in `exchange-trading/*` with live positions + marks, **reusing** the existing terminal components (`market-list`, `pair-strip`, `order-ticket`, `positions-table`, `chart-placeholder`); oracle connected ⇒ live mark/P&L, oracle absent ⇒ documented empty-state; live/stale-mark states (UX-DR4). **Behavioural wiring only — no new visual design.** [Source: `architecture.md` L188; `epics.md` Story 8.4 + Epic-8 "UX reuse" note]
- **Oracle read-only; mark never fabricated (§15).** The `PriceOracle` port has no write/post method; an absent/stale/implausibly-divergent feed yields an explicit state (`NO_FEED`/`STALE`/`DIVERGENT`) with `null` trusted fields. [Source: `price-oracle.ts`; `mark-to-market.ts`]
- **Single source = the Zod schemas; the OpenAPI document derives from them.** Money fields are typed `string` in the derived OpenAPI (a test asserts it). [Source: `schemas.ts` header; `6-1-...md` AC-1]
- **Package wiring:** `@rose/api` gains `@rose/positions` + `@rose/price-oracle` (`workspace:*`) deps + tsconfig references; `pnpm install`. No cycle (neither depends on api). `@rose/web → @rose/api` stays TYPE-only. [Source: CYCLE-BRIEF; `6-1-...md`]
- **Regime:** PROD, TypeScript; `/prod` never imports `/throwaway`; `pnpm check:regime` stays green. [Source: `architecture.md` L190]

### Prior-story learnings reused

- **8.1 `markToMarket`** — prices the pair from real params; explicit `OK|STALE|NO_FEED|DIVERGENT` states, never fabricated; trust inputs fail-closed. The `CoupledPairView` is structurally assignable to `MarkablePair` (NFR-8 seam — no `@rose/ledger` coupling needed). [Source: `8-1-...md` review]
- **8.2/8.3 positions** — `PositionView` (bigint magnitudes / decimal-string prices; signed P&L); a position is `OPEN|CLOSED`, always references an issued pair. `listPositionsByOwner` reuses `toView`. [Source: `repositories/positions.ts`]
- **6.1 REST pattern** — route module = `(deps) => async (app) => app.get(path, { schema: { params/querystring/response: Zod } }, handler)`; serializers map bigint→string / Date→ISO; the structured-error mapper + `installErrorHandling` are reused. [Source: `routes/coupled-pairs.ts`, `routes/subscriptions.ts`, `app.ts`, `serializers.ts`]
- **6.6 terminal** — `ConfirmActionPanel` (Review→Confirm + pending, no optimistic success), `useSubscribe`/`useRedeem` + `useSubscription`/`useRedemption` polling, `MoneyCell`/`DeltaIndicator`/`StatusBadge`, the injected client + `ApiClientProvider`, the per-file `// @vitest-environment jsdom` + `import '../../test/setup.js'` test harness. Reused/extended, not forked. [Source: `6-6-...md`]

### Testing standards

- Vitest, co-located `*.test.ts(x)`. API integration tests use the local Postgres (5544), serial (`fileParallelism:false`): `createPool`/`createDb`/`hardReset`/`migrateUp` + `TRUNCATE … CASCADE`; the app is exercised via `app.inject` (no socket); the oracle is an **injected fake** (deterministic quote, NO network). Web tests are LOCAL/jsdom against typed fixtures + an injected client (NO API server, NO Sepolia, NO secret). Test-first on: money-as-strings (no number/float), the OK/NO_FEED/STALE/DIVERGENT mark states (never fabricated), the directional P&L sign, the pending-until-commit panel, the disabled-1x leverage. [Source: CYCLE-BRIEF "Tests"; `app.test.ts`; `6-6-...md`]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Full gate (Node 20 local; engine warns, non-fatal): see Completion Notes for the final counts.
- `@rose/api` gained `@rose/positions` + `@rose/price-oracle` (`workspace:*`) + tsconfig references; `pnpm install` to link. No import cycle (neither depends on api).

### Completion Notes

- **AC-1 (typed positions/P&L endpoint; money as strings; Zod + OpenAPI):** `GET /positions?owner=&referenceAsset=` (`routes/positions.ts`) lists one owner's positions (`@rose/positions` `listPositionsByOwner`, additive read) and marks each via the 8.1 `markToMarket` over the linked coupled pair (`getCoupledPair` → structural `MarkablePair`). The `PriceOracle` + the parked trust inputs are INJECTED ports on `ApiDeps` (the API reads no env, mirrors `covenantThresholds`). Money is strings (NFR-2): decimal strings for entry/mark/floor/distance/leverage, raw smallest-unit integer strings for size/collateral/realized + the directional unrealized P&L (the reviewed 6.1 no-fabricated-scale precedent — documented P0). Zod-validated (`PositionSchema`/`PositionMarkSchema`/`PositionsResponseSchema`/`PositionsQuerySchema`), surfaced in the OpenAPI document (test asserts the money fields type as `string`). A >2^53 P&L survives the serialize path exactly.
- **AC-2 (live marks/P&L on the existing terminal; honest no-feed/stale):** the SAME 6.6 components are reused (no new visual design). `positions-table.tsx` keeps the identical 7-column layout, wiring the Mark/P&L/Distance columns to the live mark: `OK` ⇒ live `markPrice` + directional P&L (`DeltaIndicator`, glyph+sign, never color-only); `NO_FEED` ⇒ "no price feed"; `STALE` ⇒ the surfaced-but-untrusted price + "(stale)"; `DIVERGENT` ⇒ "flagged". The chart-head `MarketPrice` shows the live/stale mark or "price feed not connected". The directional P&L is `null` (never rendered as a number) on any non-OK mark. `usePositions(owner)` + the extended client (`getPositions`) + contract-types feed it.
- **AC-3 (open/close via Review→Confirm + disabled-1x leverage):** `order-ticket.tsx` gains a DISABLED `1× (fixed)` leverage `<select>` (P0) and Open/Close actions that open the existing `ConfirmActionPanel` inline (driving `useSubscribe`/`useRedeem` + status polling). Pending-until-commit is genuine: success shows ONLY once the polled status returns `confirmed` (no optimistic success); `onSuccess` merely captures the handle. The independent single-side close (D1) stays absent (8.6).
- **Runtime (paper mode):** `serve.ts` injects a read-only anchor-replay `PriceOracle` (honestly replays the issued pair's anchor — fabricates no market move) + explicit paper trust inputs, so the paper terminal shows live OK marks; the read-only deployment composes no oracle ⇒ NO_FEED.
- **Scope held:** no reconciliation (8.5), no independent single-side close / solvency guardrail (8.6). The 8.2 schema/migration, the 8.3 service core, 5.x/6.x, and the contracts are reused UNCHANGED. The only backend touches are additive: the positions read, the API endpoint/schemas/serializer, and the injected oracle/trust ports.
- **Gate (Node 20 local):** `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm test` → **899 passed** / 105 files (+25 since 8.3's 874: 16 API positions + web client/terminal/order-ticket), `pnpm format` + `format:check` ✓, `pnpm check:regime` ✓, `pnpm check:migrations` ✓ (9 migrations — NO new migration; 8.4 adds no schema), `forge test` → **171 passed** (no Solidity touched).

### File List

- `prod/packages/positions/src/repositories/positions.ts` (edit — additive `listPositionsByOwner`)
- `prod/packages/api/src/app.ts` (edit — inject `priceOracle`/`markTrust`; register the positions route)
- `prod/packages/api/src/schemas.ts` (edit — position P&L schemas)
- `prod/packages/api/src/serializers.ts` (edit — `serializePositionWithMark`)
- `prod/packages/api/src/routes/positions.ts` (new — `GET /positions`)
- `prod/packages/api/src/positions.test.ts` (new — local Postgres + injected fake oracle)
- `prod/packages/api/src/index.ts` (edit — export the position schemas/types/serializer)
- `prod/packages/api/src/serve.ts` (edit — paper-mode read-only replay oracle + paper trust)
- `prod/packages/api/package.json` + `tsconfig.json` (edit — `@rose/positions` + `@rose/price-oracle`)
- `prod/packages/web/src/lib/contract-types.ts` (edit — position wire-type re-exports)
- `prod/packages/web/src/lib/api-client.ts` (edit — `getPositions`)
- `prod/packages/web/src/lib/queries.ts` (edit — `usePositions`)
- `prod/packages/web/src/surfaces/exchange-trading/exchange-trading.tsx` (edit — wire live positions/marks)
- `prod/packages/web/src/surfaces/exchange-trading/positions-table.tsx` (edit — live mark/P&L columns)
- `prod/packages/web/src/surfaces/exchange-trading/order-ticket.tsx` (edit — disabled-1x leverage + open/close confirm)
- `prod/packages/web/src/surfaces/exchange-trading/exchange-trading.test.tsx` (edit — live/no-feed/stale)
- `prod/packages/web/src/surfaces/exchange-trading/order-ticket.test.tsx` (new — leverage/open-confirm)
- `prod/packages/web/src/lib/api-client.test.ts` (edit — getPositions)
- `prod/packages/web/src/test/fixtures.ts` (edit — positions/marks fixtures)
- `pnpm-lock.yaml` (edit — link `@rose/positions`/`@rose/price-oracle` into `@rose/api`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (edit — 8-4 transitions)

## Change Log

| Date       | Version | Description                                                                  | Author |
| ---------- | ------- | ---------------------------------------------------------------------------- | ------ |
| 2026-06-19 | 0.1     | Story drafted (create-story), ready-for-dev                                  | Amelia |
| 2026-06-19 | 0.2     | Implemented the position P&L API (`GET /positions` over `markToMarket`) + live Exchange-terminal wiring (positions-table marks/P&L, chart-head price, order-ticket open/close via Review→Confirm + disabled-1x leverage); gate green; status review | Amelia |
| 2026-06-19 | 0.3     | Adversarial review (Correctness + Acceptance lenses) + live-Postgres probe (owner isolation / referenceAsset filter / empty-owner rejection). 1 Med + 2 Low fixed; 2 regression tests added (invalid-feed never-500, owner isolation). Gate green (test 897→899, forge 171, migrations 9). DB left migrated+seeded. Status done | Amelia (review) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (adversarial, fresh-context). **Date:** 2026-06-19. **Outcome:** APPROVE — merge-ready.

### Scope & method

Reviewed across three lenses — Correctness (the directional-P&L null-on-non-OK invariant, money-as-strings/no-float-leak, the fail-closed trust 503, the no-oracle-without-markToMarket path, the `trust!` guard), Acceptance (every AC element incl. the decimal-string boundary + OpenAPI, live-vs-stale-vs-no-feed states, Review→Confirm pending-until-commit, disabled-1x leverage; no scope creep into 8.5/8.6), Edge-cases (probed the live Postgres on :5544: owner isolation, the `referenceAsset` filter, empty-owner rejection). Full gate re-run green; DB left migrated+seeded.

### Acceptance

- **AC-1 MET** — real typed Fastify+Zod route; storage stays integer/NUMERIC, serialization-only at the boundary (`assertNotFloat` guards every bigint→string); decimal strings for prices, raw integer strings for scale-less token magnitudes (documented 6.1 precedent — a defensible reading of "money as decimal strings", not a gap; the load-bearing NFR-2 "string, never a JS number/float" holds for every field); OpenAPI lists `/positions` and types money as `string`; >2^53 P&L exact.
- **AC-2 MET** — the SAME 6.6 components, identical layout (no new visual design); live mark only on `OK`, the documented "no price feed"/"stale"/"flagged" states otherwise; a non-OK mark never renders a number.
- **AC-3 MET** — disabled `1× (fixed)` leverage selector; Review→Confirm via the existing `ConfirmActionPanel`; success shows ONLY on the polled `confirmed` (no optimistic success — tested).
- **No scope creep** — no reconciliation (8.5); no independent single-side close / §11.4 guardrail (8.6); open/close drive the package-level subscribe/redeem (atomic L+S), the independent single-side close stays absent.

### Findings & Action Items

- **[Med — FIXED]** `serializeMark` passed `markToMarket`'s surfaced-but-untrusted figure verbatim; on a contract-violating feed (`INVALID_PRICE` — a non-decimal figure like `"NaN"`) the response Zod regex would have 500'd, defeating the "never crash on a bad feed" guarantee. FIX: `serializeMark` nulls `markPrice` unless it is a plain decimal string (the integrity fault stays in `flags`). Regression test added (`positions.test.ts` — invalid feed ⇒ 200, `markPrice` null, `flags` contains `INVALID_PRICE`). Latent (the paper anchor-replay oracle never produces it), fixed for the real-feed seam.
- **[Low — FIXED]** `PositionMarkSchema.freshnessBoundMs`/`ageMs` required `int()` while `markToMarket` accepts any finite non-negative number; a fractional trust bound would 500 the response. FIX: relaxed to `z.number().nonnegative()`.
- **[Low — FIXED]** the terminal open/close idempotency key omitted the owner (multi-owner collision under NFR-9). FIX: `owner` folded into the key.
- **[Low — documented, no fix]** `serializePosition` surfaces only the LIVE mark's directional P&L, intentionally dropping the stored `PositionView.unrealizedPnl` column (single-source; avoids a stale figure). `noFeedMarkResponse` sets `freshnessBoundMs: null` (no trust applied) vs `markToMarket`'s numeric bound — both schema-valid, documented.
