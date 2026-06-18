---
name: ROSE Engine Surfaces
description: Internal/operational + subscriber surfaces for the ROSE Engine (FR-14). Dark instrument-terminal register derived from the docs/mocks/*.html design (supersedes the original sober-rosé direction). No single brand color — a conic logo mark + directional data colors carry the identity. React 18 + Vite + Tailwind v4; Fraunces / Inter / IBM Plex Mono.
status: final
created: 2026-06-15
updated: 2026-06-18
supersedes: 'Original sober-institutional rosé direction (2026-06-15). New source of truth: docs/mocks/{index,dashboard,coupled-coins,exchange}.html.'
sources:
  - ../../../../docs/mocks/dashboard.html
  - ../../../../docs/mocks/exchange.html
  - ../../prds/prd-rose-engine-2026-06-15/prd.md
  - ../../architecture.md
colors:
  # Mock palette (docs/mocks/*.html :root). Dark is the default + fully-designed mode.
  bg: '#0e1218'              # app background
  panel: '#161c25'          # card surface
  panel2: '#1c232e'         # elevated / active-nav / primary action
  panel3: '#222a36'         # raised / hover surface
  line: '#28313e'           # hairline border
  line2: '#323c4a'          # stronger border / hover
  ink: '#e9edf2'            # primary foreground
  sub: '#9aa6b4'            # muted foreground
  dim: '#5e6a78'            # dimmest text / captions
  # Directional DATA colors — PRODUCT-CRITICAL, not decorative.
  long: '#2bb89e'           # long leg / gains / positive delta / NAV up / live pulse
  short: '#e0685f'          # short leg / losses / negative delta / NAV down
  gold: '#d3a64a'           # collateral K / risk / floor / pending
  blue: '#5b9bd5'           # client / info / neutral system
  purple: '#7a6bc4'         # rates / yield streams
typography:
  body:
    fontFamily: 'Inter'
    fontSize: 14px
  display:
    fontFamily: 'Fraunces'        # serif titles / hero headings
    opticalSizing: 'auto'
    weight: '400–600'
  numeric:
    fontFamily: 'IBM Plex Mono'   # tabular figures for all money/price/qty/% and tx-hash
    fontFeatureSettings: "'tnum' 1"
    fontSize: 14px
rounded:
  sm: 6px
  md: 8px
  lg: 12px                  # mock card radius (--r)
  full: 9999px              # status/lifecycle badges + live dots only
components:
  logo-mark:
    note: 'conic-gradient(from 200deg, long, short, gold, long) — the identity in lieu of a brand color'
  card:
    background: '{colors.panel}'
    border: '1px solid {colors.line}'
    radius: '{rounded.lg}'
    hover: 'border → {colors.line2}, subtle lift'
  button-primary:
    background: '{colors.panel2}'   # elevated neutral — NO brand color
    foreground: '{colors.ink}'
  nav-active:
    background: '{colors.panel2}'
    foreground: '{colors.ink}'
  money-cell:
    fontFamily: '{typography.numeric.fontFamily}'
    align: right
  delta-up:
    foreground: '{colors.long}'
    glyph: '▴'
  delta-down:
    foreground: '{colors.short}'
    glyph: '▾'
  live-indicator:
    foreground: '{colors.long}'
    glyph: '●'
    note: 'pulses while fresh; turns {colors.gold} when stale'
  status-badge:
    radius: '{rounded.full}'
    note: 'lifecycle PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED — color-mapped, never color-only'
---

## Brand & Style

The ROSE Engine surfaces are **instruments, not marketing** — operated by stewards, an investment manager, and a small set of sophisticated subscribers reading **live financial data** they must trust on sight. The register is a **dark institutional trading terminal** (Bloomberg/terminal lineage): near-black `#0e1218` canvas, dense legible tables, restraint everywhere. Credibility is the brand: a regulated system must *look* exact.

There is **no single brand color.** The identity is carried by the **conic logo mark** (`long → short → gold`) and by the **directional data colors** themselves. The earlier sober-rosé direction is superseded — rosé no longer appears anywhere. Active navigation and primary actions use the **elevated neutral** (`panel2 #1c232e`), exactly as the mocks do.

This DESIGN.md is the brand + data-product layer on React 18 + Vite + **Tailwind v4** (tokens declared in `index.css` via `@theme inline`; no `tailwind.config`). Generic chrome (inputs, dialogs, popovers) inherits neutral panel tokens.

## Colors

Dark base + directional data semantics. Light mode is a **secondary toggle** that reuses the data colors on a neutral light chrome; it is intentionally **not** a separately-designed palette (the mocks are dark-only).

- **Surfaces:** `bg #0e1218` → `panel #161c25` (cards) → `panel2 #1c232e` (elevated / active) → `panel3 #222a36` (hover). Borders `line #28313e`, stronger `line2 #323c4a`.
- **Text:** `ink #e9edf2`, `sub #9aa6b4`, `dim #5e6a78`.
- **Directional data (always paired with a glyph so meaning never rests on color alone):** `long #2bb89e` (long leg, gains, NAV up, live pulse), `short #e0685f` (short leg, losses, NAV down), `gold #d3a64a` (collateral K, floor, risk, pending), `blue #5b9bd5` (client, info), `purple #7a6bc4` (rates, yield).

Avoid: a brand/accent color beyond the logo mark, decorative gradients on data, color-only signaling.

## Typography

- **Inter** — body, labels, table name cells.
- **Fraunces** (serif, optical sizing) — surface titles and hero headings only. Sober, not ornamental.
- **IBM Plex Mono** (tabular `tnum`) — every monetary amount, price, quantity, leg value (`V_A`/`V_B`/`K`/floor/anchor), percentage, and tx-hash fragment, so digits align in columns and never reflow. Non-negotiable for a money product.

## Layout & Spacing

Tailwind 4 scale (4, 8, 12, 16, 24, 32). Dense table padding (~6px y / 10px x) — wide multi-column tables are the point.

- **Operator surfaces (Covenant Console, Coupled-Pair, Exchange/Trading):** desktop, full-width data layouts; persistent top bar (logo + topnav with neutral active item + live indicator + clock) and, where useful, multi-column workspaces (e.g. exchange 280px / 1fr / 320px). Designed for ≥1280px.
- **Subscriber surfaces:** responsive, single-column on mobile expanding to a centered reading column on desktop.

## Elevation & Depth

Flat and dark. Hierarchy from **borders and surface steps** (`panel` → `panel2` → `panel3`), not heavy shadows. Cards lift subtly on hover (stronger border + small translate), matching the mock `.card:hover`. Sticky table headers use a hairline border.

## Shapes

`rounded/sm` (6px) inputs, `rounded/md` (8px) buttons/small controls, `rounded/lg` (12px) cards/banners. **Pill (`rounded/full`) reserved for status/lifecycle badges and live dots.** Tables are square-edged.

## Components

Brand + data-product components:

- **Logo mark** — conic `long→short→gold` gradient chip; the identity, used top-left of every surface.
- **Money cell** — IBM Plex Mono, right-aligned, asset symbol + decimal scale always shown, rendered from decimal strings (never JS `number`). The atom of every table.
- **Delta indicator** — glyph + directional color + signed value (`▴` long, `▾` short).
- **Status badge** — pill mapping the six lifecycle states + `live`/`divergent`/`pending`; color-mapped but label-bearing.
- **Live indicator** — `long` pulse while fresh; `gold` when stale.
- **Divergence banner** — `gold` banner shown when reconcile detects a ledger↔chain mismatch; states the correction-toward-chain action.
- **Stat / KPI card** — label + Fraunces/mono figure + left accent stripe (per dashboard mock) + delta indicator.
- **Confirm-action panel** — subscribe/redeem two-step (review → confirm) surfacing the on-chain consequence.
- **Entity switcher** — top-bar control scoping operator surfaces to `VCC` / `HOLDING` / `TRADING_CO` / `COIN_ISSUER` / consolidated group.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Build on the dark mock palette as the default | Reintroduce rosé or any single brand color |
| Use the conic logo mark for identity | Add an accent color for chrome/active states (use `panel2`) |
| Render every figure in IBM Plex Mono (tabular) | Use proportional fonts or JS floats for money |
| Use Fraunces for titles only | Use serif for body or data |
| Pair every long/short color with a glyph | Signal state by color alone (fails AA + colorblind) |
| Full-width dense tables on operator surfaces | Clamp operator tables to a narrow reading width |
| Show asset symbol + scale on every amount | Render a bare number without its unit |
