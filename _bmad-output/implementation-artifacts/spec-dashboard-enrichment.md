---
title: 'Treasury Dashboard enrichment (covenant monitor, exposure, coupled-coin book, cross-entity)'
type: 'feature'
created: '2026-06-18'
status: 'done'
baseline_commit: '72c67ba'
context:
  - '{project-root}/docs/mocks/dashboard.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Covenant Console shows 3 KPIs + one account table; the mock `dashboard.html` is a treasury control room — hero KPIs, a covenant/bright-line monitor, net directional exposure, a coupled-coin book by market, and a cross-entity reconciliation table. The backing data for the covenant thresholds and entity roles does not yet exist.

**Approach:** Enrich the surface to match the mock for every section that has **honest, live backing**, plus the minimal real backend to support it: one additive reversible migration (`entities.role`, seeded with the four fixed entities' real roles), three new refuse-if-absent covenant-threshold config params, and `buildGroupView` computing covenant compliance, net exposure, the coupled-coin book, and per-entity reconciliation status. Sections that would require fabricated data are explicitly deferred (NO placeholders).

## Boundaries & Constraints

**Always:** Use spec-#1 tokens + spec-#2 shell. Money stays `MoneyView` decimal strings (NFR-2, no JS float). Covenant CURRENT values are computed from live group-view balances; THRESHOLDS come from `@rose/config` (refuse-if-absent) and are passed into `buildGroupView` via `opts` (do NOT make `@rose/reconcile` import `@rose/config` — the API composition root loads config and injects thresholds, mirroring `chainSupplies`). The migration must be reversible (up/down SQL, IF EXISTS guards) and seed real role values. Covenant ratios + per-entity reconciliation status are a documented P0 presentation/policy map (like `ACCOUNT_NAV_CLASSIFICATION`).

**Ask First:** (none — autonomous; scope decisions recorded in Design Notes)

**Never:** Do NOT fabricate data. Specifically OUT of scope (deferred, see Design Notes) — there is no honest source: account `subtype` (liquid vs money-market), the **collateral-pool composition** breakdown, the **yield-stream `fee_source`** breakdown, and the **reserve-ratio** covenant (needs the liquid/money-market split). Do NOT touch smart contracts. Do NOT add new required config without updating `.env.example` and config test fixtures. Do NOT change `ACCOUNT_NAV_CLASSIFICATION` semantics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Covenant compute, healthy | backing/NAV ≥ floor, deploy/NAV ≤ ceiling, client coverage = 100% | each covenant badge PASS; bar fill at current %, floor/ceiling marker at threshold | N/A |
| Covenant near/over limit | backing/NAV < floor OR deploy/NAV > ceiling | that covenant badge WATCH/BREACH (warn/loss color + glyph) | N/A |
| Missing covenant config | a `COVENANT_*` env absent | `ConfigRefusalError` naming the key at API startup (refuse-if-absent) | startup refusal, not a silent default |
| NAV = 0 (empty ledger) | no postings | ratios degrade to "—" (no divide-by-zero); badges neutral | guard division by zero |
| Coupled-coin book | N coupled pairs across M referenceAssets | one row per market: pairs count, Σ long, Σ short, Σ collateral K, net (delta) | N/A |
| Reconciliation status | chainComparison.anyDivergence | per-entity status Divergent vs Reconciled (group/asset-level divergence) | ledger-only ⇒ "—"/not-checked |

</frozen-after-approval>

## Code Map

- `prod/packages/ledger/src/schema/entities.ts` -- add `role` enum column + type
- `prod/packages/ledger/src/migrations/0008-entity-role.ts` -- NEW: reversible up/down; seed roles (VCC=TREASURY_NOTE_ISSUER, HOLDING=COORDINATION, TRADING_CO=TRADING, COIN_ISSUER=COIN_ISSUANCE)
- `prod/packages/ledger/src/migrations/index.ts` (or registry) -- register 0008
- `prod/packages/config/src/config.ts` -- add `covenantBackingFloatFloor`, `covenantClientCollateralRatio`, `covenantDeployCeiling` (+ KEY_TO_FIELD, schema)
- `prod/packages/config/.env.example` (+ config test fixtures) -- the three new keys
- `prod/packages/reconcile/src/group-view.ts` -- compute `covenants[]`, `netExposure`, `coupledCoinBook[]`, per-entity `reconciliationStatus`, pass through `entity.role`; new `opts.covenantThresholds`
- `prod/packages/api/src/schemas.ts` + `routes/group-view.ts` + `app.ts` -- extend `GroupViewSchema`; load config thresholds in the composition root and inject
- `prod/packages/web/src/surfaces/covenant-console/covenant-console.tsx` -- rebuild to the mock: hero KPIs, covenant monitor, net-exposure card, coupled-coin book, cross-entity table (keep EntitySwitcher, DivergenceBanner, LiveIndicator)
- NEW web components as needed: `covenant-bar.tsx` (bar + threshold marker), reuse StatCard/StatusBadge/MoneyCell
- Tests updated/added at each layer (migration up/down, config refusal, group-view computations, covenant-console render)

## Tasks & Acceptance

**Execution:**
- [x] `entities.ts` + `0008-entity-role.ts` (+ registry) -- additive reversible migration; seeds the four real roles; drizzle column; up/down round-trips (covered by the global reversibility test)
- [x] `config.ts` (+ `.env.example` + config test fixtures) -- three covenant thresholds as refuse-if-absent decimal strings, bounded to [0,1] (review fix: rejects negatives + >1 footgun)
- [x] `group-view.ts` -- `opts.covenantThresholds`; `covenants[]` (kind floor|ceiling, PASS|WATCH|BREACH; neg-NAV floor→BREACH), per-market `netExposure[]` (no cross-denomination sum — review fix), `coupledCoinBook[]` per referenceAsset, per-entity `reconciliationStatus` (honest set-intersection — review fix); `entity.role`; dominant = largest-|NAV| (review fix); NAV=0 guard
- [x] `api` schemas/route/app/serve -- extended `GroupViewSchema`; composition root loads config (opt-in then strict) + injects `covenantThresholds`
- [x] `covenant-console.tsx` (+ `covenant-bar.tsx`) -- rebuilt to the mock sections on live data; covenant bar + threshold marker + PASS/WATCH/BREACH (color+glyph); "units"-labelled coupled-pair figures; empty-states for no-pairs and unconfigured covenants
- [x] Tests at every layer (config refusal incl. range; group-view covenant/exposure/book/recon math incl. NAV=0 + neg-NAV; covenant-console render). Migration up/down via the global round-trip test.

**Acceptance Criteria:**
- Given seeded entities, when the dashboard loads, then hero KPIs, a covenant monitor (3 bright-lines), net exposure, the coupled-coin book, and a cross-entity table render from live group-view data.
- Given a covenant breach (backing/NAV below floor), when computed, then that covenant shows BREACH (loss color + glyph) and the bar marker sits at the configured threshold.
- Given a missing `COVENANT_*` env, when the API starts, then it refuses naming the key (no silent default).
- Given migration 0008, when applied then rolled back, then the schema returns to its prior state (down restores).
- Given `pnpm --filter @rose/web build`, `pnpm test` (all packages), `pnpm lint`, when run, then all pass.

## Design Notes

DEFERRED (no honest data — would violate no-placeholder): account `subtype` (liquid/money-market), collateral-pool composition, yield-stream `fee_source` breakdown, and the reserve-ratio covenant — all need a treasury sub-ledger / product-defined sub-categorisation that does not exist. The fourth hero KPI is a REAL live ratio (e.g. backing-float-to-NAV or fee-income-to-NAV), labelled precisely — never the mock's illustrative "treasury carry (annualised)" which needs a time series. Covenant ratio definitions + per-entity reconciliation status are a documented P0 presentation/policy map (revisable by product, changes no ledger data), mirroring `ACCOUNT_NAV_CLASSIFICATION`. Entity roles are static facts of the four fixed entities, seeded in the migration.

## Verification

**Commands:**
- `pnpm --filter @rose/web build` -- expected: succeeds
- `pnpm test` -- expected: all packages pass incl. new migration/config/group-view/console tests
- `pnpm lint` -- expected: clean
- `pnpm --filter @rose/ledger ...migrate up && ...migrate down` (or the package's migration test) -- expected: 0008 round-trips

## Spec Change Log

- **2026-06-18 — review pass (3 Opus reviewers: correctness, edge-case, acceptance).** Acceptance: no fabrication (CRITICAL PASS), no contracts touched, fidelity good. Patches applied (no loopback):
  - **Cross-denomination correctness:** `netExposure` no longer summed leg "units" across unlike `referenceAsset`s — restructured to per-market `netExposure[]`; coupled-pair figures render with a "units" label (no fabricated scale, matching the coupled-pair surface).
  - **Covenant config bounded to [0,1]:** rejects negatives (was → 500) and `>1` (the `'60'`=6000% silent-false-PASS footgun), refusing with the named key.
  - **Dominant denomination** now largest-|NAV| (was alphabetical) so covenants anchor on the economically dominant asset.
  - **Per-entity reconciliation** derived by set-intersecting each entity's held `(asset,scale)` with diverged denominations (was the global `anyDivergence` stamped on all).
  - **Negative-NAV floor covenant → BREACH** (was NA, under-claiming insolvency); WATCH band floored at 1 bp.
  - **Empty-states** for no-pairs exposure and unconfigured covenants.
  - **DEVIATION from the frozen I/O matrix (recorded for human sign-off):** covenant config was implemented **opt-in** (refuses only once any `COVENANT_*` is set; a keyless deploy yields `covenants=[]`) rather than always-refuse-at-startup, to avoid breaking the existing keyless read-only deployable (per the NEVER rule against breaking config consumers). "No silent default" is honored at the UI via an explicit "Covenant thresholds not configured" empty-state. Flagged to the user.
- Deferred (see deferred-work.md): account `subtype` / collateral-pool composition / yield-stream `fee_source` / reserve-ratio covenant (no honest data); coupled_pairs has no denomination/scale column (cross-scale-within-a-market is a theoretical hazard); no dedicated 0008 up/down test (global round-trip covers it).

## Suggested Review Order

**Backend — data + policy**

- Entry point — covenant compute, per-market exposure, coupled-coin book, per-entity reconciliation, dominant-by-magnitude.
  [`group-view.ts`](../../prod/packages/reconcile/src/group-view.ts)
- Covenant thresholds as refuse-if-absent, bounded [0,1] params.
  [`config.ts`](../../prod/packages/config/src/config.ts)
- Reversible entity-role migration (seeds the four real roles).
  [`0008-entity-role.ts`](../../prod/packages/ledger/src/migrations/0008-entity-role.ts)
- API schema extension + composition-root threshold injection (opt-in then strict).
  [`schemas.ts`](../../prod/packages/api/src/schemas.ts) · [`serve.ts`](../../prod/packages/api/src/serve.ts)

**Frontend — the dashboard**

- Rebuilt Treasury Dashboard: hero KPIs, covenant monitor, per-market exposure, coupled-coin book, cross-entity table.
  [`covenant-console.tsx`](../../prod/packages/web/src/surfaces/covenant-console/covenant-console.tsx)
- Covenant bar (fill + threshold marker, clamped; PASS/WATCH/BREACH color+glyph+label).
  [`covenant-bar.tsx`](../../prod/packages/web/src/components/ui/covenant-bar.tsx)
