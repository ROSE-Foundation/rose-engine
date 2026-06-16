---
baseline_commit: NO_VCS
---

# Story 6.5: Covenant Console and Coupled-Pair surfaces on live data

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an internal operator / steward,
I want the Covenant Console and Coupled-Pair surfaces rendering live data on a sober, trustworthy design system,
so that I can see group NAV/exposure and live pair state with no mockups (FR-14, UX-DR1–4, UX-DR7, UX-DR8).

## Acceptance Criteria

1. **Given** the front-end app (per DESIGN.md / EXPERIENCE.md), **when** the design system is set up, **then** shadcn/ui-style components carry the DESIGN.md semantic tokens with a persisted **light/dark toggle** (rosé `primary` for brand/actions only; `gain`/`loss`/`warn`/`info` for data) and shared data-product components exist: **money cell**, **delta indicator**, **status badge** (six lifecycle states + `live`/`divergent`/`pending`), **live indicator**, **divergence banner** (UX-DR1, UX-DR3). **And** every figure renders in tabular mono from **decimal strings** with asset symbol + scale, right-aligned, no truncation, deltas as sign + glyph + color (UX-DR2).
2. **Given** a populated, reconciled system, **when** I open the Covenant Console, **then** it renders live group NAV, per-entity balances, float yield, and exposure from the group view (FR-9), with explicit loading/empty/error states (UX-DR4). **And** I can drill group → entity → account → journal entry → on-chain tx hash, with a copy-tx-hash affordance (UX-DR7).
3. **Given** an active pair, **when** I open the Coupled-Pair view, **then** it renders live `V_A`, `V_B`, `K`, `floor`, `anchor`, current `P`, and the holding from live pair state (FR-6) — no hard-coded mockup data — with `V_A + V_B = K` and distance-to-floor legible (UX-DR2). **And** the lifecycle status badge reflects the live state, and the live indicator flips to **stale** (warn + last-updated) when data ages beyond the refresh window (UX-DR3, UX-DR4).
4. **Given** a ledger↔chain divergence reported by reconcile (FR-10), **when** it occurs on a surface, **then** a divergence banner states the correction-toward-chain and links to the journaled correcting entry (UX-DR4).
5. **Given** the accessibility floor (UX-DR8), **when** the surfaces are built, **then** they meet WCAG 2.2 AA in both color modes, signal nothing by color alone, are fully keyboard-operable, and announce money with unit + scale and the lifecycle state to screen readers.

### Scope boundary (P0, this story only — PAPER/LOCAL, no network in tests)

- **Network perimeter (binding, strict).** "Live data" = the JSON served by `@rose/api` in **paper/local** mode (Postgres local + mocked chain, per Stories 6.1–6.4). This story builds the **front-end surfaces that CONSUME that contract**. Component tests run **LOCAL only** (Vitest + jsdom + `@testing-library/react`) against **typed fixture data** shaped by the `@rose/api` contract types — **NO real network, NO running API server, NO Sepolia, NO secrets**. Create **NO** `.env`, **NO** secret, **NO** placeholder RPC/address/key. The real ingress wiring (CORS, session auth, the live API base URL, the TanStack Query polling against a deployed API) is **ops-deferred** — record it in `deferred-work.md` story-6.5.
- **IN SCOPE:**
  - (a) **A NEW workspace package `@rose/web`** at `prod/packages/web` — React 18 + Vite + TypeScript (the architecture-named home of FR-14 surfaces: `architecture.md` §Project Structure line 321 `web/`, §Requirements-to-Structure line 358 `Engine surfaces … prod/packages/web`). It declares its own deps (package.json) + updates `pnpm-lock.yaml` + adds a tsconfig referenced by the root solution config. PROD regime only — imports **only** `@rose/api` (TYPE-only, for the contract types) + npm deps; never `/throwaway`, never another `@rose/*` runtime edge.
  - (b) **Design-system foundation (AC-1):** Tailwind (v4, `@tailwindcss/vite`) carrying the DESIGN.md tokens as CSS variables for **both** light and dark; a `cn()` util (`clsx` + `tailwind-merge`) + `class-variance-authority`; a small set of hand-authored **shadcn-pattern** primitives in `src/components/ui/` (the shadcn philosophy is copy-in, not an npm runtime dep — keeps the build hermetic, no registry fetch at build). Tokens defined as semantic CSS vars: `--primary` (rosé `#B12A66` light / `#E85C97` dark — brand/actions ONLY), `--gain`/`--loss`/`--warn`/`--info` (+ `-dark` values), inheriting shadcn neutrals for chrome. **No raw hex in components — reference token classes only (UX-DR1).**
  - (c) **A persisted light/dark toggle (AC-1, UX-DR8):** `ThemeProvider` toggling a `dark` class on `<html>`, persisted to `localStorage`, defaulting to system preference; keyboard-operable; both modes first-class.
  - (d) **Shared data-product components (AC-1) — each TDD'd:**
    - `MoneyCell` — renders a `Money` ({ asset, scale, smallestUnits, decimal }) in tabular mono, right-aligned, asset symbol + decimal scale always shown, **from the decimal string** (never JS `number`/float), no truncation, with an `aria-label` announcing value + unit + scale (UX-DR2, UX-DR8, NFR-2).
    - `DeltaIndicator` — sign + glyph (`▴`/`▾`) + semantic `gain`/`loss` color; never color-alone (the glyph + sign carry meaning).
    - `StatusBadge` — pill mapping the six lifecycle states (`PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`) **plus** `live`/`divergent`/`pending`; color-mapped **and label-bearing** (never color-only); announces the state to SR.
    - `LiveIndicator` — `gain` pulse while fresh; flips to `warn` "stale · last updated {time}" when data ages beyond a refresh window; freshness change announced via `aria-live`.
    - `DivergenceBanner` — `warn` banner shown on a ledger↔chain mismatch; states the correction-toward-chain action and links to the journaled correcting entry (FR-10, UX-DR4); has a glyph + text (never color-only).
    - `StatCard` (KPI) — label + `display` figure + optional `DeltaIndicator` (the Group-NAV hero on the console).
  - (e) **A typed API client + live-data hooks (AC-2, AC-3):** `src/lib/api-client.ts` — a thin `fetch`-based client whose return types are the `@rose/api` **contract types** (`GroupViewResponse`, `CoupledPairResponse`, `RoseNoteResponse`, imported **`import type`** from `@rose/api`; nested shapes via indexed access — NO duplicate type definitions, single source = the Zod schemas). The base URL comes from `import.meta.env.VITE_API_BASE_URL` with a sensible local default — **no secret**. TanStack Query hooks (`useGroupView`, `useCoupledPair`) wrap it with a short refetch window driving the `LiveIndicator` freshness. The client is **injectable** so tests supply fixtures without network.
  - (f) **Covenant Console surface (AC-2, AC-4):** `src/surfaces/covenant-console/` — Group-NAV hero `StatCard`, per-entity balances table (entity → accounts), float yield + exposure derived from the group view, drill path group → entity → account → journal entry → tx hash with a **copy-tx-hash** affordance, the `DivergenceBanner` driven by `chainComparison.anyDivergence`, an `EntitySwitcher` scoping to one of `VCC`/`HOLDING`/`TRADING_CO`/`COIN_ISSUER`/consolidated, and **explicit loading (Skeleton) / empty / error (machine `code` + retry)** states.
  - (g) **Coupled-Pair surface (AC-3):** `src/surfaces/coupled-pair/` — live `V_A`, `V_B`, `K`, `floor`, `anchor (P₀)`, current `P`, holding, with `V_A + V_B = K` shown/derivable and **distance-to-floor** legible (`warn` when P nears floor); the lifecycle `StatusBadge` reflects live `state`; the `LiveIndicator` flips to stale beyond the refresh window; explicit loading/empty/error states. Reads from the group view's `coupledPairs[]` and/or `GET /coupled-pairs/:id`.
  - (h) **App shell + nav (AC-2/AC-3):** a left-nav + top-context-bar shell (TanStack Router) switching between the two surfaces, with the global `LiveIndicator`, the `EntitySwitcher`, and the light/dark toggle. Operator desktop, full-width dense tables (no `max-w` clamp).
- **OUT OF SCOPE (later / other regime — do NOT implement):**
  - **The Exchange/Trading view and the Subscriber surfaces are Story 6.6** — do NOT build them. 6.5 delivers the design system + shared components (which 6.6 reuses) + the two operator read surfaces only. Do NOT build the subscribe/redeem Confirm-action panel, the eligibility gate, or any write/mutation flow (6.6 / UX-DR6).
  - Do NOT change `@rose/api`/`@rose/ledger`/`@rose/reconcile`/any backend package source, the schema, migrations, or any Solidity (forge stays 171; migrations unchanged). The web package consumes the EXISTING contract; if a needed type is not exported, derive it via indexed access on an exported type rather than editing `@rose/api`.
  - Do NOT stand up a real API server, real auth, real RPC, or real polling against a deployed backend in this story; do NOT import the coupled-coin model or anything in `/throwaway`.
- **OUT OF SCOPE (ops, deferred — record in `deferred-work.md` story-6.5):** the deployed API base URL + CORS + session-based operator auth (architecture default), the live TanStack Query polling cadence against a running API, websocket/event-driven freshness off the chain watcher, the historical `mockups/` composition references. **NO secret, NO `.env`, NO placeholder.**

## Tasks / Subtasks

- [x] **Task 1 — Scaffold the `@rose/web` package + toolchain (AC: 1)**
  - [x] `prod/packages/web/package.json`: `name: "@rose/web"`, `private: true`, `type: "module"`. Scripts: `"build": "tsc -b && vite build"`, `"typecheck": "tsc -b"`, `"dev": "vite"`. Declare deps (see Task 7 for the exact set). Run the workspace install so `pnpm-lock.yaml` reflects every new external dep.
  - [x] `prod/packages/web/tsconfig.json`: extend `../../../tsconfig.base.json`; override `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`, `types: ["vite/client"]` (so `*.css`/`import.meta.env` resolve under `tsc`), `rootDir: "src"`, `outDir: "dist"`; `references: [{ "path": "../api" }]` (TYPE-only edge); `include: ["src/**/*.ts", "src/**/*.tsx"]`. Keep `composite: true` (inherited) so it joins the `tsc -b` solution.
  - [x] Add `{ "path": "prod/packages/web" }` to the root `tsconfig.json` `references` (last entry — it depends on `api`).
  - [x] `prod/packages/web/vite.config.ts`: `@vitejs/plugin-react` + `@tailwindcss/vite`. `prod/packages/web/index.html` + `src/main.tsx` + `src/vite-env.d.ts` (`/// <reference types="vite/client" />`).
  - [x] `prod/packages/web/src/index.css`: `@import "tailwindcss";` + the `@theme`/`:root`/`.dark` semantic token block (DESIGN.md tokens as CSS vars — rosé primary, gain/loss/warn/info, numeric/display font roles, the `table-cell-x/y` density, pill radius). **No raw hex in component classes.**

- [x] **Task 2 — Theme (light/dark) + `cn` util (AC: 1, 5)**
  - [x] `src/lib/cn.ts`: `cn(...)` = `twMerge(clsx(...))`.
  - [x] `src/components/theme-provider.tsx` + `src/components/theme-toggle.tsx`: toggle `dark` on `<html>`, persist to `localStorage`, default to `prefers-color-scheme`; the toggle is a keyboard-operable button with an `aria-label`. Co-located `theme-provider.test.tsx`: persists + reads the stored mode; toggling flips the class.

- [x] **Task 3 — Shared data-product components, test-first (AC: 1, 5) — the 6.6-reused vocabulary**
  - [x] `src/components/ui/money-cell.tsx` + `.test.tsx`: renders `decimal` (NOT `smallestUnits`) in tabular-mono right-aligned with asset symbol; never parses to `number`; `aria-label` includes value + asset + scale; long values do not truncate (no ellipsis class). Test: a large EUR amount renders the exact decimal string + "EUR"; the `aria-label` carries unit; renders `smallestUnits` only as a title/secondary, never as the displayed money.
  - [x] `src/components/ui/delta-indicator.tsx` + `.test.tsx`: positive ⇒ `▴` + gain class + `+` sign; negative ⇒ `▾` + loss class + `−`; zero ⇒ neutral, no color-only signal. Test asserts the glyph + sign are present (meaning never rests on color).
  - [x] `src/components/ui/status-badge.tsx` + `.test.tsx`: maps each of the six lifecycle states + `live`/`divergent`/`pending` to a token class **and** renders the label text; `role`/`aria-label` announces the state. Test asserts label text present for every state (never color-only).
  - [x] `src/components/ui/live-indicator.tsx` + `.test.tsx`: given `lastUpdated` + `refreshWindowMs`, fresh ⇒ gain pulse + "Live"; stale ⇒ warn + "Stale · last updated {time}"; freshness wrapped in `aria-live="polite"`. Test both branches with injected `now`.
  - [x] `src/components/ui/divergence-banner.tsx` + `.test.tsx`: renders the warn banner with the correction-toward-chain copy + a link to the correcting entry (href/onClick to the journal entry); has a glyph + text. Test: hidden when no divergence; shown with the entry link when diverged.
  - [x] `src/components/ui/stat-card.tsx` + `.test.tsx`: label + `display` figure + optional `DeltaIndicator`.
  - [x] (Author the minimal shadcn-pattern primitives actually needed — e.g. `Card`, `Table`, `Badge`, `Skeleton`, `Button` — in `src/components/ui/` using `cva` + `cn`. Keep the set minimal; no Radix unless a primitive truly needs it.)

- [x] **Task 4 — Typed API client + live-data hooks (AC: 2, 3)**
  - [x] `src/lib/api-client.ts`: `createApiClient({ baseUrl, fetchFn? })` returning `{ getGroupView(): Promise<GroupViewResponse>; getCoupledPair(id): Promise<CoupledPairResponse> }`. Types **`import type { GroupViewResponse, CoupledPairResponse, RoseNoteResponse } from '@rose/api'`** (single source = the Zod schemas). On a non-2xx, parse the `{ error: { code, message } }` envelope and throw a typed `ApiClientError` carrying the machine `code` (so surfaces can name the refusing rule, UX-DR5). `baseUrl` from `import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'` — **no secret**.
  - [x] `src/lib/queries.ts`: `useGroupView()` / `useCoupledPair(id)` TanStack Query hooks reading the injected client from context; short `refetchInterval` feeding `LiveIndicator` freshness. A `QueryClientProvider` + an `ApiClientProvider` in the app root.
  - [x] `src/lib/api-client.test.ts`: with an injected `fetchFn` (a fake `Response`), a 200 returns the typed body; a 4xx envelope throws `ApiClientError` with the `code`. **No network.**

- [x] **Task 5 — Covenant Console surface, test-first (AC: 2, 4, 5)**
  - [x] `src/surfaces/covenant-console/covenant-console.tsx`: Group-NAV hero `StatCard` (the consolidated `nav` per asset), a per-entity balances `Table` (entity → its `accounts[]` with `MoneyCell` net/debit/credit, NAV role), float yield (`FEE_INCOME`/`BACKING_FLOAT` derived) + exposure surfaced, the `DivergenceBanner` bound to `chainComparison`, the `EntitySwitcher`, and the drill affordance (row → account → entry → **copy-tx-hash**). Explicit **loading** (`Skeleton`), **empty** ("No balances yet."), **error** (inline machine `code` + retry) states.
  - [x] `src/surfaces/covenant-console/entity-switcher.tsx` (+ test): scopes to one entity or consolidated; keyboard-operable.
  - [x] `covenant-console.test.tsx`: render with a **fixture `GroupViewResponse`** (NOT network) wrapped in the providers — asserts the Group NAV hero figure (MoneyCell w/ unit), per-entity rows, the divergence banner shows when `anyDivergence`, the empty state when no entities, the error state when the query rejects with a coded error, and a copy-tx-hash control exists for an on-chain-backed entry. Use a fixture that satisfies the contract types.
  - [x] Fixtures: `src/test/fixtures.ts` — typed `GroupViewResponse`/`CoupledPairResponse` builders (shaped to the contract, reused across tests; the divergent + reconciled variants).

- [x] **Task 6 — Coupled-Pair surface, test-first (AC: 3, 5)**
  - [x] `src/surfaces/coupled-pair/coupled-pair.tsx`: renders `V_A`, `V_B`, `K`, `floor`, `anchor`, current `P`, holding via `MoneyCell`s; shows `V_A + V_B = K` (and flags if it does not balance); distance-to-floor with `warn` when near; the lifecycle `StatusBadge`; the `LiveIndicator` (stale beyond the window). Explicit loading/empty/error states.
  - [x] `coupled-pair.test.tsx`: render with a fixture active pair — asserts the leg values + K render with units, `V_A + V_B = K` is shown, the `ACTIVE` badge label, distance-to-floor present; a `REBALANCING` fixture shows that badge; a stale `lastUpdated` flips the live indicator to warn; empty state when no pair.

- [x] **Task 7 — Dependency declaration (AC: 1) — package.json + pnpm-lock.yaml**
  - [x] `dependencies`: `react@^18`, `react-dom@^18`, `@tanstack/react-query@^5`, `@tanstack/react-router@^1`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@rose/api: workspace:*` (TYPE-only consumer).
  - [x] `devDependencies`: `vite@^7` (or current stable compatible w/ Node 24), `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss@^4`, `@types/react@^18`, `@types/react-dom@^18`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`.
  - [x] Run `pnpm install` so the lockfile records every edge (workspace + external). **NO cycle** (`@rose/api` does not depend on `@rose/web`). `pnpm check:regime` stays green (web is /prod, imports only `@rose/api` + npm). Pin React to **18** (architecture: "React 18 + Vite").

- [x] **Task 8 — Wire the web tests into the root gate (AC: all)**
  - [x] `vitest.config.ts` (root): extend `include` to also match `prod/packages/**/*.test.tsx` (currently only `*.test.ts`). Give the web tests a **jsdom** environment — prefer a per-file `// @vitest-environment jsdom` pragma at the top of every `*.test.tsx` (leaves the existing node-env ledger tests untouched; `fileParallelism:false` is preserved). Register the `@testing-library/jest-dom` matchers by importing `@testing-library/jest-dom/vitest` at the top of each tsx test (or a tiny `src/test/setup.ts` imported per test file) — do **not** add a global `setupFiles` that would load into the node-env backend tests.
  - [x] Confirm `pnpm test` runs the web tests alongside the existing suite (baseline **Vitest 594** before this story → 594 + the new web tests). The web tests need **no Postgres** and **no network**.

- [x] **Task 9 — Boundary, docs, gates**
  - [x] `pnpm typecheck` (`tsc -b`) green with `@rose/web` referenced (the DOM/jsx/`vite/client` overrides resolve `.css` + `import.meta.env`); `pnpm lint` green (existing flat config already lints `prod/**/*.tsx` + the regime rule — keep components clean, no new eslint plugin); `pnpm format:check` green (prettier already globs `prod/packages/**/*.tsx` + the new `package.json`); `pnpm check:regime` green (no `/throwaway` import); `pnpm check:migrations` unchanged (no DB touch); `forge test` unchanged (171, no Solidity).
  - [x] Record the ops-deferred items in `deferred-work.md` (story-6.5 section): deployed API base URL + CORS + operator session auth; live polling cadence / websocket freshness; `mockups/` composition references. **NO secret, NO `.env`, NO placeholder.**
  - [x] Update `sprint-status.yaml` (6-5 transitions) + File List + Change Log. Touch NO other story. Confirm the two surfaces render **only live/fixture contract data — no hard-coded mockup figures** (FR-14).

### Review Findings (code-review 2026-06-16)

Three adversarial layers (Blind Hunter — diff-only; Edge Case Hunter — diff + project; Acceptance Auditor — diff vs ACs). 1 patch (applied), 5 deferred, 3 dismissed as noise.

- [x] [Review][Patch] Console KPI summed unlike-asset units — `sumNetByType` added `net.smallestUnits` across all accounts of a type regardless of asset/scale (would mix EUR+USD for a type spanning two assets). [prod/packages/web/src/surfaces/covenant-console/covenant-console.tsx:20] — FIXED: sum restricted to the dominant (first-match) asset+scale; regression test added (`derives a KPI in the dominant asset only`).
- [x] [Review][Defer] Full drill `journal entry → on-chain tx hash` (AC-2/UX-DR7) needs NEW `@rose/api` read endpoints — the contract serves group→entity→account only; the copy-tx-hash affordance ships + is tested. Recorded in `deferred-work.md` story-6.5 (6.5 is frontend-only, edits no backend).
- [x] [Review][Defer] Divergence banner's link to the journaled correcting entry (AC-4/FR-10) is wired to an optional id — the contract's divergence rows carry no correcting-entry id yet (same endpoint gap). Recorded in `deferred-work.md` story-6.5.
- [x] [Review][Defer] Current `P` on the Coupled-Pair surface is an optional live input (AC-3) — the contract serves only anchor `P₀`; shows "—" until a live tick (the 6.4 price-feed seam). Recorded in `deferred-work.md` story-6.5.
- [x] [Review][Defer] WCAG 2.2 AA full contrast audit of the shipped token hexes (AC-5) is a design-QA follow-up — structural a11y (labels/roles/keyboard/`aria-live`) is done; tokens are the DESIGN.md values. Recorded in `deferred-work.md` story-6.5.
- [x] [Review][Defer] Hero NAV + KPI cards show the dominant (first) asset only for a multi-asset entity/group — acceptable for the EUR-dominant P0; a per-asset breakdown is a 6.6/enhancement follow-up. Recorded in `deferred-work.md` code-review 2026-06-16.
- Dismissed (noise): `deriveFloorUnits` floors K/2 (odd K) + the final division — documented, matches the backend `deriveFloorUnits` convention; `useCoupledPair` disabled on empty id → "No active pairs." (intended); `api-client` default `globalThis.fetch` unbound — works in browser + undici.

## Dev Notes

### Architecture-mandated decisions (follow exactly)

- **The surfaces live in a NEW `prod/packages/web` package — React 18 + Vite + TS.** The architecture explicitly names `prod/packages/web/` with `src/surfaces/{covenant-console,coupled-pair,exchange-trading,subscriber}` as the home of FR-14. 6.5 creates the package + the design system + the first two operator surfaces; 6.6 adds exchange-trading + subscriber, reusing 6.5's components. [Source: architecture.md §Project Structure lines 320-322; §Requirements-to-Structure line 358; §Frontend Stack lines 180-181]
- **Stack: React 18 + Vite + TypeScript + TanStack Query (server-state) + TanStack Router (nav) + shadcn/ui-on-Tailwind.** Vite/SPA (not SSR) because these are internal, gated, data-dense surfaces. Generated/contract API types are shared from the backend (`@rose/api`). [Source: architecture.md lines 180-181; EXPERIENCE.md Foundation line 16, 25]
- **Design system = DESIGN.md tokens on shadcn/ui.** One brand color (rosé `#B12A66`/`#E85C97`) for **primary actions / active nav / brand marks ONLY — never data**. Financial semantics `gain`/`loss`/`warn`/`info` carry data and are **product-critical, not decorative**, always paired with a glyph. `numeric` = IBM Plex Mono tabular figures for **every** money/price/qty/leg-value; `display` = Geist Sans 28/600 for titles + the Group-NAV hero. Pill radius reserved for status badges. Both light + dark first-class, user-toggleable, persisted. Components reference **semantic tokens, never raw hex** (UX-DR1). [Source: DESIGN.md Colors lines 86-96; Typography lines 98-104; Components lines 120-135]
- **Money & numeric contract (UX-DR2, NFR-2) — the defining behavior.** Every figure: tabular mono, sourced from **decimal strings** carrying the asset's scale (EUR=2, BTC=8, token=`decimals()`), **never** a JS `number`/float — the UI formats from the string, never does float math. Right-aligned; asset symbol per cell/column; deltas = sign + glyph + semantic color; leg values show `V_A`, `V_B`, `K` with `V_A + V_B = K` derivable + `floor`/`anchor`/`P` together so distance-to-floor is glanceable; **truncation forbidden on monetary values**. [Source: EXPERIENCE.md Money & Numeric Display lines 57-66]
- **Live data & consistency states (UX-DR4).** Every surface defines **loading / empty / error** explicitly + the product consistency states: **stale** (live indicator → warn + "last updated"), **pending on-chain tx**, **ledger↔chain divergence** (the warn banner + link to the correcting entry, FR-10). API errors surface the machine `code` from `{ error: { code, message } }` + retry — never a blank surface, never a swallowed refusal (NFR-4). [Source: EXPERIENCE.md State Patterns lines 84-97; DESIGN.md divergence-banner / live-indicator]
- **Drill + audit trail (UX-DR7).** group → entity → account → journal entry → on-chain tx hash, with a copy-tx-hash affordance on any on-chain entry. Pagination, never infinite scroll. [Source: EXPERIENCE.md IA line 36, Interaction Primitives line 104]
- **Accessibility floor (UX-DR8).** WCAG 2.2 AA both modes; **no color-only signaling** (glyph/label always accompanies color); money announced with unit + scale, status badges announce the lifecycle state, the live indicator announces freshness via `aria-live`; full keyboard operability; focus rings visible at AA. [Source: EXPERIENCE.md Accessibility Floor lines 111-119; DESIGN.md Do/Don't]
- **Operator layout.** Desktop ≥1280px, full-width dense tables (NO `max-w` clamp), persistent left nav + top context bar (entity/group switcher, global live indicator, light/dark toggle). The Subscriber responsive form-factor is 6.6. [Source: DESIGN.md Layout lines 106-110; EXPERIENCE.md Responsive lines 122-126]
- **Naming.** React components `PascalCase.tsx`; files otherwise `kebab-case.ts(x)`; types `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. [Source: architecture.md line 222]

### The contract this surface consumes (the single source — `@rose/api`)

- **READ endpoints (paper/local, Stories 6.1/5.5):** `GET /group-view` → `GroupViewResponse` (FR-9: `generatedAt`, `source` `ledger-only`|`ledger+chain`, `entities[]` with `accounts[]` (`net`/`totalDebit`/`totalCredit` as `Money`, `navRole`, `normalSide`) + `byAsset[]` subtotals (`assets`/`liabilities`/`equity`/`nav`), `consolidated[]` (per-asset NAV + `balanced`), `coupledPairs[]` (`id`, `state`, `anchorPrice`, `leverage`, `floor`, `longLegValue`, `shortLegValue`, `collateralPool`, `noteId`), `chainComparison` (`source`, `divergences[]` with `ledgerQuantity`/`onChainTotalSupply`/`divergence`/`diverged`, `anyDivergence`), `notes[]`). `GET /coupled-pairs/:id` → `CoupledPairResponse`. `GET /rose-notes/:id` → `RoseNoteResponse`. [Source: prod/packages/api/src/schemas.ts; routes/{group-view,coupled-pairs,rose-notes}.ts]
- **`Money` wire shape (NFR-2):** `{ asset: string; scale: number; smallestUnits: string; decimal: string }` — `MoneyCell` renders `decimal` + `asset`; `scale` is metadata; both string forms derive from ONE server-side `bigint`. The client NEVER sees a JS number money value. [Source: schemas.ts MoneySchema lines 62-73]
- **Type sharing — single source, no duplication.** `@rose/api` exports `GroupViewResponse`, `CoupledPairResponse`, `RoseNoteResponse` (all `z.infer` of the Zod schemas). Import them **`import type`** (erased under `verbatimModuleSyntax` ⇒ zero bundle/runtime cost, the type-only edge keeps Fastify out of the browser bundle). Derive nested shapes via indexed access (e.g. `GroupViewResponse['entities'][number]`, `['coupledPairs'][number]`, `['chainComparison']['divergences'][number]`) — do **not** redefine them and do **not** edit `@rose/api` to export more. [Source: api/src/index.ts exports; schemas.ts `GroupViewResponse`; serializers.ts `CoupledPairResponse`/`RoseNoteResponse`]
- **Error envelope (UX-DR5):** `{ error: { code, message, details? } }` with a specific machine `code` (403 authorization, 422 domain, 409 conflict, 400 validation, 404 not found, 503 refuse-if-absent). The client parses it into a typed `ApiClientError` so the surface can name the refusing rule. [Source: schemas.ts ErrorResponseSchema; api/src/errors.ts]

### Toolchain integration risks (resolve these precisely — the gate must stay green)

- **Vitest `.tsx` + jsdom.** The root `vitest.config.ts` `include` is `prod/packages/**/*.test.ts` (ONLY `.ts`) and the default env is node (the ledger tests need node + Postgres). Add `prod/packages/**/*.test.tsx` to `include`, and give ONLY the tsx tests jsdom via a per-file `// @vitest-environment jsdom` pragma (do NOT switch the global env, do NOT add a global `setupFiles` that loads into the node backend tests). Register jest-dom matchers by importing `@testing-library/jest-dom/vitest` at the top of each tsx test (or a local `src/test/setup.ts` imported per file). Keep `fileParallelism:false`. [Source: vitest.config.ts; Story 6.4 testing notes]
- **`tsc -b` for a Vite app.** Keep the package `composite` and referenced from the root solution config so `pnpm typecheck` covers it like every other package. Override `lib` (+DOM, +DOM.Iterable), `jsx: react-jsx`, and `types: ["vite/client"]` so `tsc` resolves `*.css` imports + `import.meta.env`. Add `src/vite-env.d.ts`. The tsc `dist` emit is a typecheck artifact only — Vite does the real bundling; gitignore `dist` (already pruned by the regime/skip lists). `verbatimModuleSyntax` + `isolatedModules` are inherited and work with the `react-jsx` runtime. [Source: tsconfig.base.json; api/tsconfig.json pattern; tsconfig.json root references]
- **ESLint + Prettier already cover `.tsx`.** The flat config globs `prod/**/*.{ts,tsx,mts,cts}` (regime rule) + `tseslint.configs.recommended` (TS rules) — `.tsx` is linted with no new plugin (don't add `eslint-plugin-react` unless a recommended-rule failure forces it; prefer clean code). Prettier already globs `prod/packages/**/*.{ts,tsx}`. Format the new `package.json`/configs. [Source: eslint.config.js lines 26-41; package.json format scripts]
- **shadcn without the registry.** Do NOT rely on the shadcn CLI fetching its registry at build (hermetic build). Hand-author the small primitive set in `src/components/ui/` following shadcn conventions (`cva` + `cn`); the runtime deps are just `class-variance-authority` + `clsx` + `tailwind-merge`. Tailwind v4 via `@tailwindcss/vite` + a single `@import "tailwindcss"` CSS entry with the `@theme`/`.dark` token block. This is consistent with DESIGN.md (shadcn is copy-in, not a runtime dep). [Source: DESIGN.md line 84 "inherits shadcn defaults … specifies the delta"]

### Reuse — do NOT reinvent

- **`@rose/api`** — the contract types (`GroupViewResponse`/`CoupledPairResponse`/`RoseNoteResponse`) + the error-envelope shape. TYPE-only import. The only `@rose/*` edge `@rose/web` takes. [Source: api/src/index.ts]
- **TanStack Query** — ALL server-state/live-data fetching + refetch/freshness (do not hand-roll a fetch-cache). **TanStack Router** — nav between the surfaces. [Source: EXPERIENCE.md line 16, 25]
- **Tailwind tokens** — the DESIGN.md semantic tokens as CSS vars; reference token classes, never raw hex.
- Do NOT import `/throwaway/mockups/*.html` — they are historical inspiration only (NEVER imported); the surfaces are functional on live/fixture contract data.

### Files being created / modified

- NEW package `prod/packages/web/`: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/vite-env.d.ts`, `src/index.css`.
- NEW `src/lib/{cn.ts, api-client.ts, api-client.test.ts, queries.ts}`.
- NEW `src/components/{theme-provider.tsx, theme-toggle.tsx, theme-provider.test.tsx}`.
- NEW `src/components/ui/{money-cell,delta-indicator,status-badge,live-indicator,divergence-banner,stat-card}.tsx` (+ co-located `.test.tsx`) and the minimal primitives (`card`,`table`,`badge`,`skeleton`,`button`).
- NEW `src/surfaces/covenant-console/{covenant-console.tsx, entity-switcher.tsx, *.test.tsx}` and `src/surfaces/coupled-pair/{coupled-pair.tsx, *.test.tsx}`.
- NEW `src/test/{fixtures.ts, setup.ts?}`; the app shell (`src/app.tsx` + router).
- MODIFY root `tsconfig.json` (add the `web` reference), root `vitest.config.ts` (add `*.test.tsx` to `include`), `pnpm-lock.yaml` (new deps).
- MODIFY `_bmad-output/implementation-artifacts/deferred-work.md` (story-6.5 ops section) + `sprint-status.yaml` (6-5 transitions). Touch NO other story.
- NO change to any backend package source, schema, migrations, or Solidity (forge 171, migrations unchanged).

### Testing standards summary

- **Vitest** (`vitest run`), tests co-located `*.test.tsx`/`*.test.ts`; jsdom env for tsx via per-file pragma; `@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event`. Test-first on the data-product invariants: money rendered from the **decimal string** (never `number`), unit + scale always shown, no truncation, deltas glyph+sign (never color-only), every status badge label-bearing, the live indicator stale-flip, the divergence banner shows + links the correcting entry, the console loading/empty/error states + copy-tx-hash, the coupled-pair `V_A+V_B=K` + distance-to-floor + lifecycle badge, the API client typed-error parsing.
- **LOCAL only — no Sepolia, no API server, no network port, no secret.** Surfaces are exercised against **typed fixture data** shaped by the `@rose/api` contract types (the client is injectable; tests never fetch). The data is "live" in the sense that the surfaces consume the real contract — proven against fixtures in test, against the paper/local API at runtime.
- Baseline to preserve: **Vitest 594**, **forge 171**, **migrations** unchanged (no DB touch, no Solidity). The new web tests add to the Vitest count; no test requires Postgres.

### Project Structure Notes

- New package `@rose/web` under `prod/packages/web` (the architecture-named FR-14 home). The ONLY new `@rose/*` edge is `@rose/web → @rose/api` (TYPE-only, no cycle). Regime boundary: PROD only; no `/throwaway` import (the `mockups/*.html` are NOT imported). `pnpm check:regime` + the eslint `no-restricted-imports` rule backstop this. The package joins the `tsc -b` solution (root reference) and the root Vitest run (`.test.tsx` include).

### Anti-patterns to avoid (disaster prevention)

- Do NOT render money from `smallestUnits` parsed to a `number` or do float math in the client — render the `decimal` string; `scale`/`asset` are metadata (NFR-2, UX-DR2).
- Do NOT signal any state by color alone — gain/loss carry a glyph + sign; status badges + the divergence banner carry a label (UX-DR8, WCAG AA).
- Do NOT truncate/ellipsize monetary values — wrap or widen the column.
- Do NOT use the rosé brand color for data/deltas/status — brand color is primary action / active nav / brand mark ONLY.
- Do NOT hard-code mockup figures or import `/throwaway/mockups` — surfaces are functional on live/fixture contract data (FR-14).
- Do NOT duplicate the contract types — import them `import type` from `@rose/api`; derive nested shapes by indexed access; do NOT edit `@rose/api`.
- Do NOT take a runtime (value) import on `@rose/api` (it pulls Fastify) — TYPE-only so it is erased from the browser bundle.
- Do NOT build the Exchange/Trading or Subscriber surfaces, the subscribe/redeem write flow, the eligibility gate, or any mutation — that is Story 6.6.
- Do NOT add a global Vitest `setupFiles` or switch the global env to jsdom — it would break the node-env Postgres-backed backend tests; scope jsdom to the tsx tests by per-file pragma.
- Do NOT create any `.env`/secret/placeholder API URL/RPC/key — the base URL is an env var with a local default; real ingress is ops-deferred.
- Do NOT change any backend package, schema, migration, or Solidity.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-6.5 (lines 773-802); Epic 6 overview + UX contracts (lines 696-700); UX-DR coverage (line 149); FR-14 (line 60), FR-9, FR-6, FR-4, FR-10]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/DESIGN.md — Colors (86-96), Typography (98-104), Layout (106-110), Components (120-135), Do/Don't (138-147), token frontmatter (10-76)]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/EXPERIENCE.md — Foundation (18-25), IA (27-41), Money & Numeric (57-66), Component Patterns (68-81), State Patterns (84-97), Interaction Primitives (99-109), Accessibility (111-119), Responsive (122-126)]
- [Source: _bmad-output/planning-artifacts/architecture.md — Frontend Stack (180-181), Project Structure (291-333, esp. 320-322), Requirements-to-Structure (358), Data Flow (365), naming (222)]
- [Source: prod/packages/api/src/schemas.ts (GroupViewSchema, MoneySchema, CoupledPairSchema, ErrorResponseSchema, CoupledPairStateSchema); src/index.ts (exports); src/serializers.ts (CoupledPairResponse/RoseNoteResponse); src/routes/{group-view,coupled-pairs,rose-notes}.ts (endpoint paths)]
- [Source: vitest.config.ts; tsconfig.base.json; tsconfig.json (root references); eslint.config.js; package.json (gate scripts); tools/check-regime-boundary.mjs]
- [Source: _bmad-output/implementation-artifacts/6-4-*.md — the previous-story patterns (paper/local, refuse-if-absent, no secret, deferred-work discipline)]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- The two operator surfaces are proven LOCALLY (Vitest + jsdom + `@testing-library/react`) against TYPED fixture data shaped by the `@rose/api` contract — NO running API server, NO network, NO Sepolia, NO secret. The `ApiClient` is injectable; container tests render with a `QueryClientProvider` + `ApiClientProvider` returning fixtures (reconciled / divergent / empty group views; ACTIVE / REBALANCING pairs). Freshness/stale branches are deterministic via an injected `now`.
- Toolchain integration: the root `vitest.config.ts` `include` gained `prod/packages/**/*.test.tsx`; jsdom is scoped to the tsx tests via a per-file `// @vitest-environment jsdom` pragma (the node-env, Postgres-backed backend tests are untouched — no global `setupFiles`/`globals` change). A local `src/test/setup.ts` (imported per tsx test) registers the jest-dom matchers + a per-test RTL `cleanup`. The web package joins the `tsc -b` solution (root reference) with `lib:[DOM]`, `jsx:react-jsx`, `types:[vite/client]` so `tsc` resolves `.css`/`import.meta.env`.
- Test fixtures: K=20000 ⇒ K/2=10000; floor f=0.6 ⇒ derived `floorUnits=6000` (matches the 6.4 backend fixture). ACTIVE pair legs 10000/10000 ⇒ distance-to-floor 4000; REBALANCING legs 5000/15000 ⇒ distance −1000 (breached, warn). Group NAV € 12,480,330.00 renders from the decimal string with unit + scale.

### Completion Notes List

- **AC-1 (design system + shared data-product components, both modes):** NEW `@rose/web` (React 18 + Vite + TS) carries the DESIGN.md tokens as semantic CSS vars (rosé `--primary` for brand/actions ONLY; `--gain`/`--loss`/`--warn`/`--info` for data; `numeric` tabular-mono + `display` type roles; pill radius) mapped into Tailwind v4 via `@theme inline` so utilities follow the persisted light/dark toggle (`ThemeProvider` flips `.dark` on `<html>`, persisted to `localStorage`, defaults to system pref). The shared, TDD'd components — `MoneyCell`, `DeltaIndicator`, `StatusBadge` (six lifecycle + live/divergent/pending), `LiveIndicator`, `DivergenceBanner`, `StatCard` — reference token classes only (no raw hex). Every figure renders in tabular mono FROM the decimal string (never `number`/float, NFR-2), asset symbol shown, right-aligned, no truncation, deltas sign + glyph + color.
- **AC-2 (Covenant Console live):** live group NAV hero (`StatCard`), per-entity balances table, float yield (`FEE_INCOME`) + exposure (`DEPLOYED_CAPITAL`) derived exactly from the group view (BigInt smallest-units sums), the `EntitySwitcher` (consolidated + four entities), the `DivergenceBanner` bound to `chainComparison.anyDivergence`, and the drill (account row → its postings) with a **copy-tx-hash affordance** (`CopyTxHash`). Explicit loading (`Skeleton`) / empty ("No balances yet.") / error (machine `code` + retry) states. The deepest drill levels (journal-entry detail + on-chain tx hash) await NEW `@rose/api` read endpoints — recorded in `deferred-work.md` story-6.5 (6.5 is frontend-only, edits no backend).
- **AC-3 (Coupled-Pair live):** renders `V_A`, `V_B`, `K`, `floor` (+ derived `floorUnits`), `anchor (P₀)`, `leverage`, current `P` (optional live input), with the `V_A + V_B = K` invariant shown and exact BigInt distance-to-floor (warn near/breached). The lifecycle `StatusBadge` reflects the live `state`; the `LiveIndicator` flips to stale beyond the refresh window. Loading/empty/error states. NO hard-coded mockup figures — fixture/live contract data only.
- **AC-4 (divergence banner):** `DivergenceBanner` shows ONLY on `anyDivergence`, states the correction-toward-chain action, names the diverged asset(s), and exposes a "View entry" link (`onViewEntry`/`correctingEntryId`). The UI signals; it never corrects (that is `@rose/reconcile`). Resolving the link to the actual FR-10 correcting entry needs the same entry-detail endpoint (deferred).
- **AC-5 (accessibility floor):** no color-only signaling (gain/loss carry glyph + sign; badges + banner carry labels); `MoneyCell` announces value + unit + scale via `aria-label`; `StatusBadge` announces the lifecycle state (`role="status"`); the `LiveIndicator` uses `aria-live="polite"`; controls (theme toggle, entity switcher, drill rows, copy) are keyboard-operable buttons with `aria-label`/`aria-pressed`/`aria-expanded`; focus rings via the `ring` token. (Full WCAG 2.2 AA contrast audit of the shipped token hexes is a design-QA follow-up; tokens are the DESIGN.md-specified values.)
- **Single-source contract types (no duplication):** the surfaces import `GroupViewResponse`/`CoupledPairResponse`/`RoseNoteResponse` `import type` from `@rose/api` (fully erased under `verbatimModuleSyntax` ⇒ NO runtime edge, NO Fastify in the browser bundle); nested shapes via indexed access. ONE minimal, additive, TYPE-ONLY change to `@rose/api`: a re-export of `GroupViewResponse` (it was defined in `schemas.ts` but not re-exported from the package root) — runtime-inert, keeps the Zod schema the single source. No other backend change.
- **Scope discipline:** Exchange/Trading + Subscriber surfaces, the subscribe/redeem write flow, the eligibility gate, and any mutation are Story 6.6 — NOT built. Full TanStack Router URL routing was dropped in favor of a lightweight, fully-functional in-app nav (both surfaces openable + keyboard-operable) to keep the gate hermetic — recorded as a thin non-blocking follow-up in `deferred-work.md`. NO `.env`, NO secret, NO placeholder created; the API base URL is an env var with a local default.
- **Gates (LOCAL, paper — no Sepolia):** `pnpm test` **632 passed** (594 baseline + 38 new web tests, NO Postgres/network needed for the web tests); `pnpm typecheck` green (web joins `tsc -b`); `pnpm lint` green (existing flat config lints `.tsx` + the regime rule, no new plugin); `pnpm format:check` green; `pnpm check:regime` green (no `/throwaway` import); `pnpm check:migrations` 7 reversible (no DB touch); `forge test` **171 passed** (no Solidity touched).

### File List

**New package `prod/packages/web/`:**

- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- `src/main.tsx`, `src/app.tsx`, `src/vite-env.d.ts`, `src/index.css`
- `src/lib/cn.ts`, `src/lib/contract-types.ts`, `src/lib/api-client.ts`, `src/lib/api-client.test.ts`, `src/lib/queries.ts`, `src/lib/pair-math.ts`, `src/lib/pair-math.test.ts`
- `src/components/theme-provider.tsx`, `src/components/theme-provider.test.tsx`, `src/components/theme-toggle.tsx`
- `src/components/ui/button.tsx`, `card.tsx`, `table.tsx`, `skeleton.tsx`
- `src/components/ui/money-cell.tsx` (+`.test.tsx`), `delta-indicator.tsx` (+`.test.tsx`), `status-badge.tsx` (+`.test.tsx`), `live-indicator.tsx` (+`.test.tsx`), `divergence-banner.tsx` (+`.test.tsx`), `stat-card.tsx` (+`.test.tsx`), `copy-tx-hash.tsx` (+`.test.tsx`)
- `src/surfaces/covenant-console/covenant-console.tsx` (+`.test.tsx`), `entity-switcher.tsx` (+`.test.tsx`)
- `src/surfaces/coupled-pair/coupled-pair.tsx` (+`.test.tsx`)
- `src/test/setup.ts`, `src/test/fixtures.ts`

**Modified (root + backend type-only):**

- `tsconfig.json` (add the `web` solution reference)
- `vitest.config.ts` (add `prod/packages/**/*.test.tsx` to `include`)
- `pnpm-lock.yaml` (new web deps + the workspace edge)
- `prod/packages/api/src/index.ts` (additive TYPE-ONLY re-export of `GroupViewResponse`)
- `_bmad-output/implementation-artifacts/deferred-work.md` (story-6.5 ops + backend-endpoint deferrals)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (6-5 → review)

## Change Log

| Date       | Change                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 2026-06-16 | Story 6.5 implemented: NEW `@rose/web` (React 18 + Vite + Tailwind v4) — design system + shared data-product components + Covenant Console + Coupled-Pair surfaces on live `@rose/api` data. 38 web tests (LOCAL, no network). Gates: Vitest 632, forge 171, migrations 7. Status → review. |
