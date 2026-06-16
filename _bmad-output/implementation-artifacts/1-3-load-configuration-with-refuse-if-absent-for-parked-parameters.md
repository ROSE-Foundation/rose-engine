---
baseline_commit: NO_VCS
---

# Story 1.3: Load configuration with refuse-if-absent for parked parameters

Status: done

## Story

As an internal operator,
I want a typed config loader that refuses to start when a parked parameter is missing,
so that the system never silently defaults a correctness-critical value to zero (NFR-4, §11.2).

## Acceptance Criteria

**AC-1 — Present config yields a validated typed object**
**Given** a config with all required values present
**When** the typed config loader runs
**Then** it returns a validated, typed config object (Zod-validated) from `.env` / config sources

**AC-2 — Absent parked parameter is refused by name, never defaulted**
**Given** a config missing a parked parameter (Note coupon, use-of-proceeds split, conversion-to-participation, backing-float floor, model floor params `m` or `g`)
**When** the loader runs or that value is requested
**Then** it raises an explicit refusal error naming the missing parameter
**And** it never substitutes a default (e.g. 0) for the absent value

## Tasks / Subtasks

- [x] **Task 1 — `config` package skeleton (AC: 1)**
  - [x] Create `prod/packages/config/` with `package.json` (`@rose/config`, ESM, `build: tsc -b`), `tsconfig.json` (extends base, composite, references `@rose/shared` if needed), `src/index.ts`.
  - [x] Add **`zod`** as a dependency of `@rose/config` (the architecture's chosen validation library; first use is here — AC-1 requires Zod-validated config). Run `pnpm install`.
- [x] **Task 2 — Parked-parameter schema (AC: 1, 2)**
  - [x] `src/config.ts`: a Zod schema for the six parked parameters, read from env keys: `NOTE_COUPON`, `USE_OF_PROCEEDS_SPLIT`, `CONVERSION_TO_PARTICIPATION`, `BACKING_FLOAT_FLOOR`, `MODEL_FLOOR_M`, `MODEL_FLOOR_G` (these match the `.env.example` placeholders from Story 1.1).
  - [x] Each parked param is **required** (no Zod `.default()`), validated as a non-empty decimal string (reject empty/whitespace and non-decimal). Represent as decimal strings (never JS `number`) per NFR-2 — env values are strings; do not coerce to float.
  - [x] Export the inferred `RoseConfig` type (derived from the Zod schema).
- [x] **Task 3 — Refuse-if-absent loader (AC: 2)**
  - [x] `loadConfig(env = process.env): RoseConfig` — validate `env` against the schema. On success, return the typed object. On failure, throw a `ConfigRefusalError` whose message **names every missing/invalid parked parameter** (map Zod issues → the env key names). **Never** substitute a default (e.g. 0) for an absent value.
  - [x] `ConfigRefusalError` is a typed `Error` subclass carrying the list of offending keys (for programmatic handling / structured logging — NFR-3/§11).
- [x] **Task 4 — Tests (AC: 1, 2)**
  - [x] Co-located `config.test.ts` (Vitest): a fully-populated env → returns the typed object with the exact values; each parked param individually absent → `loadConfig` throws `ConfigRefusalError` whose message contains that param's name; empty-string value → also refused (not treated as present); confirm **no default substitution** (a missing `BACKING_FLOAT_FLOOR` never yields `0`); invalid (non-decimal) value → refused naming the key.
  - [x] Pass a plain object as `env` (do not mutate `process.env`).
- [x] **Task 5 — Verification gate (AC: 1, 2)**
  - [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:regime` all green. Confirm `@rose/config` builds under `tsc -b` (add it to the root solution `tsconfig.json` references).

## Dev Notes

### Scope
- IS: a typed, fail-closed config loader for the **parked parameters** (§11.2) with refuse-if-absent. IS NOT: consuming the values (downstream stories), nor a full infra-config system. Infrastructure values (`DATABASE_URL`, `SEPOLIA_RPC_URL`) are out of scope here — add them when a story needs them; this story is specifically about the **parked parameters** the PRD forbids defaulting.

### Architecture constraints (authoritative)
[Source: architecture.md#Authentication & Security (Secrets/config), #Cross-Cutting Concerns, NFR-4]
- A **typed config loader that refuses on absent parked parameters**. `.env` (+ `.env.example`). No secrets in client-side code; deployer/transfer-agent keys handled out-of-band.
- **Fail-closed (NFR-4):** absent config ⇒ **refusal, never permissive default**. "Absent configuration (e.g. a missing floor) yields refusal, never a permissive default" — and specifically **never default to 0**.
- **Zod** schemas at every boundary (config load is a boundary); domain types derived from Zod.
  [Source: architecture.md#Data Architecture]
- The parked parameters (§11.2 / epics Additional Requirements): **Note coupon, use-of-proceeds split, conversion-to-participation, backing-float floor, model floor params `m` and `g`.**

### Prior-story learnings (Stories 1.1, 1.2)
- TS 5.9 strict ESM, `verbatimModuleSyntax` (use `import type`), `noUncheckedIndexedAccess`. Files `kebab-case.ts`; types `PascalCase`; functions `camelCase`; errors are explicit typed classes.
- A new package mirrors `@rose/shared`'s layout (`package.json` + `tsconfig.json` extending base + `src/`); add the package to the root `tsconfig.json` `references` so `tsc -b` typechecks it (incl. tests — the package tsconfig should not exclude `*.test.ts`, matching the fix applied in Story 1.1).
- Vitest runs from repo root; `vitest.config.ts` `include` already covers `prod/packages/**/*.test.ts` — no change needed.
- Money values stay decimal strings / BigInt; never JS `number` (NFR-2). For monetary parked params (backing-float floor) keep the validated decimal string here; downstream parses with `@rose/shared` money utils when the asset/scale is known.

### Implementation guidance
- **Error message must name the parameter(s).** Map each Zod issue path (the env key) into the thrown message, e.g. `Refusing to start: missing/invalid parked parameter(s): BACKING_FLOAT_FLOOR, MODEL_FLOOR_G`. The test asserts the specific key name appears.
- **No `.default(...)` anywhere** in the schema for parked params — that is the whole point. Treat empty string as absent (`.min(1)` after trim).
- Accept an injectable `env` object (default `process.env`) so tests never touch global state.
- Log nothing sensitive; a structured refusal (key names only) is appropriate (§11 logging at key decision points).

### Testing standards
[Source: architecture.md NFR-6, #Structure Patterns] — Vitest, co-located `*.test.ts`. Cover the happy path and each refusal path; assert no default substitution.

### References
- [Source: epics.md#Story 1.3: Load configuration with refuse-if-absent for parked parameters] — user story + both AC scenarios.
- [Source: architecture.md#Authentication & Security] — typed config loader refusing on absent parked params; `.env`/`.env.example`.
- [Source: architecture.md#Cross-Cutting Concerns / Process Patterns / Enforcement Guidelines] — fail-closed; never invent a parked-parameter value; refuse if absent (§11.2, NFR-4).
- [Source: epics.md#Additional Requirements (Config/security/ops)] — the parked-parameter list.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

Final gate (all green): `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test` → 4 files, 51 tests passed (12 new config tests); `pnpm format:check` → clean; `pnpm check:regime` → 0.

### Completion Notes List

- **AC-1 satisfied:** `loadConfig(env)` returns a Zod-validated, typed, frozen `RoseConfig` (camelCase) from a complete env; unrelated env vars (`PATH`, `DATABASE_URL`) are ignored.
- **AC-2 satisfied:** each absent/empty/invalid parked parameter triggers `ConfigRefusalError` whose message and `missingOrInvalid` list **name the offending env key(s)**; no `.default(...)` anywhere — an absent value never becomes 0. Verified per-key (parametrized test), empty-string-as-absent, non-decimal rejection, and multi-key reporting.
- New package **`@rose/config`** with Zod 3.25.76 (architecture's chosen validation library; first use). Added to root `tsconfig.json` references so `tsc -b` typechecks it (incl. tests).
- `env` is injectable (default `process.env`); tests never touch global state and assert `loadConfig` does not mutate the passed env.
- Scope discipline: only the parked-parameter loader. Infrastructure config (`DATABASE_URL`, `SEPOLIA_RPC_URL`) intentionally out of scope; monetary parked params kept as validated decimal strings (downstream parses with `@rose/shared` when asset/scale is known) — no premature money coupling.

### File List

- `prod/packages/config/package.json` (new)
- `prod/packages/config/tsconfig.json` (new)
- `prod/packages/config/src/config.ts` (new)
- `prod/packages/config/src/index.ts` (new)
- `prod/packages/config/src/config.test.ts` (new)
- `tsconfig.json` (modified — add `@rose/config` to references)
- `pnpm-lock.yaml` (modified — add `zod`)
- `docker-compose.yml` (modified — PG18 mount path `/var/lib/postgresql`; host port 5544; see Change Log)

## Change Log

- 2026-06-15 — Story 1.3 implemented: `@rose/config` typed fail-closed loader for the six parked parameters (Zod-validated decimal strings, `ConfigRefusalError` naming offending keys, never defaults to 0). TDD; 12 tests. All gates green. Status → review.
- 2026-06-15 — Code review (3 adversarial layers) + remediation: refuse a non-object `env` by naming every parked parameter (was emitting `"undefined"`); `.trim()` incidental surrounding whitespace/newlines (aligns with documented intent); derived `PARKED_PARAMETER_KEYS` from the schema + exhaustive `KEY_TO_FIELD` mapping to prevent type/schema drift. +3 tests (54 total). All gates green. Status → done.
- 2026-06-15 — Also fixed `docker-compose.yml` (discovered while bringing up the DB for the next story): PG18 requires the volume at `/var/lib/postgresql`; remapped host port to 5544 to avoid a collision with another local Postgres on 5432.

## Senior Developer Review (AI)

**Reviewer:** Fabrice (AI-assisted, 3 parallel adversarial layers)
**Date:** 2026-06-15
**Outcome:** Approve (after remediation). Both ACs independently confirmed met; fail-closed (NFR-4) honored; all six parked parameters modeled; no scope creep.

### Acceptance verdict
- **AC-1 (present config → validated typed object):** SATISFIED — Zod-validated, typed, frozen `RoseConfig`; unrelated env vars ignored.
- **AC-2 (absent parked param refused by name, never defaulted):** SATISFIED — per-key refusal naming the key; no `.default(...)`; empty/whitespace/non-decimal refused; multi-key reporting; never substitutes 0.

### Action Items
- [x] [Review][Patch][Med] Non-object `env` (`loadConfig(null)`) produced `missingOrInvalid: ["undefined"]` — refused but named no real key (NFR-4 degradation). Fixed: guard non-object env and name every parked parameter; filter stray path-less issues. [prod/packages/config/src/config.ts]
- [x] [Review][Patch][Med] No trimming contradicted the documented "`.min(1)` after trim" intent — an incidental trailing space/newline refused a valid value. Fixed: `z.string().trim()`; returns the trimmed value; whitespace-only still refused. [prod/packages/config/src/config.ts]
- [x] [Review][Patch][Low] `RoseConfig` was hand-written, not linked to the schema (drift risk). Fixed: derive `PARKED_PARAMETER_KEYS` from `schema.shape` and add an exhaustive `KEY_TO_FIELD` mapping (`Record<ParkedParameterKey, keyof RoseConfig>`) used to build the result. [prod/packages/config/src/config.ts]
- [x] [Review][Defer][Low] No semantic/range validation (negatives, splits >1 accepted). Out of scope per the story — parked params are kept as validated decimal strings; range/sign checks belong to the downstream consuming stories where each parameter's valid domain is defined. Documented.
- [x] [Review][Dismiss][Low] "Error message contains literal `...`" — artifact of the abbreviated code shown to the reviewer; the real message is complete (`config.ts` `ConfigRefusalError`). No action.
