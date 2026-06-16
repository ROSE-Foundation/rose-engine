---
baseline_commit: NO_VCS
---

# Story 3.1: Define the single-source rule specification and conformance vectors

Status: done

## Story

As a build engineer,
I want one versioned declarative rule specification with shared conformance test vectors,
so that off-chain and on-chain authorization rules are derived from a single source and cannot silently diverge (FR-19 foundation, §8 Q5).

## Acceptance Criteria

**AC-1 — A single versioned DSL/JSON rule spec describes eligibility, transfer restrictions, the Model-A bright line, and pair coupling; shared conformance vectors (allowed/denied) are defined for BOTH planes**
**Given** the `rule-spec` package
**When** I author the rule specification
**Then** a single versioned DSL/JSON describes eligibility, transfer restrictions, the Model-A bright line, and pair coupling
**And** a shared set of conformance test vectors (allowed/denied cases) is defined to be executed against both the off-chain and on-chain planes

**AC-2 — Codegen produces consumable artifacts for the off-chain plane (on-chain later); rules are never hand-edited per-plane**
**Given** the rule-spec and its codegen entry point
**When** codegen runs
**Then** it produces consumable artifacts for the off-chain plane (and, later, the on-chain plane) — neither plane's rules are hand-edited independently

## Tasks / Subtasks

- [x] **Task 1 — New `@rose/rule-spec` PROD package wired into the toolchain (AC: 1, 2)**
  - [x] Create `prod/packages/rule-spec/` with `package.json` (`name: "@rose/rule-spec"`, `version: 0.0.0`, `private`, `type: module`, `main`/`types` → `dist`, `exports` map, `build: tsc -b`), depending on `zod ^3.25.0` (same major as `@rose/config`).
  - [x] `tsconfig.json` extends `../../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `include: ["src/**/*.ts"]`. Do NOT exclude `*.test.ts` (so `tsc -b` typechecks tests, per Epic-1 convention).
  - [x] Register the package in root `tsconfig.json` `references` (append `{ "path": "prod/packages/rule-spec" }`).
  - [x] No project reference to / `workspace:*` dependency on any other PROD package: `rule-spec` is a **leaf source-of-truth** that the off-chain (`authorization`, Epic 3) and on-chain (`contracts`, Epic 4) planes consume — never the reverse (architecture §Architectural Boundaries "Rule boundary"). Only `zod` is a runtime dep.
  - [x] `pnpm install` to materialize the workspace package and `zod`.
- [x] **Task 2 — Versioned declarative rule-spec schema + the v1 spec (AC: 1)**
  - [x] `src/spec/rule-spec-schema.ts`: a Zod schema `ruleSpecSchema` defining the rule-spec shape with a `version` (semver string) and the four mandated sections: `eligibility`, `transferRestrictions`, `modelABrightLine`, `pairCoupling`, plus an explicit `defaultEffect: 'DENY'` (fail-closed default — the rule-set is allow-listed). Export inferred types (`RuleSpec`, sub-types) and the rule **vocabulary** enums (`AccountTypeCode`, `EntityCode`, `Classification = PRINCIPAL|YIELD|NONE`, `DestinationKind`, `AssetKind`, `Effect = ALLOW|DENY|REFUSE`). Vocabulary mirrors the PRD glossary (account types from `@rose/ledger` `accounts.account_type`, entity codes from `entities.entity_code`) — keep it self-contained here (documented alignment, no cross-package import) so the rule language stays a true single source.
  - [x] `src/spec/rule-spec.v1.ts`: the concrete `ruleSpecV1` object (`version: '1.0.0'`) describing, as data:
    - **eligibility** — allowlist required + required ONCHAINID claim topic(s) (FR-19 / architecture §Identity-eligibility). P0: `requireAllowlist: true`, `requiredClaimTopics: [...]` (placeholder topic codes documented as the eligibility contract, refined on-chain in Epic 4).
    - **transferRestrictions** — the P0 allow-rules the off-chain plane will enforce (Story 3.4 / FR-8), expressed declaratively: `FEE_INCOME (any entity) → TREASURY` ALLOW; `CLIENT_COLLATERAL` `YIELD → TREASURY` ALLOW; a `BACKING_FLOAT` egress allow-rule **guarded** by a floor (`floorConfigKey`, value resolved at runtime from `@rose/config` in Story 3.4 — refuse-if-absent, never 0; NFR-4); plus the structural facts that token/trading flows do not route through `VCC` accounts.
    - **modelABrightLine** — `protectedAccountType: CLIENT_COLLATERAL`, `protectedClassification: PRINCIPAL`, rule `PRINCIPAL_MUST_NOT_LEAVE_CLIENT` (UJ-3). Encodes that principal egress outside the client account is forbidden regardless of any allow-rule.
    - **pairCoupling** — `atomicPairedMintBurn: true`, `singleLegForbidden: true` (the on-chain "never a single leg" invariant the rule-spec records for Epic 4 derivation).
  - [x] `src/spec/load-rule-spec.ts`: `loadRuleSpec(input: unknown): RuleSpec` validates via `ruleSpecSchema` and throws a typed `RuleSpecValidationError` (Zod `.issues` attached) on malformed input — a **refusal**, matching the codebase's typed-refusal idiom (`ConfigRefusalError`, `UnbalancedEntryError`). Export `RULE_SPEC_VERSION` const.
- [x] **Task 3 — Codegen entry point emitting the off-chain artifact (AC: 2)**
  - [x] `src/codegen/generate-off-chain-policy.ts`: a **pure deterministic** `generateOffChainPolicy(spec: RuleSpec): OffChainPolicyArtifact` that derives the off-chain policy from the spec: `{ version, defaultEffect: 'DENY', allowRules: FlowPermissionRule[], prohibitions: Prohibition[], floorGuards: FloorGuard[] }`. `FlowPermissionRule` is the precursor of the Story-3.4 `flow_permissions` rows (`{ id, from: {accountType, classification}, to: DestinationKind, effect: 'ALLOW' }`). The Model-A bright line becomes a `prohibition`; the `BACKING_FLOAT` floor becomes a `floorGuard` carrying `floorConfigKey`. Deterministic ordering (stable sort by `id`) so re-generation is byte-stable.
  - [x] `src/codegen/cli.ts`: a thin CLI (`tsx`-runnable) that calls `generateOffChainPolicy(ruleSpecV1)` and writes the artifact to `src/codegen/generated/off-chain-policy.generated.json` (pretty-printed, trailing newline, stable key order) with a `// GENERATED — do not hand-edit` provenance header field (`_generated: { source: 'rule-spec.v1', version }`). Add a `generate` script to the package `package.json` (`tsx src/codegen/cli.ts`). The generated JSON lives **outside** the root format:check / eslint globs (those target `prod/packages/**/*.{ts,tsx}` and lint `.ts` only), so it adds no format churn; it is still emitted deterministically.
  - [x] Commit the generated artifact file (it is the consumable hand-off to Story 3.4 / Epic 4). A drift test (Task 5) re-generates in-memory and asserts the committed file is identical — proving "neither plane's rules are hand-edited independently" (AC-2).
- [x] **Task 4 — Conformance harness + shared vectors + reference plane adapter (AC: 1)**
  - [x] `src/conformance/types.ts`: `ConformanceVector { id, description, scenario: TransferScenario, env: ConformanceEnv, expected: Effect, planes: Plane[] }`; `TransferScenario { from: AccountTypeCode, classification: Classification, to: DestinationKind, assetKind: AssetKind, throughVcc?: boolean }`; `ConformanceEnv { backingFloatFloor?: bigint; postBalanceBelowFloor?: boolean }` (floor presence/breach modeled as inputs — the actual NUMERIC math is Story-3.4 runtime, NFR-2); `Plane = 'OFF_CHAIN' | 'ON_CHAIN'`; `PlaneAdapter { name; evaluate(scenario, env): Effect }`.
  - [x] `src/conformance/vectors.ts`: the **shared vector set** covering the P0 rule set (the baseline both planes must satisfy — Story 3.4 AC, FR-8, UJ-3), each `planes: ['OFF_CHAIN','ON_CHAIN']`:
    1. `FEE_INCOME`/`NONE` → `TREASURY` ⇒ `ALLOW`
    2. `CLIENT_COLLATERAL`/`YIELD` → `TREASURY` ⇒ `ALLOW`
    3. `CLIENT_COLLATERAL`/`PRINCIPAL` → `TREASURY` ⇒ `DENY` (Model-A)
    4. `CLIENT_COLLATERAL`/`PRINCIPAL` → `EXTERNAL` ⇒ `DENY` (Model-A)
    5. `CLIENT_COLLATERAL`/`PRINCIPAL` → `CLIENT_ACCOUNT` ⇒ `ALLOW` (principal may move within the client account)
    6. `BACKING_FLOAT` egress, floor present, post-balance ≥ floor ⇒ `ALLOW`
    7. `BACKING_FLOAT` egress, floor present, post-balance < floor ⇒ `DENY`
    8. `BACKING_FLOAT` egress, floor config **absent** ⇒ `REFUSE` (never treated as 0; NFR-4)
    9. uncovered transfer (`DEPLOYED_CAPITAL` → `EXTERNAL`) ⇒ `DENY` by default (fail-closed)
    10. token/trading flow routed through a `VCC` account (`throughVcc: true`) ⇒ `DENY`
  - [x] `src/conformance/harness.ts`: `runConformance(adapter: PlaneAdapter, vectors): ConformanceResult[]` (filters vectors to those whose `planes` include the adapter's plane), each result `{ vector, actual, passed }`; `assertAllConform(results)` throws `ConformanceFailureError` listing mismatches. This is the **reusable** harness Story 3.4 (off-chain provider adapter) and Epic 4 (on-chain adapter) will run the SAME vectors through.
  - [x] `src/conformance/reference-off-chain-adapter.ts`: `makeReferenceOffChainAdapter(policy: OffChainPolicyArtifact): PlaneAdapter` — the **reference semantics** of the generated artifact (`plane: 'OFF_CHAIN'`). Resolution order: (1) `REFUSE` if a `floorGuard` applies and `env.backingFloatFloor` is absent; (2) `DENY` if a `prohibition` matches (Model-A principal egress, VCC-routed token flow); (3) `DENY` if a `floorGuard` applies and `postBalanceBelowFloor`; (4) `ALLOW` if an `allowRule` matches; (5) else `defaultEffect` (`DENY`). Documented as the conformance reference the **real** Story-3.4 `OffChainPolicyProvider` (DB `flow_permissions`) and the Epic-4 on-chain compliance must reproduce — it is NOT the production provider (no DB, no `postTransfer`).
  - [x] `src/index.ts`: re-export the spec, schema/types, loader + error, codegen (`generateOffChainPolicy`, artifact types), and the conformance harness/vectors/types/reference adapter + error. Add `RULE_SPEC_PACKAGE_NAME = '@rose/rule-spec'` const.
- [x] **Task 5 — Tests, test-first on the single-source invariant (AC: 1, 2)**
  - [x] `spec/rule-spec.test.ts`: `loadRuleSpec(ruleSpecV1)` validates; the v1 spec carries all four sections + `defaultEffect: 'DENY'`; `loadRuleSpec` **refuses** malformed input (missing section, bad `version`, unknown enum) with `RuleSpecValidationError`. Assert the eligibility/Model-A/pair-coupling facts are present (locks the contract for Epic 4 derivation).
  - [x] `codegen/generate-off-chain-policy.test.ts`: `generateOffChainPolicy` is **deterministic** (two calls deep-equal; stable id ordering); it derives the expected allow-rules, the Model-A prohibition, the VCC-token prohibition, and the `BACKING_FLOAT` floorGuard (with `floorConfigKey`) from the spec; `defaultEffect` is `'DENY'`.
  - [x] `codegen/generated-artifact-drift.test.ts`: read the committed `off-chain-policy.generated.json` from disk and assert it **deep-equals** `generateOffChainPolicy(ruleSpecV1)` (modulo the provenance header) — the hand-edit / drift guard (AC-2). If this fails the dev must re-run `pnpm --filter @rose/rule-spec generate`, never hand-edit.
  - [x] `conformance/conformance.test.ts` (**the single-source invariant, test-first**): run ALL shared vectors through `makeReferenceOffChainAdapter(generateOffChainPolicy(ruleSpecV1))` via `runConformance`; `assertAllConform` passes (every vector's `expected` matches). Assert vector-set integrity: ≥10 vectors, each references in-vocabulary codes, both allow AND deny AND refuse outcomes are represented, and every vector is tagged for BOTH planes (so Epic 4 cannot quietly drop on-chain coverage).
  - [x] `index.test.ts`: the package's public surface exports the loader, codegen, harness, vectors, reference adapter, and error classes (guards against an incomplete barrel that would block Story 3.4 / Epic 4 consumers).
- [x] **Task 6 — Verification gate (AC: 1, 2)**
  - [x] `pnpm install`; `pnpm --filter @rose/rule-spec generate` (emit the artifact); then `pnpm typecheck`, `pnpm lint`, `pnpm test` (all prior 142 still green + new), `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (still 5 migrations — this story adds NONE), and `(cd prod/contracts && forge test)` all green.

## Dev Notes

### Scope
- IS: the **single-source rule artifact layer** — a new `@rose/rule-spec` PROD package containing (1) a **versioned declarative rule spec** (Zod-validated DSL/JSON) describing eligibility, transfer restrictions, the Model-A bright line, and pair coupling; (2) a **codegen entry point** that deterministically emits a consumable **off-chain policy artifact** (the precursor of Story-3.4 `flow_permissions`); (3) a **shared conformance vector set** + a **reusable harness** with a pluggable `PlaneAdapter`, plus an in-process **reference off-chain adapter** that proves the generated artifact yields the expected allow/deny/refuse for every vector. Pure TypeScript + Zod, no DB, no network, no contracts.
- IS NOT: the `AuthorizationProvider` interface (Story 3.2); the `postTransfer` chokepoint (Story 3.3); the **production** `OffChainPolicyProvider` reading a DB `flow_permissions` table, and that table/migration (Story 3.4); any on-chain compliance contract, ONCHAINID wiring, or the on-chain plane adapter (Epic 4); `@rose/config` floor wiring / live floor math (Story 3.4 consumes the `floorConfigKey` this spec declares). **No DB migration is added by this story.**

### Design decision — a dedicated `@rose/rule-spec` leaf package (this matches the architecture, unlike Epic 2's consolidation)
[Source: architecture.md#Project Structure (`rule-spec/` FR-19 §8 Q5); architecture.md#Architectural Boundaries "Rule boundary"; architecture.md#Requirements-to-Structure Mapping (`prod/packages/rule-spec`)]
The architecture explicitly carves `prod/packages/rule-spec/` as the **single source of truth** with `spec/`, `codegen/`, `conformance/` subtrees, and names the "Rule boundary": `rule-spec` is the ONLY source of authorization rules; `authorization` (off-chain) and `contracts` (on-chain) **consume** generated artifacts + conformance vectors. Unlike the Epic-2 coupled-pair work (which the prior stories consolidated into `@rose/ledger` for shared schema/migration machinery), the rule-spec shares none of that machinery and is consumed by multiple downstream planes — so it is a **standalone leaf package** exactly as the architecture prescribes. It takes only `zod`; it must NOT depend on `@rose/ledger`/`@rose/config` (that would invert the intended dependency direction — the planes depend on `rule-spec`, not vice versa).

### Design decision — vocabulary is mirrored, not imported (keeps the rule language self-contained)
[Source: architecture.md#Architectural Boundaries "Rule boundary"; ledger `schema/accounts.ts` (`account_type`), `schema/entities.ts` (`entity_code`)]
The rule spec references account types (`BACKING_FLOAT|DEPLOYED_CAPITAL|CLIENT_COLLATERAL|FEE_INCOME|NOTE_LIABILITY`) and entity codes (`VCC|HOLDING|TRADING_CO|COIN_ISSUER`). These exist as drizzle `pgEnum`s in `@rose/ledger`, but importing them would make the source-of-truth depend on a consumer. Instead, `rule-spec` **declares its own vocabulary enums** (the rule language) and a Dev Note documents the 1:1 alignment with the ledger glossary. If the two ever need to be proven identical, that assertion belongs on the **consumer** side (Story 3.4 maps generated rules to ledger account types and can assert coverage there) — never as a `rule-spec → ledger` import.

### Design decision — the conformance "reference adapter" is the contract, not the provider
[Source: epics.md#Story 3.1 AC "executed against both the off-chain and on-chain planes"; architecture.md#Project Structure (`conformance/` "shared test vectors run against BOTH planes"); architecture.md#Off-Chain ↔ On-Chain Rule Equivalence]
The AC says vectors are "**defined to be executed** against both planes". This story defines them and ships a **reusable harness** (`runConformance(adapter, vectors)`) plus an in-process **reference off-chain adapter** derived from the generated artifact, so the vectors are actually exercised NOW (proving the artifact + vectors are internally consistent). Story 3.4 supplies a real off-chain `PlaneAdapter` (the DB-backed `OffChainPolicyProvider`) and Epic 4 supplies an on-chain adapter; both reuse this SAME harness + SAME vectors. The reference adapter is explicitly the **semantic contract** (no DB, no `postTransfer`, no `config`), documented so a future reader does not mistake it for the production provider — that prevents the disaster of Story 3.4 "implementing twice" or diverging from this baseline.

### Design decision — fail-closed by construction; BACKING_FLOAT floor is refuse-if-absent
[Source: epics.md#Story 3.4 AC (floor absent ⇒ refuse, never 0); architecture.md (default-deny `AuthorizationProvider`, NFR-4 fail-closed); CYCLE-BRIEF (refuse on absent parked params)]
`defaultEffect: 'DENY'` is encoded in the spec AND in the generated artifact AND in the reference adapter (an uncovered transfer is denied — vector 9). The `BACKING_FLOAT` floor is modeled as a `floorGuard` carrying a `floorConfigKey` (not a baked value — the floor is a parked/config param resolved at runtime by Story 3.4 via `@rose/config`). The reference adapter returns `REFUSE` when the guard applies and the floor is absent from `env` (vector 8) — it is never silently treated as 0 (NFR-4). The actual NUMERIC floor math is Story-3.4 runtime; here floor presence/breach is modeled as `ConformanceEnv` inputs so no float is involved (NFR-2).

### Architecture constraints
[Source: architecture.md#Naming Patterns, #Implementation Patterns, #Coding Standards; CYCLE-BRIEF "Established project conventions"]
- TypeScript 5.9 strict, ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Files `kebab-case.ts`; types `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. Use `import type` for type-only imports. Package tsconfig must NOT exclude `*.test.ts`.
- Validation with **Zod** at the boundary (the spec loader); typed error classes for refusals (`RuleSpecValidationError`, `ConformanceFailureError`) mirroring `ConfigRefusalError` / `UnbalancedEntryError`.
- Any quantity (a floor) stays integer smallest-unit `bigint`; NEVER a binary float (NFR-2). This story models floor presence/breach as booleans/`bigint` env inputs; it performs no money arithmetic.
- New package wiring: `package.json` + `tsconfig.json` + root `tsconfig.json` `references` + `pnpm install`. No `workspace:*` dep (leaf package).
- Glossary discipline (architecture §Glossary): use PRD terms exactly — `Model-A bright line`, `Coupled pair`, `Authorization Provider`, `postTransfer`, `flow_permissions`. The frozen verb set (`postTransfer`, `issueCoupledPair`, `mintPair`, `burnPair`, `reconcile`) is unaffected; codegen uses `generateOffChainPolicy` (a build verb, not a domain verb).
- **No DB migration** — `check:migrations` stays at 5 migrations; this story touches no `@rose/ledger` schema.

### Project Structure Notes
- New package `prod/packages/rule-spec/`:
  - `package.json`, `tsconfig.json`
  - `src/index.ts`, `src/index.test.ts`
  - `src/spec/rule-spec-schema.ts`, `src/spec/rule-spec.v1.ts`, `src/spec/load-rule-spec.ts`, `src/spec/rule-spec.test.ts`
  - `src/codegen/generate-off-chain-policy.ts`, `src/codegen/cli.ts`, `src/codegen/generated/off-chain-policy.generated.json`, `src/codegen/generate-off-chain-policy.test.ts`, `src/codegen/generated-artifact-drift.test.ts`
  - `src/conformance/types.ts`, `src/conformance/vectors.ts`, `src/conformance/harness.ts`, `src/conformance/reference-off-chain-adapter.ts`, `src/conformance/conformance.test.ts`
- Modified: root `tsconfig.json` (`references` += rule-spec); `pnpm-lock.yaml` (via `pnpm install`).
- Matches the architecture's idealized `rule-spec/{spec,codegen,conformance}` layout (subtrees become `src/{spec,codegen,conformance}` to keep one compiled `rootDir`, consistent with the other PROD packages' `src/` convention).

### Prior-story learnings (Epic 1–2)
- Package scaffold idiom (Story 1.1): `package.json` with `type: module`, `main`/`types` → `dist`, `exports` map, `build: tsc -b`; `tsconfig.json` extends the base with `rootDir: src`/`outDir: dist`; register in root `tsconfig.json` `references`. `@rose/config` is the closest model (it has a `zod` dependency) — copy its `package.json` shape and add `zod ^3.25.0`.
- Typed-refusal idiom: `ConfigRefusalError` (Story 1.3), `UnbalancedEntryError`/`AccountPlacementError`, `NotDeltaNeutralError`/`IllegalPairTransitionError` (Epic 2) — `class XError extends Error` with a stable `name` and structured fields; tests assert on the class via `expect(() => …).toThrow(XError)`. Mirror for `RuleSpecValidationError` (attach Zod `issues`) and `ConformanceFailureError` (attach mismatches).
- Co-located Vitest `*.test.ts`; `tsc -b` typechecks tests (tsconfig does not exclude them). These tests are pure (no DB) so they run regardless of Postgres state — but the full `pnpm test` suite still needs Postgres up for the ledger integration tests (baseline 142 tests, 11 files).
- Determinism/stable-ordering matters for the drift test: sort emitted rules by a stable `id` and pretty-print JSON with 2-space indent + trailing newline so re-generation is byte-identical.

### Testing standards
[Source: architecture.md NFR-6 "test-first on invariants"; CYCLE-BRIEF]
Vitest, co-located `*.test.ts`, pure unit tests (no DB). **Test-first on the single-source invariant**: the generated off-chain artifact, run through the reference adapter, must satisfy EVERY shared conformance vector (allow/deny/refuse), AND the committed generated artifact must deep-equal a fresh in-memory regeneration (no hand-edit). Cover: spec validation + refusal on malformed input; codegen determinism + correct derivation; drift guard; conformance pass + vector-set integrity (≥10 vectors, all three outcomes present, both planes tagged); public-surface exports. Assert refusals throw the typed error and that nothing partial is produced.

### References
- [Source: epics.md#Story 3.1] — user story + both AC scenarios (versioned DSL/JSON for eligibility/transfer-restrictions/Model-A/pair-coupling + shared conformance vectors for both planes; codegen produces off-chain artifacts, rules never hand-edited per-plane).
- [Source: epics.md#Epic 3] — "establish the single-source rule-spec + codegen + conformance vectors that both planes derive from"; includes the `rule-spec` package (versioned DSL/JSON), codegen emitting off-chain `flow_permissions`, conformance vectors (off-chain plane), `OffChainPolicyProvider`.
- [Source: epics.md#Story 3.4 AC] — the P0 rule set the conformance vectors must encode (FEE_INCOME→treasury allowed; CLIENT_COLLATERAL yield→treasury allowed, principal excluded; Model-A principal egress rejected; BACKING_FLOAT-below-floor rejected, floor-absent refused; token/trading flows not through VCC; uncovered ⇒ default-deny).
- [Source: architecture.md#Off-Chain ↔ On-Chain Rule Equivalence (FR-19, §8 Q5)] — single-source declarative rule spec + codegen emits BOTH off-chain `flow_permissions`/`OffChainPolicyProvider` config AND on-chain compliance config; shared conformance vectors run against both planes so the rule sets cannot silently diverge (NFR-8, SM-4).
- [Source: architecture.md#Project Structure / #Architectural Boundaries / #Requirements-to-Structure Mapping] — `prod/packages/rule-spec/{spec,codegen,conformance}`; the "Rule boundary"; `rule-spec` is the only source of authorization rules.
- [Source: implementation-artifacts/2-4-*.md, 1-3-*.md] — package scaffold + typed-refusal + co-located-test conventions; `@rose/config`'s `zod` dependency as the package model.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `pnpm --filter @rose/rule-spec generate` — emits `off-chain-policy.generated.json` from `ruleSpecV1`.
- Gate: `pnpm typecheck` ✓; `pnpm lint` ✓; `pnpm test` ✓ 181 (+39 in `@rose/rule-spec`); `pnpm format:check` ✓; `pnpm check:regime` ✓; `pnpm check:migrations` ✓ (5, unchanged); `(cd prod/contracts && forge test)` ✓ 3.

### Completion Notes List

- New leaf PROD package `@rose/rule-spec` (only `zod`), wired into root `tsconfig.json` references — matches the architecture's `rule-spec/{spec,codegen,conformance}` layout (subtrees under one `src/` rootDir). No `workspace:*` dep on any other PROD package (the planes depend on rule-spec, never the reverse).
- **AC-1:** `ruleSpecV1` (versioned, `version: '1.0.0'`) is a single Zod-validated DSL describing all four mandated sections — eligibility (allowlist + ONCHAINID claim topics), transfer restrictions (allow + structural prohibitions), the Model-A bright line, and pair coupling. `loadRuleSpec` refuses malformed input with typed `RuleSpecValidationError`. Shared conformance vectors (10) cover the full P0 rule set (ALLOW/DENY/REFUSE), each tagged for BOTH planes, runnable through the reusable `runConformance` harness via a pluggable `PlaneAdapter`.
- **AC-2:** `generateOffChainPolicy` is a pure deterministic codegen entry point emitting the consumable off-chain artifact (`off-chain-policy.generated.json`); a drift test asserts the committed file equals a fresh regeneration (hand-edit guard). The in-process `makeReferenceOffChainAdapter` proves the generated artifact satisfies every vector — the semantic baseline Story 3.4 (off-chain) and Epic 4 (on-chain) must reproduce.
- **Money/NFR-2:** no float; the BACKING_FLOAT floor is carried as a `floorConfigKey` (resolved at runtime in Story 3.4, refuse-if-absent), and floor presence/breach is modeled as `ConformanceEnv` inputs — no arithmetic in this layer.
- **No DB migration** added; `check:migrations` stays at 5.
- Documented P0 interpretations: vocabulary mirrored (not imported) from the ledger glossary to keep rule-spec a true leaf; the reference adapter is the conformance contract, NOT the production provider (Story 3.4 builds the DB-backed one); `requiredClaimTopics: ['ONCHAINID_KYC']` is the off-chain eligibility contract Epic 4 maps onto on-chain claim topics.

### File List

New (all under `prod/packages/rule-spec/`):
- `package.json`, `tsconfig.json`
- `src/index.ts`, `src/index.test.ts`
- `src/spec/rule-spec-schema.ts`, `src/spec/rule-spec.v1.ts`, `src/spec/load-rule-spec.ts`, `src/spec/rule-spec.test.ts`
- `src/codegen/generate-off-chain-policy.ts`, `src/codegen/paths.ts`, `src/codegen/cli.ts`, `src/codegen/generated/off-chain-policy.generated.json`, `src/codegen/generate-off-chain-policy.test.ts`, `src/codegen/generated-artifact-drift.test.ts`
- `src/conformance/types.ts`, `src/conformance/vectors.ts`, `src/conformance/harness.ts`, `src/conformance/reference-off-chain-adapter.ts`, `src/conformance/conformance.test.ts`

Modified:
- `tsconfig.json` (root) — append `{ "path": "prod/packages/rule-spec" }` to `references`.
- `pnpm-lock.yaml` — `@rose/rule-spec` workspace package + `zod` dep linked via `pnpm install`.

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-06-16 | 0.1 | Story drafted (create-story) — ready-for-dev | Bob (SM) |
| 2026-06-16 | 0.2 | Implemented `@rose/rule-spec` (spec + codegen + conformance), full gate green (181 tests) — review | Amelia (Dev) |
| 2026-06-16 | 0.3 | Code review: fixed reference-adapter resolution order + floor scoping + dist path hygiene + id-uniqueness guard; +8 regression tests (189), gate green — done | Amelia (Dev) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (autonomous adversarial review — Blind Hunter / Edge Case Hunter / Acceptance Auditor, independent contexts).
**Date:** 2026-06-16
**Outcome:** Approve (all Med findings fixed and regression-tested; both ACs independently confirmed; no scope creep).

### Acceptance verdict
- **AC-1** met — `ruleSpecV1` is a single versioned Zod-validated DSL with all four mandated sections (eligibility, transfer restrictions, Model-A bright line, pair coupling); 10 shared conformance vectors (ALLOW/DENY/REFUSE), each tagged for BOTH planes, cover the full Story-3.4 P0 rule set; reusable `runConformance` harness with a pluggable `PlaneAdapter`.
- **AC-2** met — `generateOffChainPolicy` is a pure deterministic codegen entry point emitting the committed off-chain artifact; the byte-identical drift test is a real hand-edit guard.
- **Scope** clean — no `AuthorizationProvider` (3.2), no `postTransfer` (3.3), no DB `flow_permissions`/production provider/config floor wiring (3.4), no migration. Leaf package, only `zod`.

### Action Items (all resolved)
- [x] **[Med] Reference-adapter resolution order** — absolute prohibitions now evaluated FIRST, so a structural bright line (e.g. token-through-VCC) DENIES unconditionally instead of degrading to REFUSE when the floor config is absent. [`reference-off-chain-adapter.ts`]
- [x] **[Med] Floor guard over-scoping** — floor guards are now scoped to the specific allow-rule (`FloorGuard.allowRuleId`), not the source account; an uncovered `BACKING_FLOAT` flow now falls through to fail-closed DENY instead of leaking a floor REFUSE. [`generate-off-chain-policy.ts`, `reference-off-chain-adapter.ts`]
- [x] **[Med] Floor breach unknown ⇒ fail-open** — a floor-guarded egress is now ALLOWed only when proven at/above the floor (`postBalanceBelowFloor === false`); unknown/true ⇒ DENY (fail-closed, NFR-4). [`reference-off-chain-adapter.ts`]
- [x] **[Med] Generated-artifact path leaked to public surface** — `GENERATED_OFF_CHAIN_POLICY_PATH` removed from the package barrel (the JSON is not copied into `dist/` by `tsc`); consumers call `generateOffChainPolicy(ruleSpecV1)` in-memory; the on-disk artifact remains for drift detection + the Foundry/on-chain plane. [`index.ts`]
- [x] **[Low] Rule-id integrity** — `ruleSpecSchema.superRefine` now refuses duplicate allow/prohibit ids and ids colliding with codegen-reserved (`floor-*`, `prohibit-model-a-principal-egress`) ids. [`rule-spec-schema.ts`]
- [x] **[Low] Model-A single-source coupling** — added a coherence test asserting the derived `PRINCIPAL_EGRESS` prohibition's `allowedDestination` is backed by a real allow-rule. [`rule-spec.test.ts`]
- Regression tests added (+8, total 189): 4 reference-adapter fail-closed unit cases, 2 id-integrity refusals, 1 floor-guard scoping, 1 Model-A coherence.

### Dismissed (with reason)
- **Allow-rules are asset-kind-agnostic** — by design for P0 (the only asset-kind-specific concern, token-through-VCC, is a prohibition that is enforced); documented, not a defect.
- **`RULE_SPEC_VERSION` vs `ruleSpecV1.version` drift** — already guarded: `rule-spec.test.ts` asserts `spec.version === RULE_SPEC_VERSION`.
- **Exactly-at-floor boundary / on-chain-modeling artifacts** — intentionally kept OUT of the shared cross-plane vectors (they are reference-adapter unit cases) so they do not impose modeling artifacts on the Epic-4 on-chain plane.
