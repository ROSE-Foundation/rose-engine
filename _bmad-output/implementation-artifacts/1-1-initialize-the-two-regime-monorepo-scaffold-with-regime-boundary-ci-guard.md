---
baseline_commit: NO_VCS
---

# Story 1.1: Initialize the two-regime monorepo scaffold with regime-boundary CI guard

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a build engineer,
I want a pnpm + Turborepo monorepo with explicit `/prod` and `/throwaway` regimes and a CI guard enforcing the boundary,
so that I can move fast on validation code without any risk of it becoming a production dependency.

## Acceptance Criteria

**AC-1 — Empty scaffold is green end-to-end**
**Given** a clean working tree
**When** I initialize the workspace following the architecture scaffold (Node 24 LTS, pnpm, Turborepo, `tsconfig.base.json`, ESLint, Prettier, Vitest, Foundry under `prod/contracts`)
**Then** `pnpm install`, typecheck, lint, and `pnpm test` all succeed on an empty scaffold
**And** top-level `/prod` and `/throwaway` regime roots exist with a `tools/check-regime-boundary.mjs` script
**And** the CI workflow (`.github/workflows/ci.yml`) runs typecheck, ESLint, Vitest, `forge test`, the migration check, and the regime guard

**AC-2 — Regime guard fails on a forbidden import (and only that direction)**
**Given** a file under `/prod` that imports from `/throwaway`
**When** the regime-boundary guard runs in CI
**Then** the check fails with an explicit error naming the offending import
**And** the reverse (`/throwaway` importing `/prod`) is tolerated

## Tasks / Subtasks

- [x] **Task 1 — Workspace root + package manager (AC: 1)**
  - [x] Create root `package.json` (`"private": true`, `"type": "module"`, `"packageManager": "pnpm@10.30.2"`, `engines.node`/`engines.pnpm`). Pin pnpm via `packageManager` so corepack resolves it.
  - [x] Create `pnpm-workspace.yaml` with packages: `prod/packages/*`, `prod/contracts` excluded from the TS workspace (Foundry-managed, not a pnpm package).
  - [x] Add root dev deps exactly per architecture: `turbo`, `typescript`, `@types/node`, `vitest`, `tsx`, `drizzle-kit`, `eslint`, `prettier` (+ `@eslint/js`, `typescript-eslint` for flat config). TypeScript pinned to 5.x per architecture (resolver defaulted to 6.x — overridden).
  - [x] Add root scripts: `typecheck`, `lint`, `format`, `test`, `check:regime`, `check:migrations`, `build`.
- [x] **Task 2 — Turborepo + TS project-references config (AC: 1)**
  - [x] `turbo.json` with pipeline tasks `build`, `typecheck`, `lint`, `test` (declare `dependsOn`, `outputs`).
  - [x] `tsconfig.base.json` — `strict: true`, ESM (NodeNext), `composite: true` for project references; root solution `tsconfig.json` references `prod/packages/shared`; per-package `tsconfig.json` extends the base.
- [x] **Task 3 — Lint/format config (AC: 1)**
  - [x] `eslint.config.js` (ESLint 10 flat config — current major; story permits this over `.eslintrc.cjs`) with `typescript-eslint`, ESM, and a `no-restricted-imports` rule forbidding `/throwaway` imports from `/prod` source globs (belt-and-suspenders alongside Task 5).
  - [x] `.prettierrc` and `.prettierignore`.
  - [x] `.gitignore` (node_modules, dist, `.turbo`, coverage, `prod/contracts/out`, `prod/contracts/cache`, `.env`).
- [x] **Task 4 — Regime roots + a minimal placeholder TS package so the toolchain has something to run (AC: 1)**
  - [x] Created `prod/packages/shared/` as a minimal valid package (`package.json`, `tsconfig.json`, `src/index.ts` trivial export, `src/index.test.ts` one passing Vitest test). Minimal — no money utils (Story 1.2).
  - [x] `throwaway/` regime root present (contains `mockups/`); kept OUTSIDE the pnpm `prod/packages/*` workspace globs.
- [x] **Task 5 — Regime-boundary guard script (AC: 1, 2)**
  - [x] `tools/check-regime-boundary.mjs`: scans `prod/` source for `import`/`export ... from`/dynamic `import()`/`require()` whose specifier resolves into `/throwaway` (literal segment OR resolved relative path). On violation: explicit error naming the offending file + specifier, `exit(1)`; clean: `exit(0)`. Exports `scanForRegimeViolations` for testing.
  - [x] Reverse direction (`/throwaway` → `/prod`) explicitly tolerated — throwaway not scanned. Covered by a dedicated test.
  - [x] Wired as root script `check:regime` and into `ci.yml`.
- [x] **Task 6 — Foundry under `prod/contracts` (AC: 1)**
  - [x] `forge init --no-git prod/contracts`; OpenZeppelin 5.6.1 vendored into `lib/` (clone, no submodule — repo is not git; `forge install` requires git). `@openzeppelin/contracts/` remapping pinned in `remappings.txt`.
  - [x] `prod/contracts/foundry.toml` configured (solc 0.8.28, optimizer); `forge build` + `forge test` pass (init Counter tests + an OZ-resolution smoke test).
- [x] **Task 7 — CI workflow (AC: 1, 2)**
  - [x] `.github/workflows/ci.yml`: job 1 = pnpm install (frozen lockfile) → typecheck → lint → Vitest → migration check (placeholder) → regime guard; job 2 = Foundry → `forge build`/`forge test`.
  - [x] `setup-node` pinned to Node `24` (see Project Structure Notes / Node version variance).
- [x] **Task 8 — Supporting root files (AC: 1)**
  - [x] `.env.example` (structured placeholders; no secrets/real values).
  - [x] `docker-compose.yml` declaring a PostgreSQL 18 service (presence only; not started).
  - [x] `README.md` documenting layout, regime rule, and dev commands.
- [x] **Task 9 — Verification gate (AC: 1, 2)**
  - [x] Ran `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations`, and `forge test` — all green.
  - [x] Proved AC-2: a temporary `/prod` file importing `/throwaway` made `check:regime` exit `1` naming the file + specifier; removed the file; `check:regime` then exited `0` (output in Completion Notes).

## Dev Notes

### What this story is (and is NOT)
- **IS:** the monorepo skeleton + tooling + the regime-boundary CI guard. This is the **first implementation story** (Architecture §"Selected Approach", §"Implementation sequence" step 1).
- **IS NOT:** any domain logic. No money utils (Story 1.2), no config loader (Story 1.3), no Drizzle schema/migrations or double-entry trigger (Stories 1.4/1.5). Do not pull work forward. The only TS code is a trivial placeholder so the toolchain runs green.

### Architecture-mandated scaffold (authoritative)
[Source: architecture.md#Selected Approach: Custom pnpm + Turborepo monorepo]
- Language/runtime: **TypeScript 5.x on Node.js 24 LTS**; ES modules; `strict` everywhere.
- Monorepo: **pnpm workspaces + Turborepo**; `/prod` and `/throwaway` as top-level regime roots; CI guard asserts `/prod` never imports `/throwaway`.
- Build tooling: `tsx` (dev), `tsc` project references (build), Turborepo pipeline.
- Testing: **Vitest** (TS); **Foundry/`forge`** (Solidity, incl. fuzz/invariant later).
- Lint/format: **ESLint + Prettier**.
- Initialization commands (run these, adapting paths):
  ```bash
  corepack enable && corepack prepare pnpm@latest --activate
  pnpm init
  pnpm add -D turbo typescript @types/node vitest tsx drizzle-kit eslint prettier
  forge init --no-git prod/contracts
  forge install OpenZeppelin/openzeppelin-contracts
  ```

### Exact directory structure to realize
[Source: architecture.md#Complete Project Directory Structure] — create the root files and the `prod/`, `throwaway/`, `tools/`, `.github/workflows/` skeleton. Do **not** create empty domain packages beyond the minimal `shared` seed; later stories add `config`, `ledger`, `coupled-pair`, `authorization`, `rule-spec`, `chain`, `reconcile`, `rose-note`, `api`, `web`. Reproduce the regime layout exactly:
```
rose-engine/
├── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
├── .eslintrc.cjs  .prettierrc  .env.example  docker-compose.yml  README.md  .gitignore
├── .github/workflows/ci.yml
├── docs/SPEC.md                      # EXISTS — do not touch in this story
├── prod/
│   ├── packages/shared/              # minimal seed only
│   └── contracts/                    # forge init --no-git + OZ
├── throwaway/                        # EXISTS (mockups/) — leave as-is, keep outside workspace
└── tools/check-regime-boundary.mjs
```

### Files that already EXIST — read before touching, do not break
- `docs/SPEC.md` — present; **out of scope** for this story (its update is a separate handoff item). Do not modify.
- `throwaway/mockups/*` — present (HTML mockups). Leave untouched. Just ensure `throwaway/` is not inside the pnpm workspace `packages` globs so it can never be imported by `/prod`.

### Regime-boundary guard — the heart of AC-2
[Source: architecture.md#Communication Patterns, #Enforcement Guidelines; epics.md Story 1.1 AC]
- The guard is the load-bearing artifact of this story. It must:
  - Scan only `/prod` source files (recursively), **never** scan `/throwaway`.
  - Catch static `import`/`export from`, dynamic `import()`, and `require()` specifiers that resolve into `/throwaway` (literal `throwaway`, relative `../../throwaway`, or any alias).
  - On the FIRST (or all) violation(s), emit an explicit message naming the **offending file path and the imported specifier**, then exit non-zero.
  - Tolerate `/throwaway` → `/prod` (do not flag).
- Anti-pattern (forbidden): a guard that only greps the literal string `throwaway` without resolving relative paths, or that silently passes. It must produce a clear named error and a non-zero exit.

### Testing standards
[Source: architecture.md#Structure Patterns]
- TS unit tests co-located as `*.test.ts` next to source, run by **Vitest**.
- Solidity tests in `prod/contracts/test/` as `*.t.sol`, run by `forge test`.
- For this story, "tests pass" = the trivial placeholder Vitest test in `shared` and the Foundry init template test both pass. Do NOT write invariant/domain tests here (those start at Story 1.5, test-first).

### Naming & format rules to honor now (cheap to get right, expensive to retrofit)
[Source: architecture.md#Naming Patterns, #Format Patterns]
- TS files `kebab-case.ts`; types/classes `PascalCase`; functions/vars `camelCase`; constants `UPPER_SNAKE_CASE`.
- ESM everywhere; `strict` TS. No CommonJS in `/prod` TS source (config files like `.eslintrc.cjs` are the allowed exception).

### Logging
- No domain logging in this story (no decision points yet). The regime guard's error output is the only required diagnostic. Keep `console.error` for the guard violation message (it runs as a Node script, not app code).

## Project Structure Notes

### Node version variance — MUST READ
- Architecture requires **Node.js 24 LTS**. The current dev environment runs **Node v20.19.5** (verified at story creation). pnpm 10.30.2, corepack 0.34.2, forge 1.5.1, docker 29.x are present.
- **Resolution for this story:** set `engines.node` to the architecture target (`">=24"` per the decision) in `package.json`, and pin Node `24` in `ci.yml`'s `setup-node`. Locally, the toolchain (pnpm/turbo/tsc/vitest/forge) all run correctly on Node 20, so verification can proceed on v20. If `engines` strictness (`engine-strict`) blocks `pnpm install` locally on Node 20, do **not** weaken the architecture target — instead keep `engine-strict` off (pnpm default warns, not errors) so local install succeeds while CI enforces Node 24. Record the variance in Completion Notes.
- Do not silently downgrade the architecture's Node 24 decision to 20.

### Not a git repository yet
- The working tree is **not** a git repo (verified at creation). `.github/workflows/ci.yml`, `.gitignore`, and the regime guard are still created as files (they are deliverables of AC-1/AC-2), but CI will not actually execute until a repo/remote exists. AC-2 is therefore proven by running `pnpm check:regime` **locally** (Task 9), not by a live GitHub Actions run. `forge init --no-git` is correct given no repo.

### Migration check placeholder
- `ci.yml` must list a migration check step (AC-1 names it), but no migrations exist until Story 1.4. Implement it as a no-op/guarded step now (e.g. a script that exits 0 when no migrations are present) and wire the real drizzle forward/rollback check when Story 1.4 lands. Note this clearly in `ci.yml` as a placeholder.

### Alignment
- Layout matches `architecture.md#Complete Project Directory Structure` exactly. The only intentional variance is the Node runtime version (above), tracked and CI-enforced.

## References

- [Source: epics.md#Story 1.1: Initialize the two-regime monorepo scaffold with regime-boundary CI guard] — user story + both AC scenarios.
- [Source: epics.md#Additional Requirements — Starter / Scaffold] — pnpm+Turborepo, Node 24 LTS, `/prod`+`/throwaway`, CI regime guard `tools/check-regime-boundary.mjs`, TS 5.x ESM strict, tsx/tsc, Vitest+Foundry, ESLint+Prettier, `forge init` + OZ.
- [Source: architecture.md#Selected Approach: Custom pnpm + Turborepo monorepo (no monolithic starter)] — initialization commands and decisions.
- [Source: architecture.md#Complete Project Directory Structure] — authoritative tree.
- [Source: architecture.md#Communication Patterns] — "single chokepoint / regime guard proven by a check"; regime rule `/prod` ↮ `/throwaway`.
- [Source: architecture.md#Infrastructure & Deployment] — CI/CD GitHub Actions steps: typecheck, ESLint, Vitest, `forge test`, drizzle migration check, regime dependency rule; docker-compose PostgreSQL 18.
- [Source: architecture.md#Enforcement Guidelines / Anti-patterns] — never let `/prod` import `/throwaway`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final verification gate (all green):
- `pnpm typecheck` (`tsc -b`) → exit 0
- `pnpm lint` (`eslint .`) → exit 0
- `pnpm test` (`vitest run`) → 2 files, 9 tests passed
- `pnpm format:check` → "All matched files use Prettier code style!"
- `pnpm check:regime` → exit 0 ("Regime boundary OK")
- `pnpm check:migrations` → exit 0 (placeholder: no migrations dir yet)
- `forge test` (in `prod/contracts`) → 2 suites, 3 tests passed

AC-2 proof (temporary probe under `/prod` importing `/throwaway`):
```
❌ Regime boundary violation: /prod must never import from /throwaway.
  prod/packages/shared/src/__regime_violation_probe.ts imports '../../../../throwaway/simulator/thing.js'
1 violation(s) found.    >>> exit code: 1
```
After removing the probe: `✅ Regime boundary OK` → exit code 0.

### Completion Notes List

- **AC-1 satisfied:** empty scaffold is green end-to-end (`pnpm install`, typecheck, lint, test). `/prod` and `/throwaway` regime roots exist; `tools/check-regime-boundary.mjs` present. `.github/workflows/ci.yml` runs typecheck, ESLint, Vitest, migration check, regime guard, `forge build`/`forge test`.
- **AC-2 satisfied:** guard fails with an explicit named error and non-zero exit on a `/prod`→`/throwaway` import; tolerates the reverse. Proven by both an automated Vitest suite (8 cases) and a live CLI probe (above).
- **Resolved decision — TypeScript version:** the pnpm resolver defaulted to TypeScript 6.x; pinned to `^5` (5.9.3) to honor the architecture's "TypeScript 5.x" mandate and avoid typescript-eslint v8 peer-range friction. `@types/node` pinned to `^24` to match the Node 24 LTS target.
- **Resolved decision — ESLint config format:** used ESLint 10 flat config (`eslint.config.js`) instead of the architecture tree's `.eslintrc.cjs`; the current ESLint major uses flat config and deprecates eslintrc. Behavior is equivalent (lint TS + forbid `/throwaway` imports from `/prod`). Story Task 3 explicitly permitted this.
- **Resolved constraint — OpenZeppelin install without git:** the repo is not a git repository, so `forge install` (git submodules) is unavailable. Vendored OZ Contracts **5.6.1** by cloning into `prod/contracts/lib/openzeppelin-contracts` and stripping the nested `.git`; pinned the `@openzeppelin/contracts/` remapping in `remappings.txt`. Added `test/OpenZeppelinResolves.t.sol` to prove the dependency resolves and compiles.
- **Node version variance (carried forward):** environment runs Node v20.19.5; architecture targets Node 24 LTS. `engines.node` set to `>=24` and CI pinned to Node 24; the toolchain runs correctly on Node 20 locally (pnpm emits an "Unsupported engine" WARN only, not an error), so local verification proceeded. No architecture decision was downgraded.
- **Migration check is a deliberate placeholder** (`tools/check-migrations.mjs`): passes (exit 0) when no migrations dir exists; Story 1.4 replaces it with the real Drizzle forward/rollback verification.
- **No git commit made** (no VCS; and per project policy commits are not made without an explicit request).
- **Scope discipline:** no domain logic implemented. `shared` is a minimal seed; no money utils, config loader, schema, or triggers (those are Stories 1.2–1.6).
- Generated artifacts (`node_modules/`, `prod/packages/shared/dist/`, `*.tsbuildinfo`, `prod/contracts/out`, `prod/contracts/cache`) are git-ignored and not listed below. **The vendored Foundry libs under `prod/contracts/lib/` are intentionally committed (NOT git-ignored)** — because they are plain clones (not git submodules), committing them is what makes the `contracts-foundry` CI job have OpenZeppelin/forge-std on a clean checkout.

### File List

**Root config (new):**
- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `turbo.json`
- `tsconfig.base.json`
- `tsconfig.json`
- `eslint.config.js`
- `vitest.config.ts`
- `.prettierrc`
- `.prettierignore`
- `.gitignore`
- `.env.example`
- `docker-compose.yml`
- `README.md`

**CI (new):**
- `.github/workflows/ci.yml`

**Tooling (new):**
- `tools/check-regime-boundary.mjs`
- `tools/check-regime-boundary.test.mjs`
- `tools/check-migrations.mjs`

**PROD `shared` package (new):**
- `prod/packages/shared/package.json`
- `prod/packages/shared/tsconfig.json`
- `prod/packages/shared/src/index.ts`
- `prod/packages/shared/src/index.test.ts`

**PROD Solidity / Foundry (`prod/contracts`):**
- `prod/contracts/foundry.toml` (created by `forge init`, then configured)
- `prod/contracts/remappings.txt` (new)
- `prod/contracts/src/Counter.sol` (from `forge init` template)
- `prod/contracts/script/Counter.s.sol` (from `forge init` template)
- `prod/contracts/test/Counter.t.sol` (from `forge init` template)
- `prod/contracts/test/OpenZeppelinResolves.t.sol` (new — OZ resolution smoke test)
- `prod/contracts/README.md` (from `forge init` template)
- `prod/contracts/lib/openzeppelin-contracts/**` (vendored dependency, OZ 5.6.1; committed, not a submodule)
- `prod/contracts/lib/forge-std/**` (vendored dependency; committed, not a submodule)

## Change Log

- 2026-06-15 — Story 1.1 implemented: two-regime pnpm + Turborepo monorepo scaffold (Node 24 target, TS 5.9 strict ESM, Vitest, ESLint flat config, Prettier), `prod/packages/shared` seed, Foundry under `prod/contracts` with OpenZeppelin 5.6.1, regime-boundary guard (`tools/check-regime-boundary.mjs`) with automated + CLI proof, CI workflow, and supporting root files. All ACs satisfied; full gate green. Status → review.
- 2026-06-15 — Code review (3 adversarial layers) + remediation: hardened the regime guard (no longer prunes `lib` by bare name so `src/lib/` source is scanned; strips comments and anchors static imports to avoid false positives; detects backtick/template-literal specifiers; cross-platform CLI self-invocation via `pathToFileURL`; vendored `prod/contracts/lib` pruned by path). Added 7 guard regression tests. Made `tsc -b` typecheck test files. Corrected docs (vendored libs are committed, not git-ignored); removed misleading `submodules: recursive`; added `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`; fixed ESLint-version comment. All gates green (typecheck/lint/test 15✓/format/regime/migrations/forge 3✓). Status → done.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 parallel adversarial layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor)
**Date:** 2026-06-15
**Outcome:** Approve (after remediation). Both ACs independently verified satisfied; all actionable findings patched and re-validated.

### Acceptance verdict
- **AC-1 (empty scaffold green; roots + guard exist; CI runs all six steps):** SATISFIED — verified live (typecheck/lint/vitest/forge/migration-check all pass; ci.yml runs typecheck, ESLint, Vitest, migration check, regime guard, `forge build`/`forge test`).
- **AC-2 (guard fails on `/prod`→`/throwaway` naming the import; reverse tolerated):** SATISFIED — verified by automated tests (15 cases) and a live CLI probe.

### Action Items
- [x] [Review][Patch][High] Regime guard pruned `lib`/`dist`/`out`/`cache` at any depth → a `/prod/src/lib/*.ts` could import `/throwaway` undetected. Fixed: `lib` no longer pruned by bare name; vendored `prod/contracts/lib` pruned by explicit path. [tools/check-regime-boundary.mjs]
- [x] [Review][Patch][Med] Regex scan produced false positives on commented-out imports and import-like strings. Fixed: strip block+line comments; anchor static import/export to line start. [tools/check-regime-boundary.mjs]
- [x] [Review][Patch][Med] Backtick/template-literal `import()`/`require()` specifiers evaded detection. Fixed: accept backtick quotes in call-form patterns. [tools/check-regime-boundary.mjs]
- [x] [Review][Patch][Med] CLI self-invocation check (`file://` string concat) could no-op on Windows / spaced paths, silently passing CI. Fixed: compare against `pathToFileURL(process.argv[1]).href`. [tools/check-regime-boundary.mjs]
- [x] [Review][Patch][Med] `tsc -b` excluded `*.test.ts`, so type errors in tests passed typecheck silently. Fixed: include test files in the `shared` typecheck. [prod/packages/shared/tsconfig.json]
- [x] [Review][Patch][Med] Story/CI misrepresented vendored libs as git-ignored and used a no-op `submodules: recursive`. Fixed: corrected docs (libs are committed, not submodules); removed `submodules: recursive`; added `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. [.github/workflows/ci.yml, story File List/Completion Notes]
- [x] [Review][Patch][Low] ESLint config header said "ESLint 9" (project is on ESLint 10); guard comment overclaimed alias resolution. Fixed both comments. [eslint.config.js, tools/check-regime-boundary.mjs]
- [x] [Review][Defer][Low] Symlink-bridged `/prod`→`/throwaway` not traversed/resolved (requires deliberate setup); empty-`prod` returns no violations. Documented as known limitations in the guard header; revisit if a symlink/alias layout is introduced.
- [x] [Review][Dismiss][Low] Bare-name throwaway *package* import not caught beyond literal `throwaway` segment — `/throwaway` is not in the pnpm workspace, so a bare-name throwaway package is unresolvable from `/prod`; the relative-path detection covers the real case. No action.
