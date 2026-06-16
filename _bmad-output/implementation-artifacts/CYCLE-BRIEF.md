# Autonomous BMAD-cycle brief (read this fully before starting)

You are running ONE story end-to-end through the BMAD cycle, fully autonomously, at the quality
bar established for Epic 1. Repo root: `/Users/croiseaux/devel/ROSE/rose-engine`. Work there.

## The cycle (do all three phases, in order, no user checkpoints)

1. **create-story** — produce a comprehensive, context-rich story file (see "Story file" below).
   Set its status to `ready-for-dev`. Follow the workflow in
   `.claude/skills/bmad-create-story/` (read it) — but you do NOT need to re-invoke any Skill tool;
   execute the steps directly.
2. **dev-story** — implement test-first / red-green. Drive the FULL gate green (see "Gate").
   Update the story (check tasks, fill Dev Agent Record + File List + Change Log), set status `review`.
   Follow `.claude/skills/bmad-dev-story/` conventions.
3. **code-review** — run a rigorous **adversarial review** across three lenses:
   - *Correctness* (logic bugs, money/precision, transactions, ways a bad state can persist),
   - *Edge cases* (probe the LIVE Postgres with real SQL / a throwaway tsx script),
   - *Acceptance* (every AC element met; no scope creep).
   You MAY spawn parallel sub-agents (Agent tool) for these lenses for independent context; if you
   do, leave the DB migrated+seeded afterward (`pnpm tsx prod/packages/ledger/src/migrate-cli.ts reset`).
   Triage findings (patch real ones, defer/dismiss with reasons), FIX all real High/Med findings,
   add regression tests, re-run the gate green. Append a "Senior Developer Review (AI)" section to
   the story with Action Items. Then set status `done`.
   Auto-approval = green tests + clean lint + architecture-consistent. Fix-and-revalidate up to 3x.

## Inputs to read first
- `_bmad-output/planning-artifacts/epics.md` — find your Epic's overview + your story's section (user story + BDD ACs + source hints).
- `_bmad-output/planning-artifacts/architecture.md` — esp. §Data Architecture, §Naming Patterns, §Implementation Patterns, §Project Structure, the coupled-pair field-type freeze (PRD addendum §D), and any sections your FRs map to.
- The PREVIOUS stories in `_bmad-output/implementation-artifacts/` (read the most relevant 1–2 `*.md`) for established patterns/learnings.
- `_bmad-output/bmm/config.yaml` if present (languages, paths).

## Story file
- Path: `_bmad-output/implementation-artifacts/<story-key>.md` (the key is given to you).
- Start with `---\nbaseline_commit: NO_VCS\n---` frontmatter, then `# Story X.Y: <title>`, `Status:`, `## Story`, `## Acceptance Criteria` (copy the epic's BDD), `## Tasks / Subtasks` (checkboxes), `## Dev Notes` (scope, architecture constraints with `[Source: ...]` cites, prior-story learnings, implementation guidance, testing standards, references), then `## Dev Agent Record` (Agent Model Used = `claude-opus-4-8[1m]`, Debug Log, Completion Notes, File List), and a `## Change Log`.

## Sprint status
- File: `_bmad-output/implementation-artifacts/sprint-status.yaml`. Advance YOUR story key through
  `backlog → ready-for-dev → in-progress → review → done` at each phase, and bump `last_updated`.
  Do NOT touch other stories. (Epic status is managed by the orchestrator.)

## Established project conventions (Epic 1 — follow exactly)
- **Monorepo:** pnpm + Turborepo; PROD packages under `prod/packages/*` (`@rose/shared`, `@rose/config`, `@rose/ledger`). New package → add to root `tsconfig.json` `references` and (if it imports another PROD pkg) add a `references` entry in its own `tsconfig.json` + a `workspace:*` dep. Run `pnpm install`.
- **TypeScript 5.9, strict, ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.** Files `kebab-case.ts`; types `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. Package tsconfig must NOT exclude `*.test.ts` (so `tsc -b` typechecks tests). Use `import type` for type-only imports.
- **Money:** integer smallest-units as `bigint`; NEVER binary float (NFR-2). Use `@rose/shared` (`money`, `fromDecimalString`, `toDecimalString`, `allocate`, `splitInTwo`, `assertNotFloat`). Money over the wire = decimal strings.
- **Validation:** **Zod** at boundaries (it's a dep of `@rose/config`; add to your package if needed). Typed error classes for refusals (cf. `ConfigRefusalError`, `AccountPlacementError`, `UnbalancedEntryError`).
- **DB / Drizzle (`@rose/ledger`):** PostgreSQL 18, drizzle-orm 0.45.x, `pg`. snake_case **plural** tables, `id uuid pk default gen_random_uuid()`, FK `<singular>_id`, enums = exact PRD-glossary UPPERCASE codes, indexes `idx_<table>_<cols>`.
  - **Coupled-pair freeze (PRD addendum §D / architecture §Data Architecture):** `anchor_price decimal(18,8)`, `leverage decimal` (per-pair, never hard-coded), `collateral_pool` integer smallest-unit as **NUMERIC** (not bigint), `floor decimal`, `state` enum `PENDING|ACTIVE|REBALANCING|PARTIAL|SETTLING|CLOSED`, `reference_asset text`, `timestamptz`. **The schema must make a persistent single-leg pair UNREPRESENTABLE.**
- **Migrations:** typed modules embedding raw SQL with `up`/`down`, in `prod/packages/ledger/src/migrations/NNNN-*.ts`, registered append-only in `migrations/index.ts`. Epic 1 ended at migration `0002`; your next is `0003`. The runner (`migrate.ts`: `migrateUp/migrateDown/hardReset`, version-sorted, advisory-locked) and `migrate-cli.ts` (`up|down|reset|verify`) already exist. `pnpm check:migrations` runs `verify` (up→down→up) and must stay green. NEVER edit a migration from a DONE story; add a new one.
- **Double-entry invariant (Story 1.5):** balance is enforced in the DB **per (asset, decimal_scale)** by a DEFERRABLE INITIALLY DEFERRED trigger on `postings`. Issuance/recording must produce entries that balance per-asset. Use `recordJournalEntry(db, {description, coupledPairId?, postings:[{accountId, direction, amount:bigint}]})` from `@rose/ledger` (Story 1.6) — it validates ≥2 postings, per-asset balance, integer amounts, and links an optional `coupledPairId`. The `journal_entries.coupled_pair_id` column already exists (nullable, no FK yet — add the FK when you create the `coupled_pairs` table).
- **Tests:** Vitest, co-located `*.test.ts`. DB integration tests share ONE database and run **serially** (`vitest.config.ts` already sets `fileParallelism:false`). Pattern: `createPool`/`createDb`, `hardReset(pool)`+`migrateUp(pool)` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE <t> CASCADE` for per-test isolation. Test-first on invariants (NFR-6).

## Environment
- **PostgreSQL 18 runs in docker on host port 5544** (user `rose` / pass `rose` / db `rose_engine`). `DATABASE_URL` defaults to `postgres://rose:rose@localhost:5544/rose_engine` (see `prod/packages/ledger/src/db.ts`). If the container is down: `docker compose up -d` and wait for `pg_isready`.
- **Not a git repo.** Make NO git commits. `baseline_commit: NO_VCS`.
- Node is v20 locally (architecture targets Node 24 — CI pins it); the toolchain runs fine on 20 (pnpm prints a non-fatal engine warning).

## Gate (must ALL be green before marking review/done)
```
pnpm typecheck   # tsc -b
pnpm lint        # eslint .
pnpm test        # vitest run  (DB must be up)
pnpm format      # then: pnpm format:check  (prettier)
pnpm check:regime
pnpm check:migrations   # verify up→down→up
(cd prod/contracts && forge test)
```
Run `pnpm format` to normalize before `format:check`. If lint/types fail, fix and re-run.

## Scope discipline
Implement ONLY your story's ACs. Do not pull forward later stories. Flag any genuinely ambiguous
product decision in the story notes as a documented P0 interpretation rather than inventing scope.

## Final report (your last message back to the orchestrator)
Return a concise summary: story key, final status, what you built (files/packages), AC verdict,
the key review findings you fixed, the final gate result (test count etc.), and any
deferred/documented decisions. Keep it tight — the orchestrator relays it, it is not shown to the user directly.
