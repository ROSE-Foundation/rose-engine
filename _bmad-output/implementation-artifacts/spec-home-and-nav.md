---
title: 'Home landing screen + top-bar nav restructure'
type: 'feature'
created: '2026-06-18'
status: 'done'
baseline_commit: '6867993'
context:
  - '{project-root}/docs/mocks/index.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The app has no entry point — `app.tsx` hard-routes to covenant-console behind a left sidebar, whereas the mocks open on a Home landing (`index.html`: a 3-card "select a view" menu) and navigate via a top bar with a conic logo mark + topnav, not a sidebar.

**Approach:** Add a Home surface matching `index.html` (intro + three view cards + status footer), a reusable conic `LogoMark`, and restructure the app shell from left-sidebar to a top bar (logo→Home, topnav with active state, theme toggle). Home is the default. No surface internals change.

## Boundaries & Constraints

**Always:** Use spec-#1 tokens only (no raw hex) — `bg-card`/`border-border`, directional `text-long/text-gold/text-blue` for the per-card edge accents, `font-display` (Fraunces) for headings, `font-numeric` for the card numbers/eyebrow. The three cards map to existing surfaces: Exchange→`exchange-trading`, Treasury Dashboard→`covenant-console`, Coupled Coins→`coupled-pair`. Keep the light/dark toggle reachable. Logo mark is decorative (`aria-hidden`); cards are keyboard-operable buttons.

**Ask First:** (none — autonomous run; decisions recorded in Design Notes)

**Never:** Do not modify any surface's internal markup/logic (covenant-console, coupled-pair, exchange-trading, subscriber) — only how the shell hosts them. Do not touch ledger schema or contracts. Do not add a router dependency (keep the existing `useState` surface switch).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Initial load | no selection | Home renders as default; topnav shows no active item | N/A |
| Click a Home card | card = Exchange | `surface` → `exchange-trading`; that surface renders; topnav marks it active | N/A |
| Click logo mark | any surface | returns to Home | N/A |
| Select topnav item | item = Subscriber | `surface` → `subscriber`; active state moves | N/A |

</frozen-after-approval>

## Code Map

- `prod/packages/web/src/surfaces/home/home.tsx` -- NEW: landing (intro + 3 cards + footer)
- `prod/packages/web/src/surfaces/home/home.test.tsx` -- NEW: renders cards, fires onSelect
- `prod/packages/web/src/components/ui/logo-mark.tsx` -- NEW: conic-gradient brand mark
- `prod/packages/web/src/app.tsx` -- restructure shell: top bar + Home default + card→surface wiring

## Tasks & Acceptance

**Execution:**
- [x] `prod/packages/web/src/components/ui/logo-mark.tsx` -- conic `from 200deg, long→short→gold→long` via arbitrary Tailwind bg; size via className; `aria-hidden`
- [x] `prod/packages/web/src/surfaces/home/home.tsx` -- intro (eyebrow mono/blue, Fraunces h2 with gold em, sub p) + 3 cards (num, tinted icon, h3, role, blurb, feature bullets, "go" link) calling `onSelect(surface)`; footer status lines; per-card edge color via `text-blue/text-gold/text-long`
- [x] `prod/packages/web/src/surfaces/home/home.test.tsx` -- renders the three cards; clicking one calls `onSelect` with the mapped surface
- [x] `prod/packages/web/src/app.tsx` -- added `'home'` to `Surface`, default to it; replaced left-`nav` sidebar with a top `header` (LogoMark→Home, topnav Buttons with active=primary, ThemeToggle right); renders `<Home onSelect={setSurface}/>`

**Acceptance Criteria:**
- Given a fresh load, when the app mounts, then the Home landing renders (three cards) on the dark canvas with Fraunces headings.
- Given Home, when a card is activated by mouse or keyboard, then the mapped surface renders and the topnav shows it active.
- Given any surface, when the logo mark is clicked, then Home renders again.
- Given `pnpm --filter @rose/web build` + root test + lint, when run, then all pass.

## Design Notes

Subscriber is intentionally not a Home card (the mock's three cards are operator/mechanism views); it stays reachable from the topnav. No router added — the existing `useState<Surface>` switch is extended, honoring the "no new dependency" boundary. Home cards are bespoke (18px radius, larger hover lift, glow) rather than the generic `Card`, to match `index.html` fidelity.

## Verification

**Commands:**
- `pnpm --filter @rose/web build` -- expected: succeeds
- `pnpm vitest run prod/packages/web` -- expected: all pass incl. new home test
- `pnpm lint` -- expected: clean

## Spec Change Log

- **2026-06-18 — review pass (PASS, no loopback, no patches).** One Opus adversarial+acceptance reviewer: Tailwind utilities all resolve (literal classes; `--color-*` present), mock fidelity high, scope honored (only `app.tsx` modified + 3 new files), types sound, a11y good. One MED deferred: `text-dim` on card surface fails AA for small text (numbers/bullets/tag) — a deliberate mock-fidelity token choice (see deferred-work.md). Footer tag `ROSE Engine` (dropped the mock's "· working mockup") is intentional. Verified earlier: build + 64 tests + lint green.

## Suggested Review Order

- Entry point — the landing screen (intro + 3 view cards + footer), card→surface mapping.
  [`home.tsx:78`](../../prod/packages/web/src/surfaces/home/home.tsx#L78)
- The shell restructure: top bar (logo→Home, topnav active state) replaces the sidebar; Home is default.
  [`app.tsx:66`](../../prod/packages/web/src/app.tsx#L66)
- Reusable conic brand mark (the identity in lieu of a brand color).
  [`logo-mark.tsx:5`](../../prod/packages/web/src/components/ui/logo-mark.tsx#L5)
- Test: cards render + onSelect maps to the right surface.
  [`home.test.tsx:7`](../../prod/packages/web/src/surfaces/home/home.test.tsx#L7)
