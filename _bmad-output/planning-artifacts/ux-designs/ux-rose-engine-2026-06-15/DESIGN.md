---
name: ROSE Engine Surfaces
description: Internal/operational + subscriber surfaces for the ROSE Engine (FR-14). Sober institutional fintech register with a single ROSE rosé accent. shadcn/ui on React 18 + Vite + Tailwind; this DESIGN.md specifies the brand-layer + data-product delta only. Light + dark via semantic tokens.
status: final
created: 2026-06-15
updated: 2026-06-15
sources:
  - ../../prds/prd-rose-engine-2026-06-15/prd.md
  - ../../architecture.md
colors:
  # Brand-layer overrides on top of shadcn defaults. Unlisted tokens
  # (background, foreground, muted, muted-foreground, popover, card,
  # border, input, ring, destructive) inherit from shadcn light/dark.
  primary: '#B12A66'            # ROSE rosé — primary actions, active nav, brand marks
  primary-foreground: '#FFFFFF'
  primary-dark: '#E85C97'
  primary-foreground-dark: '#1A0E14'
  # Financial semantic tokens — PRODUCT-CRITICAL, not decorative. [ASSUMPTION] hexes.
  gain: '#1E8E5A'               # long leg up / positive delta / NAV up
  gain-dark: '#34D399'
  loss: '#C0392B'               # short leg / negative delta / NAV down
  loss-dark: '#F87171'
  warn: '#B7791F'               # floor-approach, stale data, pending tx
  warn-dark: '#FBBF24'
  info: '#2563EB'               # neutral system/info, reconcile notices
  info-dark: '#60A5FA'
typography:
  # Body / label / caption inherit shadcn (Geist Sans). Two roles added/overridden.
  numeric:
    fontFamily: 'IBM Plex Mono'   # [ASSUMPTION] — tabular figures for all money/price/qty
    fontFeatureSettings: "'tnum' 1, 'zero' 1"
    fontSize: 14px
    lineHeight: '1.4'
  display:
    fontFamily: 'Geist Sans'
    fontSize: 28px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.01em
rounded:
  # Crisp, tool-like — reads "instrument" not "consumer app".
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px               # status/lifecycle badges only
spacing:
  # shadcn / Tailwind 4-based scale inherited. One dense token added for tables.
  table-cell-y: 6px          # tighter vertical row padding for data-dense tables
  table-cell-x: 12px
components:
  button-primary:
    background: '{colors.primary}'
    foreground: '{colors.primary-foreground}'
    radius: '{rounded.md}'
  money-cell:
    fontFamily: '{typography.numeric.fontFamily}'
    align: right
    note: 'tabular figures; asset symbol + scale always shown; never JS float'
  delta-up:
    foreground: '{colors.gain}'
    glyph: '▴'
  delta-down:
    foreground: '{colors.loss}'
    glyph: '▾'
  live-indicator:
    foreground: '{colors.gain}'
    glyph: '●'
    note: 'pulses while data is fresh; turns {colors.warn} when stale'
  divergence-banner:
    background: '{colors.warn}'
    foreground: '#1A1208'
    radius: '{rounded.md}'
  status-badge:
    radius: '{rounded.full}'
    note: 'lifecycle PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED — color-mapped, never color-only'
---

## Brand & Style

The ROSE Engine surfaces are **instruments, not marketing**. They are operated by stewards, an investment manager, and a small set of sophisticated subscribers, all reading **live financial data** they must be able to trust on sight. The register is therefore **sober institutional fintech**: ink-on-paper neutrality, dense legible tables, restraint everywhere — closer to a Bloomberg terminal or a Stripe dashboard than a consumer app. Credibility is the brand: a regulated system must *look* exact.

A single brand color — **ROSE rosé (`#B12A66`)** — carries the ROSE identity. It appears on primary actions, active navigation, and brand marks, and **nowhere else**. It never colors data: gains, losses, statuses, and deltas use the financial semantic tokens, never the brand color. The discipline is one-brand-color-and-stop.

This DESIGN.md inherits **shadcn/ui** defaults wholesale and specifies only the delta: the rosé primary, the financial semantic tokens (which are product-critical, not decorative), a monospace numeric type role, crisp corners, and a handful of data-product components. Everything shadcn ships (Button variants, Dialog, Sheet, Command, Popover, Tabs, Toast) inherits as-is. `[ASSUMPTION]` shadcn over Mantine — confirm; if Mantine, the same token semantics port over.

## Colors

Brand layer + financial semantics + shadcn defaults for all chrome.

- **ROSE rosé (`#B12A66` light / `#E85C97` dark)** — the one brand color. Primary buttons, active nav item, brand mark, subscribe call-to-action. Replaces shadcn `primary`. Never used for data, state, or delta.
- **Gain (`#1E8E5A` / `#34D399`)**, **Loss (`#C0392B` / `#F87171`)** — long-leg/short-leg, positive/negative delta, NAV direction. Always paired with a glyph (`▴`/`▾`) so meaning never rests on color alone.
- **Warn (`#B7791F` / `#FBBF24`)** — floor approach, **stale live data**, **pending on-chain tx**, ledger↔chain **divergence** banner.
- **Info (`#2563EB` / `#60A5FA`)** — neutral system notices, reconcile-clean confirmations.
- **All chrome tokens** (`background`, `foreground`, `muted`, `border`, `input`, `ring`, `card`, `popover`, `destructive`) inherit shadcn light/dark. **Both modes are first-class** (user-toggleable); components must reference semantic tokens, never raw hex.

Avoid: gradients, decorative color, using rosé for data, color-only signaling, a second brand color.

## Typography

Body / label / caption inherit shadcn's **Geist Sans** ramp. Two roles are specified:

- **`numeric` — IBM Plex Mono with tabular figures (`tnum`).** `[ASSUMPTION]`. Every monetary amount, price, quantity, leg value (`V_A`/`V_B`/`K`/floor/anchor), percentage, and tx-hash fragment renders in this role so digits align in columns and never reflow. This is non-negotiable for a money product — misaligned figures read as untrustworthy.
- **`display` — Geist Sans 28px/600.** Surface titles and primary KPI figures (Group NAV). Sober, not ornamental.

## Layout & Spacing

shadcn / Tailwind 4-based scale inherited (4, 8, 12, 16, 24, 32, 48, 64). Two density tokens added for tables (`table-cell-y` 6px, `table-cell-x` 12px) because these are **data-dense** surfaces — unlike a typical shadcn app, wide multi-column tables are the point.

- **Operator surfaces (Covenant Console, Coupled-Pair, Exchange/Trading):** desktop, **full-width data layouts** (no `max-w` clamp); persistent left nav + top context bar (entity/group switcher, live indicator, light/dark toggle); designed for ≥1280px.
- **Subscriber surfaces:** **responsive**, single-column on mobile expanding to a centered `max-w-2xl` reading column on desktop.

## Elevation & Depth

Flat, institutional. Hierarchy comes from **borders and spacing, not shadows**. Inherit shadcn's subtle hover shadow only; add no elevation as a hierarchy device. Sticky table headers use a hairline border, not a drop shadow.

## Shapes

Crisp: `rounded/sm` (4px) inputs, `rounded/md` (6px) cards/buttons/banners, `rounded/lg` (8px) dialogs. **Pill (`rounded/full`) reserved for status/lifecycle badges only.** Tables are square-edged.

## Components

Used as-is from shadcn (don't customize): `Button` (non-primary variants), `Dialog`, `Sheet`, `Popover`, `DropdownMenu`, `Toast`, `Tabs`, `Separator`, `Skeleton`, `Command`.

Brand-layer + data-product components:

- **Button (primary)** — `{colors.primary}` rosé fill, `{rounded.md}`. Other variants inherit shadcn.
- **Money cell** — `{typography.numeric}`, right-aligned, asset symbol + decimal scale always shown, rendered from decimal strings (never JS `number`). The atom of every table.
- **Delta indicator** — `{components.delta-up}` / `{components.delta-down}`: glyph + semantic color + signed value.
- **Status badge** — pill mapping the six lifecycle states + `live`/`divergent`/`pending`. Color-mapped but label-bearing (never color-only).
- **Live indicator** — `{colors.gain}` pulse while fresh; `{colors.warn}` when stale beyond the refresh window.
- **Divergence banner** — `{colors.warn}` banner shown when reconcile detects a ledger↔chain mismatch; states the correction-toward-chain action.
- **Stat / KPI card** — label + `display` figure + delta indicator; used on the Covenant Console.
- **Confirm-action panel** — subscribe/redeem two-step (review → confirm) surfacing the on-chain consequence; primary action in rosé.
- **Entity switcher** — top-bar control scoping operator surfaces to `VCC` / `HOLDING` / `TRADING_CO` / `COIN_ISSUER` / consolidated group.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Inherit shadcn defaults for all chrome | Override shadcn tokens beyond `primary` + the financial semantics |
| Use rosé only for primary action / brand / active nav | Use rosé for data, deltas, or status |
| Render every figure in `numeric` (tabular mono) | Use proportional fonts or JS floats for money |
| Pair every gain/loss color with a glyph | Signal state by color alone (fails AA + colorblind) |
| Full-width dense tables on operator surfaces | Clamp operator tables to a narrow reading width |
| Show asset symbol + scale on every amount | Render a bare number without its unit |
| Surface refusals/divergence explicitly (warn) | Swallow a refusal into a silent success |
