---
baseline_commit: ce822369fecd5481a69f6ebde7a41a5543247999
---

# Story 9.5: Operator control panel for production-like events

Status: done

## Story

As a demo operator,
I want a control panel to inject production-like events on demand,
So that prod-state handling (latency, failure, covenant breach, reconciliation divergence) is
demonstrable live (FR-32).

## Acceptance Criteria

**Given** `faithful` mode and the operator surface
**When** the operator injects a confirmation **latency** or forces a **failure** on the next flow
**Then** the demo exhibits the Story-9.1 delayed-commit / compensated-failure behaviour for that flow

**Given** the operator panel
**When** the operator triggers a **covenant breach** or a deliberate **position↔pair reconciliation divergence**
**Then** the corresponding surface shows the real BREACH / reported-and-corrected behaviour (reusing the
Epic-5/Epic-8.5 reconcile-and-correct path), journaled and surfaced — never a silent change

**Given** a non-`faithful` / read-only deployment
**When** the operator endpoints are called
**Then** they return the typed "not available on this deployment" refusal (503), consistent with the
existing paper-gated routes

## Tasks / Subtasks

- [x] Expose the Story-9.1 confirmation-settings store via an operator API (GET/PUT, validated,
      fail-closed, 503 when not faithful) — mirror `routes/simulation.ts`.
- [x] Covenant-breach injection: an in-memory override (`FaithfulCovenantOverrideStore`) the REAL
      `@rose/reconcile` group-view covenant computation consults in faithful mode (`forceCovenantBreach`)
      so the monitor genuinely reports BREACH; clearable.
- [x] Reconcile-divergence injection: an in-memory toggle (`FaithfulReconcileInjectionStore`) so the
      NEXT `POST /positions/reconcile` reports-and-corrects a divergence through the REAL Story-8.5
      reconcile-and-correct path (journaled + surfaced); clearable. Plan built by
      `buildInjectedDivergencePlan` (`@rose/positions`).
- [x] Operator routes (`routes/operator.ts`) + ApiDeps wiring + faithful composition in `serve.ts`.
- [x] Operator web surface (`surfaces/operator/operator-panel.tsx`), OPERATOR-role-gated in `app.tsx`.
- [x] Tests (api routes + DB-backed covenant/reconcile injection + web panel) + full gate green.

## Dev Notes

### Scope
ONLY the operator panel + the three injection controls + their faithful-gated endpoints. The async
transport itself (9.1), the KYC gate (9.2), session (9.3), the counterparty mock (9.4), and the
banner/deploy (9.6) are untouched. `paper`/read-only is not regressed (additive).

### Injection mechanisms
- **Latency/failure (wired to 9.1):** the operator API reads/writes the SAME
  `FaithfulConfirmationSettingsStore` (`prod/packages/api/src/faithful/confirmation-settings.ts`) the
  faithful transport already consumes. Setting `failNext`/`failureRate`/`latencyMs` shapes the next
  flow's delayed-commit / compensated-failure behaviour exactly as Story 9.1 proves — this story only
  EXPOSES the store. [Source: epics.md Story 9.1/9.5; addendum §J FR-32]
- **Covenant breach (real computation path):** `BuildGroupViewOptions.forceCovenantBreach` is consulted
  inside the REAL `buildGroupView` covenant block: when set, the backing-float-floor covenant is computed
  against a documented stress threshold (`FORCE_BREACH_FLOOR_THRESHOLD = '1000000'` ratio) so the LIVE
  ratio genuinely fails the floor via `computeCovenant`/`covenantStatus` → status BREACH. It is NOT a
  cosmetic label; `currentBps` stays the real ledger ratio. The group-view route passes
  `forceCovenantBreach` from `deps.covenantOverride` (faithful only). Self-contained: a BREACH covenant
  row is emitted even when no covenant thresholds are configured.
- **Reconcile divergence (real 8.5 path):** when the injection is active, `POST /positions/reconcile`
  calls `buildInjectedDivergencePlan(db)` which picks an OPEN position (preferring a pair with the fewest
  open positions, so the §11.4 D1 topology is left intact), injects a `chainClosedPairs` entry for its
  pair, and supplies claim/contra correction accounts (two distinct accounts sharing one (asset,scale)).
  `reconcilePositionsToPairs` then reports the mismatch AND corrects it toward the chain via a balanced,
  append-only, journaled voiding entry + OPEN→CLOSED flip — the genuine Story-8.5 path (NFR-3). Clearable.

### Operator endpoints (faithful-gated, fail-closed)
- `GET/PUT /operator/confirmation` → `FaithfulConfirmationSettingsView`; out-of-range ⇒ 400
  (`FaithfulConfirmationSettingsError`); absent store ⇒ 503 `OPERATOR_CONFIRMATION_UNAVAILABLE`.
- `GET/PUT /operator/covenant-breach` → `{ active, version }`; absent ⇒ 503
  `OPERATOR_COVENANT_UNAVAILABLE`.
- `GET/PUT /operator/reconcile-divergence` → `{ active, version }`; absent ⇒ 503
  `OPERATOR_RECONCILE_UNAVAILABLE`.
All inputs Zod-validated at the boundary (fail-closed).

### Role gating (Story 9.3)
The web "Operator" nav surface is rendered only for `isOperator` (the Olivia operator identity) in
`app.tsx` (mirrors the Simulation tab); a subscriber/signed-out visitor never sees it (falls back to a
`SignInRequired … operatorOnly` state). [Source: `prod/packages/web/src/lib/session.tsx`,
`prod/packages/web/src/app.tsx`]

### P0 interpretations (documented, not invented scope)
- **Covenant stress threshold:** `'1000000'` (1,000,000%) guarantees a genuine floor BREACH for any
  finite live ratio. The forced row's denominator is the dominant asset's GROSS BALANCE-SHEET FOOTING
  (assets + liabilities), a guaranteed-positive quantity, so the BREACH holds EVEN when group NAV is
  0/degenerate — the seeded faithful demo has assets ≈ liabilities ⇒ NAV ≈ 0, which a NAV denominator
  would (wrongly) read as NA. `currentBps` stays the real backing/footing ratio. (`forcedBreachFloorCovenant`,
  `prod/packages/reconcile/src/group-view.ts`.) Verified LIVE: faithful boot, `PUT /operator/covenant-breach
  {active:true}` ⇒ `GET /group-view` shows `backing-float-floor` BREACH (currentBps 5000); clearing ⇒ none.
- **Reconcile target selection:** the injection corrects (and thus CLOSES) a real OPEN position — that
  IS the demonstrated reconcile-and-correct behaviour. It prefers the pair with the fewest open positions
  (the seeded solo pair) so the headline D1 topology is preserved; re-seed to restore.
- **Covenant injection self-contained:** emits a BREACH row even with no configured covenant thresholds,
  so FR-32's covenant breach is demonstrable in faithful mode without 9.6 deploy env.

### Testing standards
Vitest, co-located `*.test.ts(x)`; DB integration tests share one DB, run serially, `hardReset`+`migrateUp`
in `beforeAll`, `TRUNCATE … CASCADE` per test. Money stays exact bigint (NFR-2). In-process Fastify
`inject` for route tests (no socket). Web: React Testing Library with an injected fixture `ApiClient`.

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log
- Full gate run after implementation (typecheck, lint, test, format:check, check:regime,
  check:migrations, forge test).

### Completion Notes
- Three injection stores added; all faithful-gated and fail-closed (typed 503/400).
- Covenant breach flows through the real `buildGroupView` covenant computation; reconcile divergence
  flows through the real Story-8.5 `reconcilePositionsToPairs` (journaled correction).
- Operator web panel (`surfaces/operator/operator-panel.tsx`) is OPERATOR-role-gated via a new
  `operator` nav surface in `app.tsx` (`OPERATOR_ONLY_SURFACES`, mirrors the Simulation tab); a
  non-operator never sees it (falls back to a `SignInRequired … operatorOnly` state). It exposes the
  three controls (confirmation latency/failureRate/fail-next; force/clear covenant breach; arm/clear
  reconcile divergence) via new client methods + hooks + fixtures, and degrades cleanly to a
  faithful-only note on a typed 503.
- **Covenant-breach NAV≈0 fix (this pass):** the forced backing-float-floor covenant now derives BREACH
  against the gross balance-sheet footing (assets + liabilities) instead of NAV, so the seeded faithful
  demo (NAV ≈ 0) surfaces a genuine BREACH rather than NA. Verified LIVE on `ENGINE_MODE=faithful`.
- Co-located API operator-route tests (`prod/packages/api/src/operator.test.ts`): the 3 GET + 3 PUT
  round-trips, out-of-range confirmation ⇒ 400, covenant toggle drives `GET /group-view` to BREACH (and
  clears), reconcile toggle drives `POST /positions/reconcile` to report-and-correct (and clears), and
  every operator endpoint ⇒ 503 when its store is absent.
- Full gate green: typecheck, lint, test (1115), format:check, check:regime, check:migrations, forge
  (171), web SPA build.

### File List
- prod/packages/reconcile/src/group-view.ts (forceCovenantBreach)
- prod/packages/positions/src/reconcile.ts (buildInjectedDivergencePlan)
- prod/packages/api/src/faithful/covenant-override.ts (new)
- prod/packages/api/src/faithful/reconcile-injection.ts (new)
- prod/packages/api/src/routes/operator.ts (new)
- prod/packages/api/src/operator.test.ts (new — co-located route tests, matching positions.test.ts/simulation.test.ts placement)
- prod/packages/api/src/schemas.ts
- prod/packages/api/src/errors.ts
- prod/packages/api/src/app.ts
- prod/packages/api/src/routes/group-view.ts
- prod/packages/api/src/routes/positions.ts
- prod/packages/api/src/serve.ts
- prod/packages/api/src/index.ts
- prod/packages/reconcile/src/group-view.test.ts (forceCovenantBreach)
- prod/packages/positions/src/reconcile.test.ts (buildInjectedDivergencePlan)
- prod/packages/web/src/lib/contract-types.ts
- prod/packages/web/src/lib/api-client.ts
- prod/packages/web/src/lib/queries.ts
- prod/packages/web/src/surfaces/operator/operator-panel.tsx (new)
- prod/packages/web/src/surfaces/operator/operator-panel.test.tsx (new)
- prod/packages/web/src/test/fixtures.ts
- prod/packages/web/src/app.tsx

## Change Log
- 2026-06-20: Story 9.5 implemented — operator control panel + three faithful-gated injection
  endpoints (confirmation latency/failure, covenant breach, reconcile divergence) through the real
  9.1/group-view/8.5 paths; operator-role-gated web surface.
- 2026-06-20: Finished — fixed the covenant-breach injection to derive a genuine BREACH at NAV ≈ 0
  (gross balance-sheet footing denominator, not NAV); added co-located API operator-route tests; built
  the web operator panel (surface + client/hooks/fixtures + tests). Full gate green.
