---
baseline_commit: 630a1859add3e46ef6b38a40a711d3d2488cf30c
---

# Story 3.2: Provide the default-deny Authorization Provider interface (substitutable)

Status: done

## Story

As a build engineer,
I want an `AuthorizationProvider` interface that defaults to deny and can be swapped without caller changes,
so that authorization is fail-closed and provider implementations are substitutable (FR-5, FR-8 default, NFR-4, NFR-8).

## Acceptance Criteria

**AC-1 — Default-deny (fail-closed): an unmatched transfer is denied by the provider**
**Given** the `AuthorizationProvider` interface
**When** a transfer is evaluated and no rule explicitly permits it
**Then** the provider returns deny by default (fail-closed)

**AC-2 — Substitutability: swapping the implementation requires no caller changes**
**Given** a caller using the provider
**When** I substitute a fake/alternate provider implementation
**Then** no calling code changes are required (the substitution test passes)
**And** any **conformant** provider implementation passes the SAME shared conformance vectors (reusing the Story-3.1 harness)

## Tasks / Subtasks

- [x] **Task 1 — New `@rose/authorization` PROD package wired into the toolchain (AC: 1, 2)**
  - [x] Create `prod/packages/authorization/` with `package.json` (`name: "@rose/authorization"`, `version: 0.0.0`, `private`, `type: module`, `main`/`types` → `dist`, `exports` map, `build: tsc -b`). Sole runtime dependency: `"@rose/rule-spec": "workspace:*"` (authorization **consumes** rule-spec — the correct dependency direction; rule-spec must never depend back on a plane). No `zod`, no DB driver, no `@rose/config` (those belong to Story 3.4).
  - [x] `tsconfig.json` extends `../../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `include: ["src/**/*.ts"]`, `exclude: ["dist", "node_modules"]`, and `references: [{ "path": "../rule-spec" }]` (composite project reference so `tsc -b` builds rule-spec first). Do NOT exclude `*.test.ts` (Epic-1 convention: `tsc -b` typechecks tests).
  - [x] Register the package in root `tsconfig.json` `references` (append `{ "path": "prod/packages/authorization" }` AFTER `rule-spec`).
  - [x] `pnpm install` to materialize the workspace package and link `@rose/rule-spec`.
- [x] **Task 2 — The `AuthorizationProvider` interface + request/decision contract (AC: 1)**
  - [x] `src/provider/authorization-provider.ts`: define the substitutable interface. REUSE the rule-spec vocabulary — `import type { Effect, TransferScenario, ConformanceEnv } from '@rose/rule-spec'` — do NOT redeclare the decision vocabulary or the scenario/env shapes (single source of truth).
    - `AuthorizationRequest { readonly scenario: TransferScenario; readonly env: ConformanceEnv }` — the inputs a provider needs to decide a transfer (the `from`/`classification`/`to`/`assetKind`/`throughVcc` of the move plus the floor-config presence/breach env). These are the SAME shapes the conformance harness drives, so a provider is bridgeable to a `PlaneAdapter` (Task 4) with no re-mapping.
    - `AuthorizationDecision { readonly effect: Effect; readonly reason: string }` — carries the `ALLOW|DENY|REFUSE` decision plus a human-readable `reason` for the audit trail (NFR-3). `effect: 'DENY'` is the fail-closed baseline.
    - `AuthorizationProvider { readonly name: string; authorize(request: AuthorizationRequest): AuthorizationDecision }`.
  - [x] Export the fail-closed constant `DEFAULT_EFFECT: Effect = 'DENY'` and a shared default-deny decision factory `denyByDefault(reason?): AuthorizationDecision` returning `{ effect: 'DENY', reason: reason ?? 'fail-closed default: no rule explicitly permits this transfer' }`. This is the single definition of "deny by default" that every provider falls back to.
- [x] **Task 3 — A default-deny baseline provider + the policy-backed conformant provider (AC: 1, 2)**
  - [x] `src/provider/default-deny-provider.ts`: `makeDefaultDenyProvider(name = 'default-deny'): AuthorizationProvider` whose `authorize` returns `denyByDefault()` for EVERY request — the fail-closed baseline (AC-1). Document it as the provider a caller gets when no policy is configured: it denies everything, never throws, never defaults to allow. (It is intentionally NOT conformant against the ALLOW vectors — being maximally safe is the point; conformance is the job of a *policy-backed* provider.)
  - [x] `src/provider/policy-authorization-provider.ts`: `makePolicyAuthorizationProvider(policy: OffChainPolicyArtifact, name = 'policy'): AuthorizationProvider`. Build the provider's decision function by DELEGATING to the Story-3.1 reference semantics — `const adapter = makeReferenceOffChainAdapter(policy)` — and wrap each `adapter.evaluate(scenario, env)` `Effect` into an `AuthorizationDecision` (with a `reason` derived from the effect). This proves a *real, substitutable* provider derived from the single-source rule artifact, WITHOUT re-authoring any rule logic. **Scope guard:** this is NOT the Story-3.4 production `OffChainPolicyProvider` (no DB `flow_permissions`, no `@rose/config` floor resolution); it is an in-memory provider over the generated artifact, documented as such. Story 3.4 supplies the DB-backed provider that must reproduce these same semantics.
  - [x] Keep providers pure: no I/O, no DB, no network, no `postTransfer` (that chokepoint is Story 3.3).
- [x] **Task 4 — Reuse the Story-3.1 conformance harness for the substitutability gate (AC: 2)**
  - [x] `src/conformance/provider-conformance.ts`:
    - `providerToPlaneAdapter(provider: AuthorizationProvider, plane: Plane = 'OFF_CHAIN'): PlaneAdapter` — adapt any `AuthorizationProvider` into the rule-spec `PlaneAdapter` shape (`evaluate(scenario, env) => provider.authorize({ scenario, env }).effect`). This is the bridge that lets the SAME shared vectors run against any provider.
    - `assertProviderConforms(provider, vectors = conformanceVectors, plane = 'OFF_CHAIN'): void` — bridge → `runConformance` → `assertAllConform` (throws the rule-spec `ConformanceFailureError` on mismatch). This is the reusable conformance gate: "any conformant provider passes the same vectors" (AC-2, NFR-8).
  - [x] Do NOT redefine vectors/harness/error here — import them from `@rose/rule-spec`.
- [x] **Task 5 — Barrel + substitutability caller (AC: 2)**
  - [x] `src/index.ts`: re-export the interface + request/decision types, `DEFAULT_EFFECT`/`denyByDefault`, `makeDefaultDenyProvider`, `makePolicyAuthorizationProvider`, and the conformance bridge/gate. Add `AUTHORIZATION_PACKAGE_NAME = '@rose/authorization'` const. Re-export the rule-spec `Effect` type for convenience consumers (type-only).
  - [x] (No runtime "caller" module is added — the substitutability proof lives in the test as a single generic call site that drives multiple providers unchanged. A concrete caller is `postTransfer`, which is Story 3.3.)
- [x] **Task 6 — Tests, test-first on the fail-closed + substitutability invariants (AC: 1, 2)**
  - [x] `src/provider/default-deny-provider.test.ts` (**AC-1, fail-closed**): the default-deny provider returns `DENY` for an explicitly-permitted-looking flow (e.g. `FEE_INCOME/NONE → TREASURY`), for an uncovered flow, AND for a floor-guarded flow — i.e. it NEVER returns ALLOW/REFUSE; `effect` is always `'DENY'` and `reason` is non-empty. Assert `DEFAULT_EFFECT === 'DENY'` and `denyByDefault().effect === 'DENY'`.
  - [x] `src/provider/policy-authorization-provider.test.ts`: a policy-backed provider built from `generateOffChainPolicy(ruleSpecV1)` returns the EXPECTED decision for representative vectors — at least one ALLOW (`FEE_INCOME/NONE → TREASURY`), the Model-A DENY (`CLIENT_COLLATERAL/PRINCIPAL → TREASURY`), and a REFUSE (`BACKING_FLOAT` egress, floor config absent). Confirms the wrapper preserves the reference `Effect` exactly.
  - [x] `src/conformance/provider-conformance.test.ts` (**AC-2, substitutability via the shared harness, test-first**): `assertProviderConforms(makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1)))` does NOT throw — the conformant provider passes ALL shared OFF_CHAIN vectors through the Story-3.1 harness. Assert the negative direction too: `assertProviderConforms(makeDefaultDenyProvider())` THROWS `ConformanceFailureError` (the all-deny baseline is safe but not conformant — proving the gate actually discriminates and is not vacuous). Assert ≥1 OFF_CHAIN vector exists so the gate is non-empty.
  - [x] `src/conformance/substitutability.test.ts` (**AC-2, caller-unchanged**): define ONE generic caller `const decide = (p: AuthorizationProvider, r: AuthorizationRequest) => p.authorize(r)` and drive it with the default-deny provider, the policy-backed provider, and an inline test-fake provider (e.g. a constant-`ALLOW` stub) — the SAME call site, zero changes, three implementations. Assert each returns a well-formed `AuthorizationDecision` and that swapping providers changes only the decision, never the call shape. (This is the SPEC §5 acceptance: "substituting a fake AuthorizationProvider requires no calling-code change".)
  - [x] `src/index.test.ts`: the public surface exports the interface helpers, both provider factories, the conformance bridge/gate, `AUTHORIZATION_PACKAGE_NAME`, and re-exports `Effect` — guards a complete barrel for Story 3.3 (`postTransfer`) / Story 3.4 (production provider) consumers.
- [x] **Task 7 — Verification gate (AC: 1, 2)**
  - [x] `pnpm install`; then `pnpm typecheck`, `pnpm lint`, `pnpm test` (all prior 189 still green + new), `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (still 5 migrations — this story adds NONE), and `(cd prod/contracts && forge test)` all green.

### Review Findings

Adversarial code review (Blind Hunter / Edge Case Hunter / Acceptance Auditor, independent contexts). Acceptance Auditor confirmed AC-1 and AC-2 both MET with non-vacuous evidence; no scope creep; dependency direction, vocabulary reuse, and glossary discipline all clean. No High findings. The Medium/Low findings below were all fixed and re-validated.

- [x] [Review][Patch] Misleading DENY audit reason — `reasonFor('DENY')` collapsed prohibition / uncovered-default / floor-breach into a single string claiming "not explicitly permitted", which is factually wrong for a floor-breach DENY (the flow WAS permitted); inaccurate audit trail (NFR-3). [prod/packages/authorization/src/provider/policy-authorization-provider.ts]
- [x] [Review][Patch] Reusable conformance gate could pass vacuously — `assertProviderConforms` ran whatever vectors matched the plane and passed on zero matches (empty set / all-ON_CHAIN / wrong plane); the gate that 3.4 + Epic 4 consume now throws if 0 vectors ran. [prod/packages/authorization/src/conformance/provider-conformance.ts]
- [x] [Review][Patch] `reasonFor` lacked an exhaustiveness guard — added a `never` default so a future `Effect` member is a compile error, not a silent `undefined` reason. [prod/packages/authorization/src/provider/policy-authorization-provider.ts]
- [x] [Review][Patch] `DEFAULT_EFFECT` type widened to `Effect` — narrowed to the `'DENY'` literal via `satisfies` so consumers keep type-level narrowing while preserving the fail-closed guarantee. [prod/packages/authorization/src/provider/authorization-provider.ts]
- [x] [Review][Patch] `denyByDefault('')` accepted an empty audit reason (`?? ` keeps `''`) — now falls back to the default reason for an empty/blank string. [prod/packages/authorization/src/provider/authorization-provider.ts]
- [x] [Review][Patch] "never throws" contract wording sharpened — clarified that `authorize` returns a DENY/REFUSE as a decision rather than throwing. [prod/packages/authorization/src/provider/authorization-provider.ts]
- [x] [Review][Patch] Bridge test was tautological — strengthened `providerToPlaneAdapter` test to prove `env` is threaded (floor-absent ⇒ REFUSE vs floor-present-not-breached ⇒ ALLOW), not just that the two expressions are equal by construction. [prod/packages/authorization/src/conformance/provider-conformance.test.ts]
- [x] [Review][Patch] Non-vacuity rested on unasserted vector data — added an assertion that ≥1 OFF_CHAIN vector expects a non-DENY effect, so the all-deny-baseline discrimination test cannot itself become vacuous. [prod/packages/authorization/src/conformance/provider-conformance.test.ts]
- [x] [Review][Dismiss] `providerToPlaneAdapter` defaults `plane = 'OFF_CHAIN'` / silent plane mismatch — by design (the interface carries no plane; only off-chain vectors exist in P0); documented for Epic 4 forward-awareness.
- [x] [Review][Dismiss] Blind Hunter "gate never filters by plane" — false positive: the reused `runConformance` (rule-spec `harness.ts`) filters vectors by `adapter.plane`.
- [x] [Review][Dismiss] "caller-unchanged proof is structurally trivial" — the one-line `decide` passthrough is the conventional pattern and is backed by the conformance gate + strengthened tests.

## Dev Notes

### Scope
- IS: the **substitutable authorization seam** — a new `@rose/authorization` PROD package containing (1) the `AuthorizationProvider` interface plus its `AuthorizationRequest`/`AuthorizationDecision` contract, built on the rule-spec `Effect` vocabulary; (2) the **default-deny / fail-closed** semantics (`DEFAULT_EFFECT = 'DENY'`, `denyByDefault`, `makeDefaultDenyProvider`) so an unmatched transfer is denied (AC-1, NFR-4); (3) a **substitutability conformance gate** that REUSES the Story-3.1 shared vectors + `runConformance` harness via a `providerToPlaneAdapter` bridge, proving any conformant provider passes the SAME vectors (AC-2, NFR-8); (4) an in-memory **policy-backed provider** derived from the generated off-chain artifact (delegating to `makeReferenceOffChainAdapter`) to demonstrate a real substitutable implementation. Pure TypeScript, no DB, no network, no contracts.
- IS NOT: the `postTransfer(from, to, amount, context)` chokepoint and the "only one writer of transfer postings" guard (Story 3.3); the **production** `OffChainPolicyProvider` reading a DB `flow_permissions` table, that table/migration, and `@rose/config` floor resolution (Story 3.4); any on-chain `OnChainPolicyProvider` / compliance contract (Epic 4); any change to `@rose/rule-spec` (it is the consumed single source — leave it untouched). **No DB migration is added by this story.**

### Design decision — a dedicated `@rose/authorization` package consuming `@rose/rule-spec`
[Source: docs/SPEC.md §9 (`authorization/` "AuthorizationProvider + OffChainPolicyProvider"); epics.md#Epic 3; 3-1 File List + Carry-forward note "the interface should consume the conformance harness for its substitutability test"]
SPEC §9 carves `authorization/` as the PROD package holding the `AuthorizationProvider` interface and (later) `OffChainPolicyProvider`. This story creates that package and the interface; Story 3.3 adds `postTransfer` here, Story 3.4 adds the DB-backed provider here. The package **depends on `@rose/rule-spec` via `workspace:*`** (the consumer→source-of-truth direction the 3.1 "Rule boundary" mandates) and reuses its `Effect` vocabulary, conformance vectors, harness, and reference adapter — it does NOT redefine any of them. This mirrors how `@rose/ledger` depends on `@rose/shared`.

### Design decision — reuse rule-spec's scenario/env shapes as the request contract
[Source: 3-1 conformance/types.ts (`TransferScenario`, `ConformanceEnv`, `PlaneAdapter`); CYCLE-BRIEF "réutiliser le vocabulaire et le harness"]
`AuthorizationRequest` is `{ scenario: TransferScenario; env: ConformanceEnv }` — the EXACT shapes the conformance harness already drives. This is deliberate: it makes `providerToPlaneAdapter` a trivial, lossless bridge so the SAME 10 shared vectors gate any provider with no field re-mapping (no chance of the provider and the conformance gate disagreeing about what a "transfer" is). The `ConformanceEnv` name is rule-spec's; it models floor-config presence (`backingFloatFloor` undefined ⇒ absent ⇒ REFUSE) and breach (`postBalanceBelowFloor`) abstractly so NO money arithmetic / float happens in this layer (NFR-2). The concrete floor value + NUMERIC math is Story-3.4 runtime.

### Design decision — default-deny is the baseline; conformance is a separate property
[Source: epics.md#Story 3.2 AC-1; SPEC §3.5 "Refus par défaut"; NFR-4 fail-closed]
Two distinct providers express two distinct guarantees: `makeDefaultDenyProvider` is the **fail-closed baseline** — it denies everything and is the safe default a caller gets with no policy (AC-1). `makePolicyAuthorizationProvider` is a **conformant** provider — it reproduces the rule-spec reference decisions and therefore passes the shared vectors (AC-2). The substitutability test asserts BOTH directions: the conformant provider passes the gate; the all-deny baseline FAILS it (so the gate is proven non-vacuous). This prevents a future "conformant" provider that secretly defaults to allow from sneaking through.

### Architecture constraints
[Source: 3-1 Dev Notes#Architecture constraints; docs/SPEC.md §3.5; CYCLE-BRIEF]
- TypeScript 5.9 strict, ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Files `kebab-case.ts`; types/interfaces `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. Use `import type` for type-only imports (required by `verbatimModuleSyntax`). Internal imports use the `.js` extension (NodeNext); cross-package imports use the bare `@rose/rule-spec` specifier. Package tsconfig must NOT exclude `*.test.ts`.
- Typed error idiom for refusals already exists in rule-spec (`ConformanceFailureError`); REUSE it from the harness rather than introducing a new error class — this story needs no new error type (the providers return `Effect`, they do not throw on a DENY/REFUSE; only the conformance gate throws, and it reuses `ConformanceFailureError`).
- Glossary discipline: use PRD terms exactly — `Authorization Provider`, `postTransfer`, `flow_permissions`, `Model-A bright line`. The frozen verb set is unaffected (this story adds no domain verb; `authorize` is the interface method named after the SPEC's "consulte un AuthorizationProvider").
- New package wiring: `package.json` (+`@rose/rule-spec` `workspace:*`) + `tsconfig.json` (+`references: [../rule-spec]`) + root `tsconfig.json` `references` + `pnpm install`.
- **No DB migration** — `check:migrations` stays at 5 migrations; this story touches no `@rose/ledger` schema.
- Money/NFR-2: no float and no money arithmetic in this layer; floor presence/breach is modeled via the rule-spec `ConformanceEnv` booleans/`bigint`.

### Project Structure Notes
- New package `prod/packages/authorization/`:
  - `package.json`, `tsconfig.json`
  - `src/index.ts`, `src/index.test.ts`
  - `src/provider/authorization-provider.ts`
  - `src/provider/default-deny-provider.ts`, `src/provider/default-deny-provider.test.ts`
  - `src/provider/policy-authorization-provider.ts`, `src/provider/policy-authorization-provider.test.ts`
  - `src/conformance/provider-conformance.ts`, `src/conformance/provider-conformance.test.ts`
  - `src/conformance/substitutability.test.ts`
- Modified: root `tsconfig.json` (`references` += authorization, after rule-spec); `pnpm-lock.yaml` (via `pnpm install`).
- Matches SPEC §9's `authorization/` package; subtrees `src/{provider,conformance}` keep one compiled `rootDir`, consistent with the other PROD packages.

### Reusable APIs from `@rose/rule-spec` (consume these — do NOT reimplement)
[Source: prod/packages/rule-spec/src/index.ts barrel]
- Types: `Effect` (`ALLOW|DENY|REFUSE`), `TransferScenario`, `ConformanceEnv`, `Plane`, `ConformanceVector`, `PlaneAdapter`, `OffChainPolicyArtifact`.
- Values/functions: `ruleSpecV1`, `generateOffChainPolicy(spec) → OffChainPolicyArtifact`, `makeReferenceOffChainAdapter(policy) → PlaneAdapter`, `conformanceVectors` (the 10 shared vectors), `runConformance(adapter, vectors)`, `assertAllConform(adapter, results)`, `ConformanceFailureError`.
- Note: the generated-artifact FILE PATH is intentionally NOT exported by rule-spec; always `generateOffChainPolicy(ruleSpecV1)` in-memory.

### Prior-story learnings (Story 3.1 + Epic 1–2)
- Package scaffold idiom: `package.json` with `type: module`, `main`/`types` → `dist`, `exports` map, `build: tsc -b`; `tsconfig.json` extends the base with `rootDir: src`/`outDir: dist`; register in root `tsconfig.json` `references`. `@rose/ledger` is the closest model for a package WITH a `workspace:*` dep + a project `references` entry — copy its `package.json`/`tsconfig.json` shape (swap `@rose/shared` → `@rose/rule-spec`, drop `drizzle-orm`/`pg`).
- Co-located Vitest `*.test.ts`; `tsc -b` typechecks tests (tsconfig does not exclude them). These tests are pure (no DB) so they run regardless of Postgres state — but the full `pnpm test` suite still needs Postgres up for the ledger integration tests (baseline 189 tests, 16 files).
- 3.1 review fixed the reference adapter's fail-closed resolution order; the policy-backed provider INHERITS that corrected behavior for free by delegating to `makeReferenceOffChainAdapter` — do not re-implement the resolution logic.

### Testing standards
[Source: architecture NFR-6 "test-first on invariants"; CYCLE-BRIEF; 3-1 Testing standards]
Vitest, co-located `*.test.ts`, pure unit tests (no DB). **Test-first on the two invariants**: (1) fail-closed — the default-deny provider returns `DENY` for every input (AC-1); (2) substitutability — a single generic call site drives multiple providers unchanged AND every conformant provider passes the SAME shared vectors via the reused `runConformance` harness, while the all-deny baseline is proven to FAIL the gate (so the gate is non-vacuous) (AC-2). Cover: default-deny exhaustiveness; policy-backed provider preserves reference ALLOW/DENY/REFUSE; provider→adapter bridge correctness; public-surface exports.

### References
- [Source: epics.md#Story 3.2] — user story + both AC scenarios (default-deny when no rule permits; substitute a fake provider with no caller change).
- [Source: epics.md#Epic 3] — "keep the Authorization Provider substitutable" (FR-5), default-deny (FR-8 default), fail-closed (NFR-4), substitutability (NFR-8).
- [Source: docs/SPEC.md §3.5] — `postTransfer` consults an `AuthorizationProvider` before writing; refuse-by-default; the interface exists so `OnChainPolicyProvider` can be substituted in P3+ without touching caller code.
- [Source: docs/SPEC.md §5] — acceptance: "substituting a fake `AuthorizationProvider` requires no calling-code change (test proving interface isolation)".
- [Source: docs/SPEC.md §9] — repo layout: `authorization/  # AuthorizationProvider + OffChainPolicyProvider`.
- [Source: implementation-artifacts/3-1-*.md] — the consumed single source: `Effect` vocabulary, conformance vectors, `runConformance` harness, `makeReferenceOffChainAdapter`, `generateOffChainPolicy`; Carry-forward note "the interface should consume the conformance harness for its substitutability test".
- [Source: prod/packages/ledger/{package.json,tsconfig.json}] — the package-with-workspace-dep scaffold model.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Gate: `pnpm typecheck` ✓; `pnpm lint` ✓; `pnpm test` ✓ 210 (+21 in `@rose/authorization`, 5 new test files); `pnpm format` then `pnpm format:check` ✓; `pnpm check:regime` ✓; `pnpm check:migrations` ✓ (5, unchanged); `(cd prod/contracts && forge test)` ✓ 3.

### Completion Notes List

- New leaf-consumer PROD package `@rose/authorization` depending ONLY on `@rose/rule-spec` (`workspace:*`) — the correct consumer→source-of-truth direction. Wired into root `tsconfig.json` references after `rule-spec`, with a project `references: [../rule-spec]` so `tsc -b` builds in order.
- **AC-1 (fail-closed):** `AuthorizationProvider` interface (`authorize(request) → AuthorizationDecision`) built on the rule-spec `Effect` vocabulary; `DEFAULT_EFFECT = 'DENY'` + `denyByDefault()` define the single fail-closed default; `makeDefaultDenyProvider` denies EVERY request (proven across permitted-looking, uncovered, and floor-guarded inputs). The decision vocabulary and the `TransferScenario`/`ConformanceEnv` request shapes are REUSED from rule-spec, never redeclared.
- **AC-2 (substitutability):** `providerToPlaneAdapter` bridges any provider into the rule-spec `PlaneAdapter`, and `assertProviderConforms` reuses the Story-3.1 `runConformance`/`assertAllConform` harness over the SHARED `conformanceVectors`. The policy-backed provider (delegating to `makeReferenceOffChainAdapter(generateOffChainPolicy(ruleSpecV1))`) passes ALL OFF_CHAIN vectors; the all-deny baseline FAILS the gate (proving it is non-vacuous). A single generic call site (`decide(provider, request)`) drives default-deny, policy-backed, and an inline allow-all fake unchanged (SPEC §5 interface-isolation acceptance).
- **Money/NFR-2:** no float, no money arithmetic in this layer — floor presence/breach is carried via the rule-spec `ConformanceEnv` (`bigint`/boolean) inputs; the concrete NUMERIC floor math remains Story-3.4 runtime.
- **Scope:** NO `postTransfer` chokepoint (Story 3.3); NO DB `flow_permissions`/production `OffChainPolicyProvider`/`@rose/config` floor wiring (Story 3.4); NO change to `@rose/rule-spec`. **No DB migration** added (`check:migrations` stays at 5). The policy-backed provider is documented as an in-memory reference wrapper, NOT the production provider.

### File List

New (all under `prod/packages/authorization/`):
- `package.json`, `tsconfig.json`
- `src/index.ts`, `src/index.test.ts`
- `src/provider/authorization-provider.ts`
- `src/provider/default-deny-provider.ts`, `src/provider/default-deny-provider.test.ts`
- `src/provider/policy-authorization-provider.ts`, `src/provider/policy-authorization-provider.test.ts`
- `src/conformance/provider-conformance.ts`, `src/conformance/provider-conformance.test.ts`
- `src/conformance/substitutability.test.ts`

Modified:
- `tsconfig.json` (root) — append `{ "path": "prod/packages/authorization" }` to `references`.
- `pnpm-lock.yaml` — `@rose/authorization` workspace package linked via `pnpm install`.

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-06-16 | 0.1 | Story drafted (create-story) — ready-for-dev | Bob (SM) |
| 2026-06-16 | 0.2 | Implemented `@rose/authorization` (AuthorizationProvider interface + default-deny + policy-backed conformant provider + substitutability gate reusing the 3.1 harness), full gate green (210 tests) — review | Amelia (Dev) |
| 2026-06-16 | 0.3 | Code review: fixed audit-reason accuracy + non-vacuous conformance gate + literal `DEFAULT_EFFECT` + blank-reason guard + exhaustiveness guard + non-tautological bridge/non-vacuity tests; +2 regression tests (212), gate green — done | Amelia (Dev) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (autonomous adversarial review — Blind Hunter / Edge Case Hunter / Acceptance Auditor, independent contexts).
**Date:** 2026-06-16
**Outcome:** Approve (both ACs independently confirmed MET with non-vacuous evidence; all Med/Low findings fixed and regression-tested; no scope creep).

### Acceptance verdict
- **AC-1 (default-deny / fail-closed)** met — `makeDefaultDenyProvider` unconditionally returns `DENY`; `DEFAULT_EFFECT = 'DENY'`; proven both for the trivial baseline and for an unmatched flow through the rule-derived policy provider (`DEPLOYED_CAPITAL → EXTERNAL ⇒ DENY`).
- **AC-2 (substitutability + shared-vector conformance)** met — one generic `decide(provider, request)` call site drives default-deny, policy-backed, and an inline allow-all fake unchanged (SPEC §5); `assertProviderConforms` reuses the Story-3.1 `runConformance`/`assertAllConform` over the imported `conformanceVectors`; the policy provider passes ALL OFF_CHAIN vectors and the all-deny baseline FAILS the gate (non-vacuous), now also guarded against a zero-vector vacuous pass.
- **Scope** clean — only the `@rose/authorization` package + the root `tsconfig.json` reference; no `postTransfer` (3.3), no DB `flow_permissions`/production provider/`@rose/config` floor wiring (3.4), no change to `@rose/rule-spec`, no migration. Dependency direction (authorization → rule-spec via `workspace:*`) and vocabulary reuse (`Effect`/`TransferScenario`/`ConformanceEnv` imported, not redeclared) verified.

### Action Items (all resolved)
- [x] **[Med] Misleading DENY audit reason** — the DENY reason now covers all three origins (prohibition / uncovered / floor-breach) without falsely claiming "not explicitly permitted" (NFR-3). [`policy-authorization-provider.ts`]
- [x] **[Med] Vacuous conformance gate** — `assertProviderConforms` throws if zero vectors match the plane, so the reusable gate that Story 3.4 / Epic 4 consume cannot pass on zero coverage. [`provider-conformance.ts`]
- [x] **[Low] `reasonFor` exhaustiveness** — added a `never` default guard. [`policy-authorization-provider.ts`]
- [x] **[Low] `DEFAULT_EFFECT` type widened** — narrowed to the `'DENY'` literal via `satisfies`. [`authorization-provider.ts`]
- [x] **[Low] Blank audit reason** — `denyByDefault('')`/whitespace now falls back to the default reason. [`authorization-provider.ts`]
- [x] **[Low] Tautological bridge test** — strengthened to prove `env` is threaded (floor-absent ⇒ REFUSE vs floor-present ⇒ ALLOW). [`provider-conformance.test.ts`]
- [x] **[Low] Non-vacuity rested on unasserted data** — added an assertion that ≥1 OFF_CHAIN vector expects a non-DENY effect. [`provider-conformance.test.ts`]
- Regression tests added (+2, total 212): vacuous-gate refusal + blank-reason guard; one bridge test rewritten to be non-tautological.

### Dismissed (with reason)
- **`providerToPlaneAdapter` defaults `plane = 'OFF_CHAIN'`** — by design (the interface carries no plane; only off-chain vectors exist in P0); documented for Epic 4.
- **Blind Hunter "gate never filters by plane"** — false positive: the reused `runConformance` filters by `adapter.plane` (`rule-spec/src/conformance/harness.ts`).
- **"caller-unchanged proof structurally trivial"** — conventional pattern, adequately backed by the conformance gate and the strengthened tests.
