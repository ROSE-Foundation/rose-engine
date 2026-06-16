---
name: ROSE Engine Surfaces
status: final
created: 2026-06-15
updated: 2026-06-15
project: rose-engine
scope: Engine Surfaces (FR-14)
design_ref: ./DESIGN.md
sources:
  - ../../prds/prd-rose-engine-2026-06-15/prd.md
  - ../../architecture.md
---

# ROSE Engine — Experience Spine

> Scope: the four functional Engine Surfaces (FR-14), all live-data in P0. Two form-factors: operator desktop (Covenant Console, Coupled-Pair view, Exchange/Trading) and subscriber responsive web (Subscriber surfaces). shadcn/ui on React 18 + Vite + TanStack Query/Router. `DESIGN.md` owns visual identity; this spine owns behavior. Both spines win over any mock.

## Foundation

Two form-factors, one component vocabulary.

- **Operator app (internal, gated):** desktop, data-dense. Persistent left nav across the three operator surfaces + a top context bar (entity/group switcher, global live indicator, light/dark toggle, operator identity). Session-based auth for internal operators. Designed for ≥1280px.
- **Subscriber app (distributed via laplace.digital):** responsive web, single reading column. Session-based auth for allowlisted Subscribers; access is **gated on a valid ONCHAINID eligibility claim** (FR-19) — there is no self-service KYC flow (PRD §5).

UI system: **shadcn/ui** on React 18 + Vite + TS, **TanStack Query** for all server-state (live data), **TanStack Router** for navigation. The library does the chrome; `DESIGN.md` names the brand + data-product delta. **All four surfaces read live data — there are no mockup surfaces in P0** (PRD §4.6, FR-14). Source of truth: the chain is authoritative for token ownership; the ledger is the accounting record reconciled toward it — the UI must make that relationship legible (see *Live Data & Consistency States*).

## Information Architecture

| Surface | Form-factor | Reached from | Purpose | Realizes |
|---|---|---|---|---|
| **Covenant Console** | Operator desktop | Nav / app open | Consolidated group view: group NAV, per-entity balances, float yield, exposure | FR-14, FR-9 |
| **Coupled-Pair view** | Operator desktop | Nav / pair list / row | Live pair state: `V_A`, `V_B`, `K`, floor, anchor, P, lifecycle state + holding | FR-14, FR-6, FR-4 |
| **Exchange / Trading view** | Operator desktop | Nav | Live (paper/testnet) strategy execution, positions, P&L by entity | FR-14, FR-20 |
| **Subscriber surfaces** | Subscriber responsive | laplace.digital entry | View positions → Note detail → subscribe / redeem | FR-14, FR-11, UJ-5 |

**Operator nav model:** top context bar scopes everything to an entity (`VCC` / `HOLDING` / `TRADING_CO` / `COIN_ISSUER`) or the consolidated group; left nav switches surface. Drill path: **group → entity → account → journal entry** (the audit trail, NFR-3) — every figure is traceable to its postings and, where on-chain, its tx hash.

**Subscriber nav model:** Positions list → Note detail (live pair state via the same Coupled-Pair atoms) → Subscribe / Redeem confirm panel.

→ Composition references rendered at Finalize into `mockups/`. Spine wins on conflict.

## Voice and Tone

Microcopy. Precise, regulated, never hyped. Aesthetic posture lives in `DESIGN.md.Brand & Style`.

| Do | Don't |
|---|---|
| "Group NAV — € 12,480,330.00" | "Your money is growing! 📈" |
| "Transfer refused — client-collateral principal cannot leave the client account (Model-A)." | "Action not allowed." |
| "Ledger ↔ chain divergence detected. Ledger corrected toward chain. View entry." | "Sync error." |
| "Pair ACTIVE · floor not breached" | "All good ✓" |
| "Awaiting on-chain confirmation (Sepolia)…" | "Loading…" |
| Same exact register for operators and subscribers. | Reassuring softening that hides a refusal or a divergence. |

Numbers always carry their **asset and scale** ("€ 12,480,330.00", "BTC 0.50000000", "1.0832 EUR/USD"). A refusal always states **which rule** refused and **why**.

## Money & Numeric Display *(product-specific)*

The defining behavior of these surfaces. Every figure obeys this contract:

- Rendered in `{typography.numeric}` (tabular mono) so columns align and digits never reflow.
- Sourced from **decimal strings** carrying the asset's decimal scale (EUR=2, BTC=8, token=`decimals()`) — **never** a JS `number`/float (NFR-2). The UI formats from the string; it never does float math.
- Money cells **right-aligned**; the asset symbol shown per cell or per column header.
- Deltas show **sign + glyph + semantic color** (`▴`/`▾`, gain/loss) — never color alone.
- Leg values display the invariant context: `V_A`, `V_B`, and `K` with `V_A + V_B = K` shown/derivable; `floor`, `anchor (P₀)`, and current `P` together so a steward can see distance-to-floor at a glance.
- Truncation is forbidden on monetary values — they wrap or the column widens; never an ellipsis on a number.

## Component Patterns

Behavioral. Visual specs live in `DESIGN.md.Components` (or shadcn defaults).

| Component | Use | Behavioral rules |
|---|---|---|
| **Data table** | All operator surfaces | Sticky header on scroll; sortable columns; money cells right-aligned tabular; no row truncation of figures; row click drills down (entity→account→entry). Pagination, never infinite scroll. |
| **Stat / KPI card** | Covenant Console | Label + `display` figure + delta indicator. Group NAV is the hero card. |
| **Status badge** | Coupled-Pair, pair lists | Pill mapping the six lifecycle states (`PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`) + `live`/`divergent`/`pending`. Always label-bearing. |
| **Live indicator** | Top bar + per-surface | `{colors.gain}` pulse while data is within the refresh window; flips to `{colors.warn}` "stale" with last-updated timestamp when it isn't. |
| **Divergence banner** | Any surface, on reconcile mismatch | `{colors.warn}` banner: states the mismatch and that the ledger was corrected toward the chain; links to the journaled correcting entry (FR-10). |
| **Confirm-action panel** | Subscriber subscribe/redeem | Two steps: **Review** (amount, asset, the coupled pair embedded, on-chain consequence) → **Confirm**. Pessimistic: no optimistic success; waits for the on-chain commit point (NFR-9). |
| **Eligibility gate** | Subscriber app entry | If no valid ONCHAINID claim, the subscribe path is unavailable with an explicit reason — not a generic block screen. |
| **Entity switcher** | Operator top bar | Scopes all operator surfaces to one entity or the consolidated group. |

## State Patterns

Every surface defines loading, empty, error, and the product-specific consistency states explicitly (no surface ships with implicit states — PRD §4.6, architecture Process Patterns).

| State | Surface | Treatment |
|---|---|---|
| Cold load | All | shadcn `Skeleton` rows/cards matching the target layout. |
| Empty | Covenant Console | "No balances yet." Operator-appropriate, no marketing CTA. |
| Empty | Coupled-Pair / Subscriber | "No active pairs." / "You hold no Rose Notes yet." |
| API error | All | Inline error with the machine `code` (from `{ error: { code, message } }`) + retry. Never a blank surface. |
| **Authorization refusal** | Subscriber / operator action | Surfaced as an explicit message naming the rule (Model-A, eligibility, coupling, default-deny) — **never** a silent success (NFR-4). See *Authorization Refusal UX*. |
| **Stale live data** | All | Live indicator → `{colors.warn}`; "Last updated {time}" shown; data still readable, flagged not-fresh. |
| **Pending on-chain tx** | Subscriber / Coupled-Pair | `pending` badge + "Awaiting Sepolia confirmation…"; the confirm panel stays in-flight until the commit point resolves or compensates. |
| **Ledger↔chain divergence** | Any | Divergence banner; on resolution, a toast confirming correction-toward-chain with a link to the correcting entry. |
| **Floor approach** | Coupled-Pair | Distance-to-floor rendered with `{colors.warn}` when P nears floor; reset events annotated on the pair timeline. |

## Interaction Primitives

**Read-first, act-deliberately.** Operators read dense live data; the few write actions (subscribe, redeem, agent powers) are deliberate and pessimistic.

- **Live refresh:** TanStack Query with a short poll/refetch window `[ASSUMPTION: ~5s, or websocket/event-driven off the chain watcher]`; the live indicator reflects freshness. No surface auto-mutates under the user without a visible change cue.
- **Drill-down:** click a figure/row to descend group → entity → account → journal entry → tx hash. Copy-tx-hash affordance on any on-chain entry.
- **Confirm before write:** subscribe/redeem always pass the Review→Confirm panel; no one-click money movement.
- **Pessimistic writes:** the UI shows `pending` and waits for the on-chain commit point — it never shows success before confirmation (NFR-9).
- **Mode toggle:** light/dark, persisted per operator.

**Banned everywhere:** optimistic success on capital movements; infinite scroll on ledgers (pagination only); color-only state; hiding a refusal or a divergence; bare numbers without unit; float math in the client.

## Accessibility Floor

Behavioral. Visual contrast lives in `DESIGN.md` (semantic tokens verified to AA in both modes).

- **WCAG 2.2 AA** across operator desktop and subscriber responsive — a regulated product treats accessibility as non-optional, and contrast in data-dense tables is load-bearing for trust.
- **No color-only signaling:** gains/losses, statuses, and divergence all carry a glyph or label in addition to color (colorblind-safe).
- Screen-reader: money cells announce value **with unit and scale** ("twelve million four hundred eighty thousand three hundred thirty euros"); status badges announce the lifecycle state; the live indicator announces freshness changes via `aria-live`.
- Full keyboard operability: table sort/drill, entity switcher, confirm panels, mode toggle. `Tab` order matches reading order; `Esc` closes the topmost dialog.
- Focus rings inherit shadcn `ring`, visible at AA against `background` in both modes.

## Responsive & Platform

| Surface group | Behavior |
|---|---|
| Operator (Covenant, Coupled-Pair, Exchange) | Desktop-first ≥1280px; full-width dense tables; left nav + top context bar. Below 1024px tables scroll horizontally with sticky first column — operator surfaces are not optimized for phones in P0. |
| Subscriber | Responsive: single column on `sm`, centered `max-w-2xl` on desktop; confirm panels full-width on mobile. Works phone→desktop. |

## Inspiration & Anti-patterns

- **Lifted from Bloomberg/terminal UIs:** tabular figures, dense tables, distance-to-threshold always visible, no chrome competing with data.
- **Lifted from Stripe dashboard:** sober palette, one brand accent, drill-to-detail with full audit traceability, explicit machine error codes.
- **Lifted from shadcn:** the entire surface vocabulary; the brand is *what we add*, not a from-scratch system.
- **Rejected — celebratory/marketing affordances** (streaks, confetti, "your money is growing"): this is a regulated instrument, not a consumer finance app.
- **Rejected — optimistic UI on money movements:** correctness over snappiness; the on-chain commit point is the truth (NFR-9).
- **Rejected — mockup/placeholder surfaces:** all four surfaces are live in P0 (FR-14); no hard-coded demo data ships.

## Key Flows

### Flow 1 — Reconcile before sign-off (Iris, internal steward, end of day)

1. Iris opens the **Covenant Console**, scoped to the consolidated group. The Group NAV hero card reads "€ 12,480,330.00 ▴ 0.4%"; per-entity balances tabulate below; the top-bar live indicator pulses green.
2. She runs `reconcile` from the console. The system produces the group view and checks ledger token quantities against on-chain balances.
3. A **divergence banner** appears (`{colors.warn}`): "Ledger ↔ chain divergence on COIN_ISSUER token quantity. Ledger corrected toward chain. View entry."
4. She clicks through: the surface drills to the journaled **correcting entry** (FR-10), showing the before/after quantity and the on-chain tx hash she can copy.
5. **Climax:** the banner clears to an `info` confirmation — "Reconciled. Ledger agrees with chain." Iris has the clean, traceable close she needs to attest capital is where the books say. Every figure on screen is now backed by a journal entry and, where on-chain, a tx hash — the audit trail is the surface, not a separate report.

Failure: the chain read is below the configured Sepolia confirmation depth → the banner reads "Awaiting finality (depth {n}). Reconcile will re-run on confirmation." No correction is applied on unfinalized state.

### Flow 2 — A forbidden transfer is blocked (Iris, mid-afternoon)

1. While reviewing `TRADING_CO`, Iris attempts to route client-collateral *principal* toward treasury.
2. The action passes through `postTransfer`; the default-deny authorization provider rejects it (Model-A bright line).
3. **Climax:** the surface shows an explicit refusal — "Transfer refused — client-collateral principal cannot leave the client account (Model-A)." — with the rule named, not a generic error. Nothing posts. A sibling note clarifies that a *yield* movement on the same collateral *is* permitted.

This is the UX embodiment of fail-closed (NFR-4): the refusal is loud, attributable, and impossible to mistake for a success.

### Flow 3 — Subscribe to a Rose Note (Sofia, allowlisted Rose Member, on laplace.digital)

1. Sofia opens the **Subscriber app**; her session carries a valid ONCHAINID eligibility claim, so the subscribe path is available.
2. She opens a Rose Note; the detail renders the live embedded **coupled pair** — `V_A`, `V_B`, `K`, floor, anchor — using the same numeric atoms as the operator Coupled-Pair view, and a "market-neutral at issuance" badge.
3. She enters an amount (€ or crypto) and hits Subscribe. The **Review** step states the amount, the pair embedded, and the on-chain consequence (paired L/S mint on Sepolia).
4. She confirms. The panel goes **pending**: "Awaiting Sepolia confirmation…"; no premature success.
5. **Climax:** on the on-chain commit point, the paired tokens are minted, the balanced ledger entry posts (incl. `NOTE_LIABILITY`), and her position appears with its live value and the pair's live state. The whole loop — subscribe → issue → mint → ledger — completed in front of her, on testnet/paper, with the books and chain in agreement.

Failure: Sofia's claim is missing/expired → the subscribe action is unavailable with "Subscription unavailable — eligibility claim not found. Contact your administrator." (no self-service KYC, PRD §5). A redemption follows the symmetric path (Review→Confirm→pending→burn whole package→ledger entry→position closed).
