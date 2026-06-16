---
baseline_commit: NO_VCS
---

# Story 3.4: Enforce the minimal P0 rule set via the generated off-chain policy provider

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an internal operator,
I want `OffChainPolicyProvider` to enforce the P0 `flow_permissions` rules generated from the rule-spec,
so that permitted flows pass and forbidden flows (incl. Model-A principal) are rejected off-chain (FR-8, NFR-4).

## Acceptance Criteria

**Given** `flow_permissions` generated from the rule-spec
**When** transfers are evaluated
**Then** `FEE_INCOME` (any entity) → treasury is **allowed**; yield on `CLIENT_COLLATERAL` → treasury is **allowed** (principal excluded)
**And** `CLIENT_COLLATERAL` *principal* → any destination outside the client account is **rejected** (Model-A bright line, UJ-3)
**And** any transfer pushing `BACKING_FLOAT` below its floor is **rejected**; if the floor config is absent it is **refused**, never treated as 0
**And** token/trading flows do not route through VCC accounts; a transfer not covered by any rule is **rejected by default**

**Given** the shared conformance vectors
**When** they are executed against the off-chain plane
**Then** they all pass, establishing the baseline the on-chain plane must also satisfy

## Tasks / Subtasks

- [x] **Task 1 — `flow_permissions` table (migration 0006, append-only + reversible)** (AC: 1)
  - [x] Add `prod/packages/ledger/src/migrations/0006-flow-permissions.ts` (raw SQL `up`/`down`); register append-only in `migrations/index.ts`. NEVER edit a merged migration.
  - [x] Table stores generated policy clauses: `id`, `policy_version`, `source`, `generator`, `default_effect` (CHECK ALLOW|DENY|REFUSE), `clause_kind` (CHECK ALLOW_RULE|PROHIBITION|FLOOR_GUARD), `clause_id` (UNIQUE), `payload jsonb`, `created_at`. Index `idx_flow_permissions_clause_kind`.
  - [x] Add Drizzle schema `prod/packages/ledger/src/schema/flow-permissions.ts` mirroring the migration; export from `schema/index.ts`.
  - [x] `pnpm check:migrations` (up→down→up over 6) stays green.
- [x] **Task 2 — seed `flow_permissions` from the generated artifact (single source)** (AC: 1)
  - [x] `seedFlowPermissions(executor, artifact)` in `@rose/authorization`: idempotent (delete-all + insert-all in one statement-batch), populating rows verbatim from `generateOffChainPolicy(ruleSpecV1)`. Rule logic is NEVER re-authored — only persisted.
  - [x] `loadOffChainPolicy(executor)` reconstructs a byte-identical `OffChainPolicyArtifact` from the rows; fail-closed on an empty table or rows with inconsistent policy metadata (typed errors).
- [x] **Task 3 — DB-backed `OffChainPolicyProvider`, substitutable (zero chokepoint change)** (AC: 1, 2)
  - [x] `loadDbOffChainPolicyProvider(executor)` loads the policy and returns a conformant `AuthorizationProvider` that DELEGATES decisions to the Story-3.1 reference semantics (`makeReferenceOffChainAdapter`) over the DB-loaded artifact — reproducing the reference adapter without re-authoring rules.
  - [x] `assertProviderConforms(provider)` passes the SAME 10 shared vectors via the off-chain `PlaneAdapter` (the conformance gate). No change to `postTransfer`.
- [x] **Task 4 — bind authorization facts to persisted state; compute the floor in NUMERIC** (AC: 1)
  - [x] Validate the declared `from.accountType` against the persisted `accounts.type`; fail-closed (typed `AccountFactMismatchError`) on mismatch — resolves the Story-3.3 trust boundary for the source account type.
  - [x] Resolve `backing_float.floor` via `@rose/config` (`backingFloatFloor`); absent ⇒ `env.backingFloatFloor` undefined ⇒ REFUSE (never 0).
  - [x] Compute `postBalanceBelowFloor` from persisted postings in **NUMERIC/BigInt** (no binary float, NFR-2): `postBalance = balance(from) − amount`, `belowFloor = postBalance < floor`.
  - [x] `enforceTransfer(...)` composes validate-facts → resolve-env → `postTransfer` with the DB provider (the wiring; the chokepoint itself is unchanged).
- [x] **Task 5 — tests (test-first on invariants)** (AC: 1, 2)
  - [x] Policy store: seed idempotent; load round-trips the codegen artifact byte-for-byte; empty/inconsistent table fails closed.
  - [x] DB provider: `assertProviderConforms` green on all 10 off-chain vectors (non-vacuous).
  - [x] Account state / env: NUMERIC balance; floor above ⇒ ALLOW-eligible, below ⇒ DENY, absent ⇒ REFUSE; account-type mismatch rejected.
  - [x] End-to-end via the DB provider + real balances: fee→treasury ALLOW; client principal→external DENY; BACKING_FLOAT above/below floor ALLOW/DENY; floor absent REFUSE; nothing persists on a non-ALLOW.
- [x] **Task 6 — full gate green** (AC: 1, 2)
  - [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm check:regime && pnpm check:migrations` all green; baseline was 237 tests.

## Dev Notes

### Scope (what this story adds, and what it must NOT touch)

This is the LAST story of Epic 3. It supplies the **production, DB-backed off-chain policy provider** that Stories 3.1–3.3 deliberately deferred. It must:

- Persist the **generated** policy in a `flow_permissions` table and read it back — the rule comes from the SINGLE source (`generateOffChainPolicy(ruleSpecV1)`), never re-authored. [Source: architecture.md#Single-source declarative rule spec + codegen]
- Reproduce the Story-3.1 **reference adapter** semantics and pass the SAME 10 conformance vectors via an off-chain `PlaneAdapter`. [Source: prod/packages/rule-spec/src/conformance/reference-off-chain-adapter.ts]
- Resolve the Story-3.3 deferred binding: validate `from.accountType` against persisted account rows, resolve the floor from `@rose/config`, and compute `postBalanceBelowFloor` in NUMERIC. [Source: _bmad-output/implementation-artifacts/deferred-work.md]

**Zero change to the chokepoint** (`postTransfer`): the provider is substitutable (Story 3.2, NFR-8), so wiring is "construct a different provider + build the `env` from DB" — the chokepoint code is untouched. The static `chokepoint-guard` and `assertProviderConforms` gates remain the acceptance gates and must stay green.

**Do NOT** pull forward Epic 4 (on-chain plane), add an `amount` field to the frozen `TransferScenario` vocabulary (Story 3.1 freeze), or edit any merged migration.

### Established interfaces to REUSE (do not redefine)

- `generateOffChainPolicy(ruleSpecV1) → OffChainPolicyArtifact` and its sub-types `FlowPermissionRule | Prohibition | FloorGuard` (codegen, pure, deterministic). [Source: prod/packages/rule-spec/src/codegen/generate-off-chain-policy.ts]
- `makeReferenceOffChainAdapter(policy)` — the canonical OFF_CHAIN semantics (prohibitions first → matched allow-rule → floor guard scoped to that rule → fail-closed default DENY). The DB provider delegates here; it does NOT re-implement the resolution order. [Source: prod/packages/rule-spec/src/conformance/reference-off-chain-adapter.ts]
- `makePolicyAuthorizationProvider(policy, name)` already wraps the reference adapter into an `AuthorizationProvider` (with `reasonFor`). The DB provider is this factory fed a DB-loaded artifact — reuse it; do not duplicate `reasonFor`. [Source: prod/packages/authorization/src/provider/policy-authorization-provider.ts]
- `assertProviderConforms(provider, vectors?, plane?)` + `conformanceVectors` (the 10) + `runConformance`/`assertAllConform`. [Source: prod/packages/authorization/src/conformance/provider-conformance.ts]
- `postTransfer(from, to, amount, context)` — UNCHANGED. It already accepts `context.provider` and `context.env`; the binding layer fills both. [Source: prod/packages/authorization/src/post-transfer.ts]
- `ConformanceEnv { backingFloatFloor?: bigint; postBalanceBelowFloor?: boolean }` — the env shape the adapter consumes; `backingFloatFloor` undefined ⇒ REFUSE; `postBalanceBelowFloor !== false` ⇒ DENY (for a floor-guarded matched rule). [Source: prod/packages/rule-spec/src/conformance/types.ts]
- `fromDecimalString(asset, value, scale).amount` (BigInt smallest-units) to parse the floor decimal. [Source: prod/packages/shared/src/money.ts]
- Ledger: `accounts` (`type`, `asset`, `decimal_scale`) and `postings` (`direction`, `amount` NUMERIC) schemas; `RoseExecutor`; `recordJournalEntry`. [Source: prod/packages/ledger/src/schema/*.ts]

### Architecture constraints

- **Single source of rules:** off-chain `flow_permissions` is GENERATED from the rule-spec, never hand-edited; both planes derive from one spec so they cannot diverge (NFR-8). [Source: architecture.md#245]
- **Money/NUMERIC (NFR-2):** balances summed in Postgres NUMERIC, parsed to BigInt; floor parsed via `@rose/shared`; the floor comparison is BigInt. **No binary float anywhere in PROD.** [Source: architecture.md#138]
- **Fail-closed (NFR-4):** an absent floor is REFUSED, never assumed 0; an empty/corrupt policy table is a loud failure, not a vacuous pass.
- **DB conventions:** snake_case plural tables; `id uuid pk default gen_random_uuid()`; index `idx_<table>_<cols>`; enums/CHECKs use exact UPPERCASE codes. [Source: architecture.md#218]
- **Migrations:** typed module with raw `up`/`down`, registered append-only; reversible (`pnpm check:migrations`); next version is 0006. [Source: CYCLE-BRIEF.md]

### Prior-story learnings (3.1 → 3.3)

- 3.3 explicitly deferred to 3.4: "DB-backed resolution/validation of `accountType`/floor" and the runtime computation of `postBalanceBelowFloor`. Classification and `destinationKind` are NOT persisted columns in P0, so they remain caller-declared facts; this story resolves what IS persisted (account type, asset/scale, balance, floor) and documents the residual. [Source: deferred-work.md]
- `post-transfer.test.ts` shows the DB test idiom: `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `TRUNCATE journal_entries CASCADE` per test, seed accounts under `VCC`/`HOLDING`. Reuse it. [Source: prod/packages/authorization/src/post-transfer.test.ts]
- The chokepoint-guard regex matches `insert(... postings ...)` ONLY; writes to the new `flow_permissions` table do not trip it. The guard must stay green.
- Floor guard is scoped to the matched allow-rule (`allow-backing-float-egress`), NOT to the source account — a flow with no allow-rule must NOT leak a REFUSE. The reference adapter already enforces this; the env builder must only populate floor fields for a genuinely floor-guarded BACKING_FLOAT egress.

### New package dependencies

- `@rose/authorization` → add `@rose/config` (`workspace:*`, for `RoseConfig` + the `backing_float.floor` resolution) and `drizzle-orm` (`^0.45.0`, for `eq`/`sql` on the new table + the NUMERIC balance sum). Add the `../config` project reference to `prod/packages/authorization/tsconfig.json`. Run `pnpm install`.

### Project Structure Notes

- New (NEW): `ledger/src/migrations/0006-flow-permissions.ts`, `ledger/src/schema/flow-permissions.ts`, `authorization/src/flow-permissions/{policy-store,db-policy-provider,account-state,resolve-env,enforce-transfer}.ts` + co-located tests.
- Updated (UPDATE): `ledger/src/migrations/index.ts`, `ledger/src/schema/index.ts`, `authorization/src/index.ts` (export the new surface), `authorization/package.json`, `authorization/tsconfig.json`.
- `postTransfer` and the rule-spec codegen are NOT modified.

### Testing standards

- Vitest, co-located `*.test.ts`; DB integration tests serial (`fileParallelism:false` already set). Test-first on invariants (NFR-6): round-trip determinism, fail-closed empties, floor edges (above/below/absent), account-type mismatch, and the 10 vectors against the DB provider.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.4]
- [Source: _bmad-output/planning-artifacts/architecture.md#Capital-flow authorization / Single-source rule spec]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md]
- [Source: prod/packages/rule-spec/src/codegen/generate-off-chain-policy.ts]
- [Source: prod/packages/rule-spec/src/conformance/reference-off-chain-adapter.ts]
- [Source: prod/packages/authorization/src/post-transfer.ts]
- [Source: prod/packages/authorization/src/provider/policy-authorization-provider.ts]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Full gate green after implementation: `pnpm test` 259 passed (26 files; +22 over the 237 baseline), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (up→down→up over 6).
- One test-authoring fix during dev: the floor-absent REFUSE case asserted `postings === 0`, but the BACKING_FLOAT funding entry legitimately creates 2 postings; switched the assertion to "source balance unchanged" (the egress did not happen).

### Completion Notes List

- **Single source preserved.** `flow_permissions` (migration 0006) persists the GENERATED artifact verbatim (one row per clause); `loadOffChainPolicy` reconstructs a byte-identical `OffChainPolicyArtifact` (proven by `toEqual(generateOffChainPolicy(ruleSpecV1))`). No rule logic is re-authored in the DB layer.
- **Zero chokepoint change (NFR-8).** `postTransfer` is untouched. The DB-backed provider is `makePolicyAuthorizationProvider` fed a DB-loaded artifact (delegates to the Story-3.1 `makeReferenceOffChainAdapter`), so it passes the SAME 10 conformance vectors via `assertProviderConforms`. The static `chokepoint-guard` test stays green (writes target `flow_permissions`, not `postings`).
- **Persisted-state binding (resolves the Story-3.3 deferral).** `enforceTransfer` validates the declared `from.accountType` against the persisted `accounts` row (`AccountFactMismatchError`), resolves the floor from `@rose/config` `backingFloatFloor`, and computes `postBalanceBelowFloor` from the account's NUMERIC balance — all exact `bigint`, no binary float (NFR-2). Floor absent ⇒ env without `backingFloatFloor` ⇒ REFUSE (never 0).
- **Fail-closed loads (NFR-4).** An empty `flow_permissions` table, rows with inconsistent policy metadata, or a persisted non-DENY default all throw typed errors instead of yielding a permissive/partial policy.
- **Documented P0 residual (for review/Epic 4):** `classification` and `destinationKind` are not persisted columns in P0, so they remain caller-declared facts; this story binds what IS persisted (account type, asset/scale, balance, floor). Cross-checking classification/destination against persisted state requires a schema not in this story's scope.

### File List

- NEW `prod/packages/ledger/src/migrations/0006-flow-permissions.ts`
- NEW `prod/packages/ledger/src/schema/flow-permissions.ts`
- NEW `prod/packages/authorization/src/flow-permissions/policy-store.ts`
- NEW `prod/packages/authorization/src/flow-permissions/db-policy-provider.ts`
- NEW `prod/packages/authorization/src/flow-permissions/account-state.ts`
- NEW `prod/packages/authorization/src/flow-permissions/resolve-env.ts`
- NEW `prod/packages/authorization/src/flow-permissions/enforce-transfer.ts`
- NEW `prod/packages/authorization/src/flow-permissions/policy-store.test.ts`
- NEW `prod/packages/authorization/src/flow-permissions/db-policy-provider.test.ts`
- NEW `prod/packages/authorization/src/flow-permissions/flow-enforcement.test.ts`
- UPDATE `prod/packages/ledger/src/migrations/index.ts` (register migration 0006)
- UPDATE `prod/packages/ledger/src/schema/index.ts` (export flow-permissions schema)
- UPDATE `prod/packages/authorization/src/index.ts` (export Story-3.4 surface)
- UPDATE `prod/packages/authorization/package.json` (+`@rose/config`, +`drizzle-orm`)
- UPDATE `prod/packages/authorization/tsconfig.json` (+`../config` project reference)

## Change Log

| Date       | Description                                                                                                          | Author |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| 2026-06-16 | Story 3.4 created (ready-for-dev).                                                                                  | Amelia |
| 2026-06-16 | Implemented DB-backed OffChainPolicyProvider + flow_permissions (mig 0006); gate green (259 tests); status → review. | Amelia |
| 2026-06-16 | Code review (3 adversarial lenses); 3 patches applied (+4 tests, 263 green); 2 items deferred to Epic 4/6; status → done. | Amelia |

## Senior Developer Review (AI)

**Reviewer:** Amelia (adversarial review — Blind Hunter + Edge Case Hunter + Acceptance Auditor, parallel, against the live Postgres)
**Date:** 2026-06-16
**Outcome:** Approve (with 3 fixes applied and 2 items deferred)

**Acceptance Auditor:** all ACs satisfied — fee/yield ALLOW, principal egress DENY (Model-A), floor breach DENY, floor absent REFUSE, token-via-VCC DENY, uncovered default-deny; the 10 conformance vectors pass against the DB provider; `flow_permissions` seeded from codegen (single source); `postTransfer` unchanged (not in the diff); migration append-only + reversible; money in NUMERIC/bigint; no `/throwaway` imports; no `amount` added to the frozen vocabulary. No violations.

### Action Items

- [x] **[High][Patch] Negative `BACKING_FLOAT_FLOOR` silently disabled the floor guard (fail-open).** A negative floor made `postBalance < floor` false, authorizing a drain to/below zero. Fixed in `resolve-env.ts`: a negative floor is treated as no usable floor ⇒ REFUSE (fail-closed). Regression tests added (unit + end-to-end).
- [x] **[Med][Patch] `seedFlowPermissions` delete+insert was non-atomic on a pool.** A concurrent `loadOffChainPolicy` could observe the empty window and throw. Fixed: the seed now runs inside a transaction (nested savepoint when given a tx). Compose-in-transaction test added.
- [x] **[Low][Patch] Loaded `payload` was cast without integrity check.** A row with a flipped `clause_kind`/`clause_id` would load verbatim. Fixed: `loadOffChainPolicy` now asserts each payload's `id` matches its `clause_id` (else `InconsistentFlowPolicyError`). Tamper test added.
- [x] **[High][Defer→Epic 4] `classification` and `destinationKind` remain caller-asserted facts.** Not persisted columns in P0; cannot be bound to persisted state without new schema. Documented as a code-comment trust boundary in `enforce-transfer.ts` and in `deferred-work.md`; authoritative Model-A enforcement is on-chain in Epic 4. The story claim was scoped to "validate what IS persisted" (source account type).
- [x] **[Low][Defer→Epic 6] Floor/scale parse faults surface as raw `RangeError`, not a modeled refusal.** Fail-closed (no write) but escapes the `TransferRefusedError` contract an API maps to 4xx. Mapping config-parse faults to a typed refusal belongs at the Epic-6 REST boundary. Recorded in `deferred-work.md`.
- [x] **[Dismissed] `0005-rose-notes` import "missing" from the diff (Blind Hunter, diff-only).** False positive: the file exists from a prior story; it appears only as a context line in the scoped diff.
