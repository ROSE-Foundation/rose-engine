# BMAD Cycle Report — Epic 1: Project Foundation & Double-Entry Ledger Spine

**Date:** 2026-06-15 → 2026-06-16
**Project:** rose-engine
**Pipeline:** create-story → dev-story → code-review, per story, fully autonomous (zero user checkpoints)
**Run:** "all stories of epic 1 one after the other"
**Final status:** ✅ **Epic 1 DONE** — all 6 stories `done`

---

## Outcome at a glance

| Story | Title                                                        | Result  |
| ----- | ------------------------------------------------------------ | ------- |
| 1.1   | Two-regime monorepo scaffold + regime-boundary CI guard      | ✅ done |
| 1.2   | Exact-money utilities in `@rose/shared`                      | ✅ done |
| 1.3   | Config loader with refuse-if-absent for parked parameters    | ✅ done |
| 1.4   | Four fixed entities + typed accounts + reversible migrations | ✅ done |
| 1.5   | Double-entry invariant in the database (test-first)          | ✅ done |
| 1.6   | Record balanced journal entries with postings                | ✅ done |

**Final verification gate (all green):** `typecheck` · `lint` · **Vitest 90/90** · `format:check` · `check:regime` · `check:migrations` (up→down→up over 2 migrations) · **forge 3/3**.

**Delivered packages:** `@rose/shared` (exact money), `@rose/config` (fail-closed config), `@rose/ledger` (entities/accounts/journal-entries/postings + reversible migration runner + DB-enforced double-entry invariant), plus the Foundry contract scaffold.

---

## Per-story summary

### 1.1 — Scaffold + regime guard

pnpm + Turborepo monorepo (Node 24 target, TS 5.9 strict ESM, Vitest, ESLint 10 flat config, Prettier), `@rose/shared` seed, Foundry under `prod/contracts` with OpenZeppelin 5.6.1, the load-bearing regime-boundary guard, CI workflow. **Review:** 1 High (guard pruned `lib`/`dist` at any depth → a `/prod/src/lib` leak could evade) fixed; comment/template-literal/Windows-path hardening; +7 guard tests.

### 1.2 — Exact money

`Money` = bigint smallest-units + decimal scale; float rejected at every boundary; decimal-string (de)serialization; largest-remainder `allocate`/`splitInTwo` that preserve totals exactly (the `V_A+V_B=K` primitive). **Review:** scale-vs-known-asset guard + runtime `Object.freeze` added; negative-total `allocate` proven sum-preserving.

### 1.3 — Fail-closed config

`@rose/config` Zod-validated loader for the six parked parameters; `ConfigRefusalError` names every offending key; never defaults to 0. **Review:** non-object-env naming, `.trim()`, schema-derived keys (anti-drift) added. Also fixed `docker-compose.yml` (PG18 mount path; host port 5544 to avoid a local 5432 collision).

### 1.4 — Entities + accounts + reversible migrations

`@rose/ledger` with Drizzle 0.45.2 schema, a custom up/down migration runner (drizzle-kit is forward-only), the four seeded entities (fixed enums), account constraints, and the P0 routing-rule guard. `check:migrations` now verifies up→down→up; CI gained a `postgres:18` service. **Review:** 1 High (deterministic seed UUIDs so down→up restores identity) + scale guard + advisory-lock/version-sort/guarded-rollback hardening.

### 1.5 — Double-entry invariant (test-first)

`DEFERRABLE INITIALLY DEFERRED` constraint trigger on `postings` enforcing balance at COMMIT; raw-SQL tests written **first** (red→green) prove balanced-commit, unbalanced-fails-with-no-partial-state, bypass-resistance, and deferral. **Review:** 2 High closed — balance now enforced **per (asset, scale)** (no netting EUR against BTC) and the trigger re-checks **both** entries on a posting move; integer-amount CHECK added.

### 1.6 — Record balanced journal entries

`recordJournalEntry` / `getJournalEntry` — balanced (per-asset) ≥2-posting entries, non-empty description, optional coupled-pair link, bigint integer amounts (no float), transactional insert with the DB trigger as backstop, append-oriented attributable read path. **Review:** defensive `numeric→bigint` read, direction/UUID validation, consistent typed errors.

---

## How each story ran (the pipeline)

For every story: **create-story** produced a context-rich spec (architecture-cited, tightly scoped, variances flagged) → **dev-story** implemented test-first/red-green and drove the full gate green → **code-review** launched **3 parallel adversarial layers** (Blind Hunter, Edge Case Hunter, Acceptance Auditor; the DB stories' hunters ran against the live Postgres). Findings were triaged (patch / defer / dismiss), real findings fixed, and the gate re-run before sign-off. Sprint status advanced `backlog → ready-for-dev → in-progress → review → done` at each stage.

**Auto-approval criteria** (green tests, clean lint, architecture-consistent) were met at every sign-off; the several High-severity review findings were fixed and re-validated automatically — no retry budget exhausted, no user checkpoint hit.

## Key engineering decisions & variances (all documented in the stories)

- **TypeScript pinned 5.x** (resolver defaulted to 6.x; architecture mandates 5.x); **ESLint 10 flat config** instead of `.eslintrc.cjs`.
- **Node 24** is the CI target; local dev ran on Node 20 (toolchain-compatible; non-fatal engine warning).
- **OpenZeppelin vendored** (committed, not a git submodule) because the repo is not a git repository — this is what makes the Foundry CI job work on a clean checkout.
- **Migrations are typed modules embedding raw SQL** + a custom up/down runner (drizzle-kit emits forward-only) to realize NFR-5 reversibility, verified in CI.
- **Double-entry balance is per (asset, scale)** — strengthened beyond the literal "Σ debits = Σ credits" wording to correct multi-currency accounting (NFR-1 integrity-by-construction).
- **Local Postgres on host port 5544** (a `docker-compose.yml` fix) to avoid colliding with an unrelated local Postgres on 5432.

## Carry-forward / notes

- **No git commit made** — the repo is not a git repository and project policy requires an explicit request to commit. Everything (including the committed vendored Foundry libs) is ready to `git init` + commit when desired.
- **Deferred, documented:** zero-posting / minimum-cardinality DB enforcement is handled at the application boundary (`recordJournalEntry` requires ≥2 postings) + append-only discipline; routing-policy placements (e.g. HOLDING) are the flagged P0 interpretation pending product confirmation; `coupled_pair_id` FK lands with the `coupled_pairs` table in Epic 2.
- **Next:** Epic 1 retrospective is `optional`; the next backlog work is **Epic 2 (Coupled-Pair Contract & Lifecycle)**, starting at story 2.1.
