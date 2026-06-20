---
baseline_commit: 1ddc348d574ee723ccedf5b00fb7c0a92df855b3
---

# Story 9.6: Production-faithful composition, honest banner, and deploy

Status: done

## Story

As a build engineer,
I want `ENGINE_MODE=faithful` to compose the Story 9.1–9.5 mocks behind a clear "real vs mocked" banner, deployed on Railway, with the Home overview kept current,
So that a visitor sees a coherent near-production demo and always knows what is real vs simulated (FR-33, FR-14).

## Acceptance Criteria

**Given** the API boots with `ENGINE_MODE=faithful`
**When** it composes the services
**Then** it wires the async-confirmation transport (9.1), default-deny + KYC (9.2), session identity (9.3), the mock counterparty (9.4), and the operator surface (9.5) — and logs an explicit banner naming what is real (ledger, contracts, default-deny gate, reconcile) vs mocked (chain transport latency, KYC issuer, counterparty, price feed)

**Given** the running `faithful` app
**When** any surface renders
**Then** an honest, always-visible **mode banner** states "Production-faithful demo — testnet/paper, no real capital; mocked: …" so real vs simulated is never ambiguous (UX-DR4 honesty)

**Given** the three modes (`paper`, `faithful`, and the genuine testnet path)
**When** `faithful` is exercised
**Then** the existing `paper` and read-only behaviours are unchanged (additive), the deployed contracts are untouched, no real capital moves, and the Home "what this POC does" overview is updated to describe the faithful mode

## Tasks / Subtasks

- [x] A mode-reporting endpoint `GET /mode` (`{ engineMode, real[], mocked[] }`), driven from the actual composed deps (not a hardcoded guess), behind the basic-auth gate like every route.
  - [x] `src/engine-mode.ts` — `deriveEngineMode(deps)` infers `faithful` (KYC registry + confirmation settings composed) / `paper` (write services composed, no faithful deps) / `read-only` (no write services), with the honest real/mocked arrays per mode.
  - [x] `EngineModeSchema` / `EngineModeInfoSchema` in `schemas.ts`; `routes/mode.ts` registered in `app.ts`; type re-exported from the package root.
- [x] An always-visible web mode banner (`components/mode-banner.tsx`) rendered globally in the `Shell`, reading `GET /mode`: faithful / paper / read-only honest text + the mocked list; degrades gracefully (a safe honest fallback) when the endpoint is unreachable.
  - [x] `getEngineMode()` on the `ApiClient`, `useEngineMode()` query hook, `EngineModeInfo` contract type.
- [x] Deploy config — `railway.toml` documents `ENGINE_MODE=faithful` as a supported value alongside `paper` (Railway service variable, no secret baked); the live default is NOT silently changed (operator's call, noted in Dev Notes).
- [x] Home `DEMO_OVERVIEW` updated to describe production-faithful mode (async confirmation, real default-deny + KYC onboarding, multi-user session, mock counterparty unlocking the single-side close, operator panel) + the honest real-vs-mocked framing; Home regression test kept green.
- [x] Enriched the boot `FAITHFUL_MODE_BANNER` to name default-deny gate + reconcile (real) and KYC issuer + price feed (mocked), aligned with `/mode`.
- [x] Tests: `routes/mode.test.ts` (faithful/paper/read-only arrays), `components/mode-banner.test.tsx` (per-mode text + graceful degrade + always present), Home regression stays green.

## Dev Notes

### Scope
This story FINALISES the faithful seam — it does NOT rebuild the 9.1–9.5 mocks (they already exist and are composed in `serve.ts`). It adds: (1) a mode-reporting endpoint, (2) an always-visible web banner, (3) the deploy doc, (4) the Home overview upkeep, and aligns the boot banner. Additive: `paper` and read-only behaviours are unchanged; the deployed contracts are untouched; no real capital moves; the three modes coexist. [Source: epics.md Story 9.6; addendum §J FR-33]

### Architecture constraints
- The mode endpoint is driven from the COMPOSITION (`deriveEngineMode(deps)` inspects which ports are actually wired) so the report can never drift from what the server really composed. Faithful is detected by the faithful-only deps (`kycRegistry` + `confirmationSettings`); paper by the write services without them; read-only otherwise. [Source: serve.ts composition; app.ts `ApiDeps`]
- `/mode` is a plain read route (NOT 503-gated) — it always reports the running mode, behind the same one basic-auth `onRequest` gate as every other route (`serve.ts buildServer`). [Source: serve.ts]
- Money rules N/A (no monetary values cross `/mode`). Schema is the single source (Zod → OpenAPI + web `import type`). [Source: schemas.ts, contract-types.ts]
- Web: NO new design system — the banner reuses the existing token classes (`bg-muted`/`text-muted-foreground`/accent), label-bearing not colour-only (UX-DR8), `role="status"`. [Source: divergence-banner.tsx, status-badge.tsx]

### P0 interpretations (documented, ambiguous calls)
- **P0-1 — mode derivation source.** The brief says "drive this from the composition (not a hardcoded guess)". `ApiDeps` carries no explicit mode flag, so `deriveEngineMode` infers the mode from the actually-composed ports rather than re-reading `ENGINE_MODE`. This is strictly MORE accurate (it reflects what was wired, not what was requested) and matches the existing 503-gated route tests' build-with/without-deps pattern.
- **P0-2 — real/mocked array wording.** The exact strings are not specified; they follow the FR-33 AC enumeration (real: ledger, contracts, default-deny gate, reconcile; mocked: chain transport latency, KYC issuer, counterparty, price feed) plus the session identity (mock, web-side, both interactive modes). Paper's mocked list is honest to paper's real shortcuts (instant auto-confirm, paper-ALLOW authorization), NOT faithful's.
- **P0-3 — Railway default flip.** Per the brief, the live deployed default is NOT silently changed. `railway.toml` documents `faithful` as a supported `ENGINE_MODE`; enabling it on the live service is the operator's call — set the `ENGINE_MODE=faithful` Railway service variable (no secret, no redeploy of the image needed). **Orchestrator/operator action:** flip `ENGINE_MODE` from `paper` to `faithful` in the Railway service variables to serve the faithful demo.

### Testing standards
- API: in-process Fastify `inject` over `buildApp(deps)` with / without the faithful deps (no DB, no chain) — the established 503-gated route test pattern (`faithful-onboarding.test.ts`).
- Web: jsdom + Testing Library, a fixture-backed `Partial<ApiClient>` + `QueryClient({ retry: false })` — the established surface-test pattern (`operator-panel.test.tsx`). The banner must render per-mode text, degrade gracefully on a rejected `getEngineMode`, and always be present.

## Dev Agent Record

Agent Model Used: claude-opus-4-8[1m]

### Debug Log

- Initial `tsc -b` failed with EOF parse errors in all five new files — a stray `</content>` line had been appended at write time; stripped it from each, after which typecheck passed clean.
- `mode-banner.test.tsx` "degrades gracefully" first failed because `findByRole` resolved during the LOADING fallback (before the query settled to error); wrapped the error-specific assertion in `waitFor`.

### Completion Notes

- **Mode endpoint.** `GET /mode` returns `{ engineMode: 'paper' | 'faithful' | 'read-only', real: string[], mocked: string[] }`, DERIVED from the actual composed deps via `deriveEngineMode(deps)` (`engine-mode.ts`) — faithful iff the KYC registry + the async-confirmation store are both wired (the faithful-only ports), paper iff the write services are composed without them, read-only otherwise. Always available (never 503-gated) and behind the same one basic-auth gate as every route (registered in `buildApp`).
  - faithful REAL: double-entry ledger; outbox/saga commit-point + compensation; default-deny authorization gate; position↔pair reconciliation; deployed contracts (unchanged). faithful MOCKED: on-chain confirmation latency + injectable failure; KYC/AML claim issuer; counterparty/inventory model; price feed; session identity.
- **Web banner.** `ModeBanner` (`components/mode-banner.tsx`) is rendered GLOBALLY in the `Shell` (above the header), reads `useEngineMode()`, and renders the honest per-mode text — faithful "Production-faithful demo — testnet/paper, NO real capital. Mocked: …", paper "Paper simulation …", read-only "Read-only deployment …". It degrades gracefully to a safe honest fallback bar (still naming "NO real capital") while loading and on an unreachable/failed endpoint — ALWAYS present. No new design system (existing token classes, `role="status"`, label-bearing not colour-only).
- **Deploy doc.** `railway.toml` now documents `ENGINE_MODE=faithful` as a supported value alongside `paper` (a non-secret Railway service variable, not baked into the image), how to enable it, and that the live default is unchanged. **Operator action (relay):** flip `ENGINE_MODE` from `paper` to `faithful` in the Railway service variables to serve the faithful demo — no image rebuild, no secret.
- **Home upkeep.** `DEMO_OVERVIEW` badge + lead updated to the two-mode framing + the always-visible real-vs-mocked banner; a new "Production-faithful mode" capability describes async confirmation, the real default-deny + KYC onboarding, multi-user session, the mock counterparty unlocking the single-side close, and the operator panel. The asserted regression labels ("What this proof-of-concept does", "The coupled-coin instrument", "Live price simulation") are preserved.
- **Boot banner.** `FAITHFUL_MODE_BANNER` enriched to name the default-deny gate + reconciliation (real) and the KYC issuer + price feed (mocked), aligned with `/mode` and the FR-33 AC.
- **Additivity confirmed.** No change to the paper / read-only composition; `/mode` is an additive read route; deployed contracts untouched; no real capital path touched. The three modes coexist.
- **Gate (all green):** typecheck ✓ · lint ✓ · test 1122 passed / 131 files ✓ · format + format:check ✓ · check:regime ✓ · check:migrations (up→down→up, 9) ✓ · forge 171 passed ✓ · web build ✓. DB left migrated+seeded.

### File List

Added:
- `prod/packages/api/src/engine-mode.ts`
- `prod/packages/api/src/routes/mode.ts`
- `prod/packages/api/src/routes/mode.test.ts`
- `prod/packages/web/src/components/mode-banner.tsx`
- `prod/packages/web/src/components/mode-banner.test.tsx`

Changed:
- `prod/packages/api/src/schemas.ts` (EngineModeSchema / EngineModeInfoSchema + type)
- `prod/packages/api/src/app.ts` (register `modeRoutes`)
- `prod/packages/api/src/index.ts` (export deriveEngineMode + engine-mode schema/type)
- `prod/packages/api/src/faithful/faithful-mode.ts` (enriched `FAITHFUL_MODE_BANNER`)
- `prod/packages/web/src/lib/contract-types.ts` (EngineModeInfo / EngineMode)
- `prod/packages/web/src/lib/api-client.ts` (`getEngineMode`)
- `prod/packages/web/src/lib/queries.ts` (`useEngineMode`)
- `prod/packages/web/src/app.tsx` (global `<ModeBanner />`)
- `prod/packages/web/src/surfaces/home/home.tsx` (`DEMO_OVERVIEW` upkeep)
- `prod/packages/web/src/test/fixtures.ts` (`engineMode()` fixture)
- `prod/packages/web/src/app.test.tsx` + `surfaces/operator/operator-panel.test.tsx` (wire `getEngineMode` into Shell test clients)
- `railway.toml` (document `ENGINE_MODE=faithful`)

## Senior Developer Review (AI)

Reviewed adversarially across correctness, edge cases, and acceptance.

- **Correctness.** `deriveEngineMode` keys faithful on BOTH faithful-only ports (KYC registry + confirmation store) — a partial/future composition can never falsely claim faithful; it falls back to paper/read-only safely. `/mode` carries no money (NFR-2 N/A). The route is registered in `buildApp`, so it sits behind the single `onRequest` basic-auth gate in the deployed server (verified against `serve.ts`).
- **Edge cases.** Banner: loading and error both render the always-present honest fallback (covered by a test); read-only renders no "Mocked:" segment (covered); `useEngineMode` sets `retry: false` so production degrades fast too. Existing Shell tests that omit `getEngineMode` still pass (graceful degrade); the two representative Shell clients were given the fixture so they stay accurate.
- **Acceptance.** AC1 (faithful composes 9.1–9.5 + logs an explicit real-vs-mocked boot banner) — composition pre-existing in `serve.ts`; boot banner enriched to the FR-33 enumeration. AC2 (always-visible honest mode banner, real vs simulated never ambiguous) — global `ModeBanner`. AC3 (paper/read-only unchanged, contracts untouched, no real capital, Home overview updated) — additive `/mode`, no composition change, `DEMO_OVERVIEW` updated.
- **No High/Med findings.** Two issues surfaced during dev (the stray `</content>` write artifact; the loading-vs-error timing in one test) were fixed before the gate. No scope creep — the 9.1–9.5 mocks were not rebuilt.

Outcome: **Approved** — green gate, architecture-consistent, additive.

### Action Items

- (Operator, not code) Flip the Railway `ENGINE_MODE` service variable `paper → faithful` to serve the production-faithful demo (no image rebuild, no secret) — documented in `railway.toml` and the Dev Notes P0-3.

## Change Log

- 2026-06-20 — Story drafted (create-story), status backlog → ready-for-dev → in-progress.
- 2026-06-20 — Implemented `GET /mode` + `deriveEngineMode`, the global web `ModeBanner`, the `railway.toml` faithful-mode deploy doc, the Home `DEMO_OVERVIEW` upkeep, and the enriched boot banner; added API + web tests. Full gate green (1122 tests). Senior review appended; status → done.
