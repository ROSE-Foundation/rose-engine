---
title: 'Mock-faithful design foundation (tokens, fonts, dark theme, Card)'
type: 'refactor'
created: '2026-06-18'
status: 'done'
baseline_commit: '31e0dbb4637d5549a281fbe4dd5bc993ab7748b9'
context:
  - '{project-root}/docs/mocks/dashboard.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The four surfaces were built against a now-superseded `DESIGN.md` (light/dark, single rosé brand color, gain/loss-only semantics, sans-serif). The provided mocks are the new source of truth: a dark instrument-terminal palette, a Fraunces/Inter/IBM Plex Mono type system, and directional `long/short/gold/blue/purple` data colors. Every later surface depends on this foundation, so it must land first and coherently.

**Approach:** Re-base the design tokens in `index.css` onto the exact mock palette, load the three mock fonts, default the app to dark, give `Card` the mock's hover treatment, and rewrite `DESIGN.md` to record the new direction. No surface content is restructured here — only the shared visual foundation and the tokens the surfaces already reference.

## Boundaries & Constraints

**Always:** Use the exact mock hex values (`--bg:#0e1218 --panel:#161c25 --panel2:#1c232e --panel3:#222a36 --line:#28313e --line2:#323c4a --ink:#e9edf2 --sub:#9aa6b4 --dim:#5e6a78 --long:#2bb89e --short:#e0685f --gold:#d3a64a --blue:#5b9bd5 --purple:#7a6bc4`). Keep existing semantic aliases working by re-pointing them at mock tokens (`--gain→--long`, `--loss→--short`, `--warn→--gold`, `--info→--blue`). Components must keep referencing tokens, never raw hex. Money/price/qty stay in IBM Plex Mono tabular.

**Ask First:**
- Retire light mode entirely (mocks are dark-only) vs. keep the toggle with light tokens left as-is. Recommendation: keep `ThemeProvider`/toggle but make dark the default and the only mock-faithful mode; do not invent a light palette.
- Drop rosé as the brand color (mocks have none; logo is a conic `long→short→gold` mark, active nav is neutral `--panel2`). Recommendation: drop rosé; `--primary` becomes the elevated neutral (`--panel2/--ink`); reserve `--long/--short` for order placement only (later spec).

**Never:** Do not restructure or add features to any surface (covenant-console, coupled-pair, exchange-trading, subscriber) in this spec — that is specs #2–#5. Do not touch the ledger schema or contracts. Do not introduce gradients on data, or a second brand color beyond the logo mark.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First load, no stored theme | `localStorage` empty | App renders dark (mock palette); `<html>` has `.dark` | N/A |
| Stored theme = light | `rose-theme=light` | Honored if light kept; else coerced to dark | N/A |
| Fonts blocked/offline | Google Fonts unreachable | Falls back to `Inter→system`, `IBM Plex Mono→ui-monospace`, `Fraunces→serif` without layout break | Graceful FOUT |

</frozen-after-approval>

## Code Map

- `prod/packages/web/src/index.css` -- token source; replace palette, add directional tokens + font/radius roles
- `prod/packages/web/index.html` -- add Google Fonts preconnect + stylesheet (Fraunces/Inter/IBM Plex Mono)
- `prod/packages/web/src/components/theme-provider.tsx` -- default mode → dark
- `prod/packages/web/src/components/ui/card.tsx` -- mock card radius (12px) + hover border/elevation
- `_bmad-output/planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/DESIGN.md` -- rewrite brand layer to the mock direction

## Tasks & Acceptance

**Execution:**
- [x] `prod/packages/web/index.html` -- added `<link rel="preconnect">` + the mock's exact Google Fonts `css2` URL (Fraunces opsz 9..144 / 400,500,600; Inter 400–700; IBM Plex Mono 400,500,600)
- [x] `prod/packages/web/src/index.css` -- `.dark` = exact mock palette (default), `:root` = neutral rosé-free light; added `--long/--short/--gold/--blue/--purple` + `--elevated`/`--border-strong` + `@theme inline` color mappings; re-pointed `--gain/--loss/--warn/--info` aliases; set `--font-sans:'Inter'`, `--font-display:'Fraunces'`, `--font-numeric:'IBM Plex Mono'`; radii `sm 6 / md 8 / lg 12`; `body` font → Inter
- [x] `prod/packages/web/src/components/theme-provider.tsx` -- default + SSR fallback → `'dark'` (toggle kept; OS-pref branch removed); decision: keep toggle, dark default
- [x] `prod/packages/web/src/components/ui/card.tsx` -- `rounded-lg`, hover: `border-border-strong` + subtle lift, per mock `.card:hover`
- [x] `_bmad-output/.../DESIGN.md` -- rewrote frontmatter + prose to the mock-faithful system (dark base, three fonts, directional data colors, logo mark, no rosé)
- [x] `prod/packages/web/src/components/theme-provider.test.tsx` -- updated default-theme assertion (light → dark); `button.tsx` comment updated (rosé abandoned)

**Acceptance Criteria:**
- Given a fresh browser, when the app loads, then it renders the dark mock palette and Fraunces titles / IBM Plex Mono figures are visible.
- Given the existing surfaces unchanged, when they render, then `text-gain`/`text-loss`/`bg-warn` etc. resolve to the mock colors (no broken/empty colors) and no surface markup was modified.
- Given `pnpm --filter @rose/web build` and the root test+lint, when run, then all pass.

## Verification

**Commands:**
- `pnpm --filter @rose/web build` -- expected: typecheck + vite build succeed
- `pnpm test` -- expected: web component tests pass (after updating any theme/token assertions)
- `pnpm lint` -- expected: clean

**Manual checks:**
- `pnpm --filter @rose/web dev`: home/covenant-console renders on `#0e1218`, cards on `#161c25` with hover lift, titles in Fraunces, figures in IBM Plex Mono, gains teal / losses orange.

## Spec Change Log

- **2026-06-18 — review pass (no loopback; patches only).** Three adversarial reviewers ran (Blind Hunter, Edge Case Hunter, Acceptance Auditor → PASS). Patches applied within scope: wordmark `text-primary`→`text-foreground` (invisible on dark, `app.tsx`); ghost/outline button hover `bg-muted`→`bg-elevated` (active≠hover, since `--primary`==`--muted`); pre-paint FOUC guard script in `index.html`; `prefers-reduced-motion` guard on Card hover; Card comment attribution corrected. Deferred (see `deferred-work.md`): light-mode data-color AA failures (accepted tradeoff of dark-only mocks — frozen alias rule), explicit `tnum`, directional-token consumption (specs #3+). Two Blind-Hunter MEDs (`--color-warn-foreground`/`--font-numeric`) were false positives from a truncated diff summary — both present and wired.

## Suggested Review Order

**Token foundation (the design system itself)**

- Entry point — the whole change pivots here: dark mock palette as default, directional + alias tokens.
  [`index.css:49`](../../prod/packages/web/src/index.css#L49)
- Tailwind utility wiring: every `text-*`/`bg-*`/`border-*` consumer follows these mappings.
  [`index.css:82`](../../prod/packages/web/src/index.css#L82)
- The brand-layer rewrite the tokens implement (dark base, three fonts, no rosé, logo mark).
  [`DESIGN.md:10`](../planning-artifacts/ux-designs/ux-rose-engine-2026-06-15/DESIGN.md#L10)

**Default-dark behavior**

- Dark is now the default + only mock-faithful mode (OS-pref branch removed).
  [`theme-provider.tsx:16`](../../prod/packages/web/src/components/theme-provider.tsx#L16)
- Pre-paint guard mirrors the resolver to avoid a white→dark flash; loads the three fonts.
  [`index.html:7`](../../prod/packages/web/index.html#L7)

**Component deltas (review-driven patches)**

- `--primary` is now the elevated neutral (rosé gone); hover uses `bg-elevated` so active≠hover.
  [`button.tsx:12`](../../prod/packages/web/src/components/ui/button.tsx#L12)
- Card: 12px radius + restrained hover lift, reduced-motion guarded.
  [`card.tsx:11`](../../prod/packages/web/src/components/ui/card.tsx#L11)
- Wordmark legibility patch on the dark canvas.
  [`app.tsx:62`](../../prod/packages/web/src/app.tsx#L62)

**Peripherals**

- Test updated for the dark default.
  [`theme-provider.test.tsx:28`](../../prod/packages/web/src/components/theme-provider.test.tsx#L28)
