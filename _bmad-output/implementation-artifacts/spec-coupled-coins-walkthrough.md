---
title: 'Coupled-coins animated walkthrough (Coupled-Pair surface)'
type: 'feature'
created: '2026-06-18'
status: 'done'
baseline_commit: '108cf18'
context:
  - '{project-root}/docs/mocks/coupled-coins.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Coupled-Pair surface is a static live-data card; the mock `coupled-coins.html` is a 6-scene animated walkthrough (capital → issuance → venue → mark-to-market → delta-neutral proof → threshold rebalancing) with auto-play, a live price slider, a progress rail, and keyboard navigation — the pedagogical "the mechanism" view.

**Approach:** Rebuild the surface into the animated walkthrough matching the mock, while PRESERVING the existing live `CoupledPairView` (real ledger data — do not delete it). The interactive scenes (mark-to-market, rebalancing) compute leg values from the REAL coupled-coin invariant (`V_A + V_B = K`, delta-neutral around the anchor, leverage, floor), seeded from a live active pair's parameters when available; illustrative-only structural scenes are clearly framed as explanatory diagrams.

## Boundaries & Constraints

**Always:** Pure frontend (web package only). Reuse `prod/packages/web/src/lib/pair-math.js` for invariant/floor/balance math; the price→leg recompute (authoritative Epic-7 math lives in `/throwaway`, which `/prod` MUST NOT import — regime boundary) is implemented inline in `pair-math.ts` as a documented pedagogical model with unit tests. Interactive scenes seed from the live pair (anchor/leverage/collateral/floor) when one is available; when no live pair, use clearly-labelled "illustrative example" parameters (NOT presented as real data). Spec-#1 tokens + directional colors (`long`/`short`/`gold`). ALL animation respects `prefers-reduced-motion` (no auto-play, no transitions). Keyboard-operable (← / → / Space) + ARIA (slider, scene region, labelled controls).

**Ask First:** (none — autonomous)

**Never:** Do NOT delete or regress the live `CoupledPairView` or its tests (FR-6 / story 6.5). Do NOT import anything from `/throwaway` into `/prod` (CI regime guard). Do NOT touch schema, API, or contracts. Do NOT present illustrative scenario numbers as live ledger data (CLAUDE.md no-placeholder) — label them.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Walkthrough default | mounted | scene 1 shown; auto-play advances at the mock cadence; rail fills; counter 01/06 | N/A |
| Play / pause toggle | click | auto-play stops/resumes | N/A |
| Keyboard nav | ←/→/Space | prev / next scene / toggle play | N/A |
| Mark-to-market slider | drag price ±range | `V_A`/`V_B` recompute via the invariant; `V_A + V_B = K` holds at every step; floor line shown on the short leg | clamp legs to `[floor, K]` |
| Live pair available | surface has a live pair | MTM/rebalancing seeded from its anchor/leverage/collateral/floor; live `CoupledPairView` also shown | fall back to illustrative if none |
| prefers-reduced-motion | OS reduce flag | no auto-play, no transitions; manual nav still works | N/A |

</frozen-after-approval>

## Code Map

- `prod/packages/web/src/surfaces/coupled-pair/coupled-pair.tsx` -- rebuild surface into the walkthrough; KEEP `CoupledPairView` (live) embedded/adjacent
- `prod/packages/web/src/surfaces/coupled-pair/walkthrough/*` -- NEW scene components + walkthrough container (scenes, rail, controls, keyboard)
- `prod/packages/web/src/lib/pair-math.ts` -- add documented pedagogical `legsAtPrice(anchor, price, leverage, collateral, floor)` returning `{ vA, vB }` with `vA + vB = K`, clamped at floor
- `prod/packages/web/src/lib/pair-math.test.ts` -- unit-test the invariant holds across the price range incl. floor clamp
- `prod/packages/web/src/surfaces/coupled-pair/coupled-pair.test.tsx` -- scene nav, play/pause, slider recompute, reduced-motion, live view preserved

## Tasks & Acceptance

**Execution:**
- [x] `pair-math.ts` (+ test) -- `legsAtPrice(collateralPool, leverage, floor, priceChangeBps)`; invariant enforced STRUCTURALLY (`longLeg = K − shortLeg`) + floor clamp; test loops L∈{1,7} across ±range incl. the clamped region
- [x] `coupled-pair/walkthrough/` -- 6 scene components per `coupled-coins.html` + container (auto-play, play/pause, progress rail, prev/next, keyboard, counter `01/06`), all `prefers-reduced-motion`-aware (`use-reduced-motion.ts`)
- [x] `coupled-pair.tsx` -- surface renders the walkthrough (seeded from the live pair; illustrative fallback with visible badge) ABOVE the preserved live `CoupledPairView` (`LivePairSection`); loading/error/empty kept
- [x] tests -- scene nav, play/pause auto-advance (fake timers), slider keeps `V_A+V_B=K`, reduced-motion disables auto-play, surface co-renders walkthrough + live view; live `CoupledPairView` tests intact

**Acceptance Criteria:**
- Given the surface, when it mounts, then the 6-scene walkthrough renders with auto-play (unless reduced-motion) and the live pair view is still present.
- Given the mark-to-market scene, when the price slider moves, then `V_A` and `V_B` recompute via `legsAtPrice` and `V_A + V_B = K` holds at every step (with the short leg clamped at the floor).
- Given `prefers-reduced-motion`, when set, then no auto-play/transitions occur but manual + keyboard navigation still work.
- Given `pnpm --filter @rose/web build`, `pnpm vitest run prod/packages/web`, `pnpm lint`, when run, then all pass.

## Design Notes

The walkthrough is the pedagogical "mechanism" view (mock card 03). Structural scenes (capital/issuance/venue/delta-neutral proof) are explanatory diagrams; the numeric scenes (MTM, rebalancing) are interactive simulations over the REAL invariant — parameterised by a live pair when available, else by parameters explicitly labelled "illustrative example". This honours no-placeholder: simulation inputs are either live or visibly illustrative, never fake "live" data. Authoritative Epic-7 reference math stays in `/throwaway`; the web implements the same invariant inline (documented) because `/prod` cannot import `/throwaway`.

## Verification

**Commands:**
- `pnpm --filter @rose/web build` -- expected: succeeds
- `pnpm vitest run prod/packages/web` -- expected: all pass incl. new walkthrough + pair-math tests
- `pnpm lint` -- expected: clean

## Spec Change Log

- **2026-06-18 — review pass (2 Opus reviewers: correctness+scope, acceptance+a11y).** Invariant math structurally correct; regime boundary + scope clean; live `CoupledPairView` intact; no fabricated-as-live data. Patches applied (no loopback):
  - **Keyboard scoped** — the `document` keydown handler now early-returns unless focus is within the walkthrough; arrows ignored on INPUT/SELECT (the price slider was keyboard-inoperable), Space ignored on focused BUTTON/A (was hijacked page-wide).
  - **Scene 6 (rebalancing)** now uses the live pair's REAL leverage + floor (was hardcoded L=2/0.10 against real K); the price shock is derived (`(1−floorRatio)/L`) and explicitly labelled an "illustrative stress walkthrough"; illustrative-only when no live pair.
  - **Test rigor** — the invariant loop now runs L∈{1,7} so the floor-clamp region is exercised.
  - **Rail a11y** — downgraded from incomplete tablist to `role="group"` + `aria-current="step"` + `aria-controls` to the scene region.
  - **Coverage** — added a play/pause auto-advance test (fake timers) + a `CoupledPairSurface` co-render test (walkthrough + live view).
- Deferred (deferred-work.md): `text-dim` small-text AA on dark (mock-fidelity bucket); richer in-scene CSS animation; the Scene-4 reference *price label* is the one float-derived display value (not money/units).

## Suggested Review Order

- Entry point — the pedagogical invariant: `longLeg = K − shortLeg`, floor-clamped (structural conservation, exact bigint).
  [`pair-math.ts`](../../prod/packages/web/src/lib/pair-math.ts)
- The 6-scene walkthrough: auto-play/play-pause, rail, scoped keyboard, MTM slider, rebalancing on real params.
  [`coupled-coins-walkthrough.tsx`](../../prod/packages/web/src/surfaces/coupled-pair/walkthrough/coupled-coins-walkthrough.tsx)
- Surface composition: walkthrough (live-seeded / illustrative-fallback) above the preserved live `CoupledPairView`.
  [`coupled-pair.tsx`](../../prod/packages/web/src/surfaces/coupled-pair/coupled-pair.tsx)
- SSR/jsdom-safe reduced-motion hook gating all animation.
  [`use-reduced-motion.ts`](../../prod/packages/web/src/lib/use-reduced-motion.ts)
