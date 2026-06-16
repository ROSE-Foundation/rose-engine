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

---

# BMAD Cycle Report — Story 2.4: Embed a coupled pair in a Rose Note, delta-neutral at issuance

**Date:** 2026-06-16
**Pipeline:** create-story → dev-story → code-review, single story, fully autonomous (zero user checkpoints)
**Run:** "run the full BMAD pipeline for story 2-4 of epic 2"
**Final status:** ✅ **Story 2.4 DONE** — and with it **Epic 2 is now COMPLETE** (2.1–2.4 all `done`; `epic-2: done`).

## Outcome at a glance

| Story | Title                                                          | Result  |
| ----- | -------------------------------------------------------------- | ------- |
| 2.1   | Freeze & persist the coupled-pair shared data model            | ✅ done |
| 2.2   | Represent & enforce the pair lifecycle state machine           | ✅ done |
| 2.3   | Record a coupled-pair issuance as one balanced journal entry   | ✅ done |
| 2.4   | Embed a coupled pair in a Rose Note, delta-neutral at issuance | ✅ done |

**Final verification gate (all green):** `typecheck` · `lint` · **Vitest 142/142** (+9 new in `rose-notes.test.ts`, of which +4 came from review) · `format:check` · `check:regime` · `check:migrations` (up→down→up over **5** migrations) · **forge 3/3**.

## What was built (Story 2.4)

`@rose/ledger` gains the off-chain **Rose Note ↔ coupled-pair embedding** (FR-12):

- **`rose_notes` table (migration `0005`)** — `id`, `coupled_pair_id uuid NOT NULL UNIQUE REFERENCES coupled_pairs(id)`, `timestamptz` timestamps. The single NOT NULL FK column makes "references **exactly one** pair" structural (zero/two unrepresentable); the UNIQUE makes the **1:1 embedding** (a documented P0 interpretation of "embed … in a Note", reversible later if D1 decides).
- **Delta-neutral-at-issuance invariant** — equal-notional legs (`long_leg_value = short_leg_value`) required at note creation, enforced at two layers: the app guard `createRoseNote` (typed `NotDeltaNeutralError`, pure bigint equality, NFR-2) and a **`BEFORE INSERT OR UPDATE` DB trigger** as the non-bypassable backstop. It fires on INSERT, and on UPDATE only when `coupled_pair_id` changes — so the embedded pair's own legs may legitimately diverge **after** issuance ("directional risk arises only from strategy") without invalidating the note.
- **AC-2 (D1 parked)** — the table is deliberately minimal: **no** composition-mode (bundled vs separate L/S) or post-reset loss-allocation column; the trigger checks leg **equality only** (not the V_A+V_B=K conservation — Epic 7). A test locks the exact column set so no future story can silently smuggle a D1-committing column past AC-2.
- `getCoupledPair` widened `RoseDb → RoseExecutor` (forward-compatible composition seam for Epic 6; backward compatible). New `createRoseNote` / `getRoseNote` / `NotDeltaNeutralError` exported from `@rose/ledger`.

## Code review (3 adversarial lenses, live Postgres 18 probed)

Both ACs independently confirmed; no scope creep (no Epic-5 mint, no Epic-6 orchestration). Findings fixed/addressed:

- **[Med — FIXED] Re-point bypass** — a raw `UPDATE rose_notes SET coupled_pair_id = <skewed pair>` evaded the original INSERT-only trigger. Trigger is now `BEFORE INSERT OR UPDATE` (re-checks only when the FK changes); +2 regression tests.
- **[Med — addressed] UNIQUE over-attribution** — docstring corrected so UNIQUE is the 1:1-embedding decision, not part of "exactly one"; the 1:1 decision is retained and documented.
- **[Med — document + test] 0/0 pair** — `0 == 0` is delta-neutral; this data-model layer accepts it by design (economic substance / positive notional is enforced upstream at issuance, Story 2.3, and at Epic-6 subscription). Documented and locked with a test rather than inventing scope.
- **[Low — FIXED] Test honesty** — removed the trigger's redundant `IF NOT FOUND` branch so the real FK (23503) and NOT NULL (23502) constraints reject with native codes; those tests now genuinely exercise the constraints. +2 tests (NULL "zero-pair" arm, no-op update allowed).
- **[Low — dismissed, correct by design] TOCTOU** — the hunter proved the trigger re-reads `coupled_pairs` at insert time and closes the app-guard race; the app read is an advisory pre-check.

## Key decisions & variances (documented in the story)

- **`rose_notes` lives in `@rose/ledger`**, not the architecture's idealized `coupled-pair/` / `rose-note/` packages — consistent with the Epic-2 consolidation (Stories 2.1–2.3) where the coupled-pair contract shares the ledger's schema/migration/repository/FK machinery. The dedicated `rose-note/` package (Epic 6) is for live subscription/redemption orchestration, not this data-model contract.
- **Two appended-migration reversibility tests** (`coupled-pairs.test.ts` 0003, `coupled-pair-lifecycle.test.ts` 0004) had their hard-coded rollback step counts bumped (2→3, 1→2) to account for migration 0005 now sitting on top — test-only, **no DONE migration edited** (the same maintenance Story 2.2 applied to the 0003 test).

## Carry-forward / notes (Story 2.4)

- **No git commit made** (project policy: commit only on explicit request). Changes are staged-in-tree, gate-green.
- **Deferred / documented:** if the product later allows one pair to back multiple Rose Notes (D1), relax the `UNIQUE (coupled_pair_id)` via a new migration; requiring the embedded pair to be ACTIVE / carry positive notional belongs to the Epic-6 subscription flow, not this contract.
- **Next:** Epic 2 retrospective is `optional`; the next backlog work is **Epic 3 (Capital-Flow Authorization — Single Chokepoint & Single-Source Rules)**, starting at story 3.1.

---

# BMAD Cycle Report — Story 3.1: Single-source rule specification & conformance vectors

**Date:** 2026-06-16
**Project:** rose-engine
**Pipeline:** create-story → dev-story → code-review, autonomous (zero user checkpoints)
**Run:** "one story end-to-end" — Epic 3, Story 3.1
**Final status:** done — story 3.1 `done`; epic-3 now `in-progress`

## What was built (Story 3.1)

New leaf PROD package **`@rose/rule-spec`** (only `zod`) — the single source of truth both authorization planes derive from (FR-19 / §8 Q5). Wired into the root `tsconfig.json` references; no `workspace:*` dep (the planes depend on rule-spec, never the reverse).

- **Versioned declarative rule spec** (`src/spec/`) — a Zod-validated DSL (`ruleSpecSchema`) with `version` + four mandated sections (eligibility, transferRestrictions, modelABrightLine, pairCoupling) and a fail-closed `defaultEffect: 'DENY'`. `ruleSpecV1` is the concrete v1 source; `loadRuleSpec` refuses malformed input with typed `RuleSpecValidationError`.
- **Codegen** (`src/codegen/`) — pure deterministic `generateOffChainPolicy(spec)` emits the off-chain policy artifact (allow-rules + prohibitions + floor-guards); a `tsx` CLI writes the committed `off-chain-policy.generated.json`. A byte-identical **drift test** proves rules are never hand-edited per-plane (AC-2).
- **Conformance** (`src/conformance/`) — 10 shared vectors (ALLOW/DENY/REFUSE) covering the P0 rule set, each tagged for BOTH planes; a reusable `runConformance` harness with a pluggable `PlaneAdapter`; an in-process reference off-chain adapter (the semantic baseline Story 3.4 and Epic 4 must reproduce — NOT the production provider).

**Money/NFR-2:** no float — the BACKING_FLOAT floor is a `floorConfigKey` resolved at runtime in Story 3.4 (refuse-if-absent), and floor presence/breach is modeled as `ConformanceEnv` inputs. **No DB migration** (check:migrations stays at 5).

## Code review (3 adversarial lenses, independent contexts)

Both ACs independently confirmed; no scope creep (no 3.2 interface, no 3.3 postTransfer, no 3.4 DB/provider/config wiring). Findings fixed + regression-tested (+8 tests, 181 → 189):

- **[Med — FIXED] Reference-adapter resolution order** — absolute prohibitions now evaluated first; a structural bright line DENIES unconditionally instead of degrading to REFUSE on absent floor config.
- **[Med — FIXED] Floor guard over-scoping** — floor guards are scoped to the specific allow-rule (`FloorGuard.allowRuleId`), not the source account; an uncovered BACKING_FLOAT flow now fails closed (DENY) instead of leaking a floor REFUSE.
- **[Med — FIXED] Floor breach unknown ⇒ fail-open** — a floor-guarded egress is ALLOWed only when proven at/above the floor; unknown/breach ⇒ DENY (fail-closed, NFR-4).
- **[Med — FIXED] Generated-artifact path leaked to public surface** — `GENERATED_OFF_CHAIN_POLICY_PATH` removed from the barrel (the JSON is not copied into `dist/`); consumers call `generateOffChainPolicy(ruleSpecV1)` in-memory.
- **[Low — FIXED] Rule-id integrity** — schema `superRefine` refuses duplicate / codegen-reserved rule ids.
- **[Low — FIXED] Model-A coupling** — coherence test locks the derived prohibition's `allowedDestination` to a real allow-rule.
- **Dismissed:** asset-kind-agnostic allow-rules (by design P0); version drift (already tested); exactly-at-floor boundary (kept out of cross-plane vectors deliberately).

## Final gate result

| Gate                           | Result                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` (tsc -b)      | ✅                                                                                                   |
| `pnpm lint` (eslint)           | ✅ clean                                                                                             |
| `pnpm test` (vitest)           | ✅ **189 passed** (16 files; +47 vs Epic-2 baseline of 142, of which +39 new + 8 review regressions) |
| `pnpm format:check` (prettier) | ✅                                                                                                   |
| `pnpm check:regime`            | ✅ /prod ↮ /throwaway                                                                                |
| `pnpm check:migrations`        | ✅ up→down→up over 5 migrations (none added)                                                         |
| `forge test` (prod/contracts)  | ✅ 3/3                                                                                               |

## Carry-forward / notes (Story 3.1)

- **No git commit made** (project policy). Changes are in-tree, gate-green.
- **For Story 3.2** (`AuthorizationProvider` default-deny interface): the `Effect = ALLOW|DENY|REFUSE` vocabulary and the fail-closed default are already established here; the interface should consume the conformance harness for its substitutability test.
- **For Story 3.3** (`postTransfer` chokepoint): the conformance vectors define the decisions the chokepoint must obtain from the provider before writing transfer postings.
- **For Story 3.4** (off-chain `OffChainPolicyProvider`): consume `generateOffChainPolicy(ruleSpecV1)` to seed the DB `flow_permissions` table; the production provider must reproduce the reference adapter's semantics and pass the SAME `conformanceVectors` via a real off-chain `PlaneAdapter`. The `BACKING_FLOAT` floor is resolved from `@rose/config` under key `backing_float.floor` (refuse-if-absent). Map generated allow-rules to ledger `account_type` and assert vocabulary alignment on the consumer side.
- **For Epic 4** (on-chain): derive the on-chain compliance config from the SAME `ruleSpecV1`; run the SAME vectors through an on-chain `PlaneAdapter`. `eligibility.requiredClaimTopics` (`['ONCHAINID_KYC']`) and `pairCoupling` are recorded in the spec awaiting on-chain derivation. Add a second codegen emitter (`generate-on-chain-*`) beside `generate-off-chain-policy.ts`.

---

# BMAD Cycle Report — Story 3.2: Provide the default-deny Authorization Provider interface (substitutable)

**Date:** 2026-06-16
**Pipeline:** create-story → dev-story → code-review, single story, fully autonomous (zero user checkpoints)
**Run:** "create-story → dev-story → code-review for story 3-2 only"
**Final status:** ✅ **Story 3.2 DONE** (Epic 3 remains `in-progress`: 3.1 + 3.2 done; 3.3, 3.4 backlog)

## What shipped

New PROD package **`@rose/authorization`** — the substitutable, default-deny authorization seam (FR-5, FR-8 default, NFR-4, NFR-8). It CONSUMES `@rose/rule-spec` via `workspace:*` (the correct consumer→source-of-truth direction) and reuses its `Effect` vocabulary, `TransferScenario`/`ConformanceEnv` shapes, shared `conformanceVectors`, and `runConformance` harness — nothing is redeclared.

- **The interface (AC-1, fail-closed):** `AuthorizationProvider { name; authorize(request) → AuthorizationDecision }` built on the rule-spec `Effect`. `DEFAULT_EFFECT = 'DENY'` + `denyByDefault()` define the single fail-closed default; `makeDefaultDenyProvider` denies EVERY request. A DENY/REFUSE is a returned decision, never a thrown exception.
- **Conformant provider:** `makePolicyAuthorizationProvider(policy)` delegates to the Story-3.1 `makeReferenceOffChainAdapter` over `generateOffChainPolicy(ruleSpecV1)` — reproduces the single-source decisions without re-authoring any rule logic. Explicitly NOT the Story-3.4 DB-backed production provider.
- **Substitutability gate (AC-2):** `providerToPlaneAdapter` bridges any provider into the rule-spec `PlaneAdapter`; `assertProviderConforms` reuses `runConformance`/`assertAllConform` over the shared vectors so any conformant provider passes the SAME vectors. A single generic caller drives default-deny, policy-backed, and an allow-all fake unchanged (SPEC §5).

**Money/NFR-2:** no float, no money arithmetic — floor presence/breach is carried via the rule-spec `ConformanceEnv`. **No DB migration** (check:migrations stays at 5). **No `postTransfer` (3.3), no DB `flow_permissions`/production provider/`@rose/config` wiring (3.4), no change to `@rose/rule-spec`.**

## Code review (3 adversarial lenses, independent contexts)

Acceptance Auditor confirmed both ACs MET with non-vacuous evidence; no scope creep; dependency direction, vocabulary reuse, and glossary discipline clean. No High findings. Med/Low findings fixed + regression-tested (+2 tests, 210 → 212):

- **[Med — FIXED] Misleading DENY audit reason** — the DENY reason now covers all three origins (prohibition / uncovered / floor-breach) without falsely claiming "not explicitly permitted" (NFR-3).
- **[Med — FIXED] Vacuous conformance gate** — `assertProviderConforms` throws if zero vectors match the plane, so the reusable 3.4/Epic-4 gate cannot pass on zero coverage.
- **[Low — FIXED] `reasonFor` exhaustiveness** — `never` default guard added.
- **[Low — FIXED] `DEFAULT_EFFECT` widened** — narrowed to the `'DENY'` literal via `satisfies`.
- **[Low — FIXED] Blank audit reason** — `denyByDefault('')`/whitespace falls back to the default reason.
- **[Low — FIXED] Tautological bridge test** — strengthened to prove `env` is threaded (floor-absent ⇒ REFUSE vs floor-present ⇒ ALLOW).
- **[Low — FIXED] Non-vacuity rested on unasserted data** — asserts ≥1 OFF_CHAIN vector expects a non-DENY effect.
- **Dismissed:** `providerToPlaneAdapter` plane default (by design); "gate never filters by plane" (false positive — the reused harness filters); "caller proof trivial" (backed by the gate).

## Final gate result

| Gate                           | Result                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `pnpm typecheck` (tsc -b)      | ✅                                                         |
| `pnpm lint` (eslint)           | ✅ clean                                                   |
| `pnpm test` (vitest)           | ✅ **212 passed** (21 files; +23 in `@rose/authorization`) |
| `pnpm format:check` (prettier) | ✅                                                         |
| `pnpm check:regime`            | ✅ /prod ↮ /throwaway                                      |
| `pnpm check:migrations`        | ✅ up→down→up over 5 migrations (none added)               |
| `forge test` (prod/contracts)  | ✅ 3/3                                                     |

## Carry-forward / notes (Story 3.2)

- **No git commit made** (project policy). Changes are in-tree, gate-green.
- **For Story 3.3** (`postTransfer` chokepoint): add `postTransfer(from, to, amount, context)` inside `@rose/authorization`; it must consult an injected `AuthorizationProvider` BEFORE writing any transfer posting, and be the only writer of transfer postings. Build the `AuthorizationRequest` (`{ scenario, env }`) from the concrete accounts/amount/context. The default-deny baseline is the safe fallback when no policy is wired.
- **For Story 3.4** (production `OffChainPolicyProvider`): implement a real `AuthorizationProvider` over the DB `flow_permissions` table (seeded from `generateOffChainPolicy(ruleSpecV1)`), resolving the `BACKING_FLOAT` floor from `@rose/config` (key `backing_float.floor`, refuse-if-absent). Prove it with `assertProviderConforms(provider)` — the SAME gate this story shipped — so the production provider reproduces the reference semantics.
- **For Epic 4** (on-chain): an on-chain `AuthorizationProvider`/adapter passes `plane = 'OFF_CHAIN'`'s counterpart explicitly to `providerToPlaneAdapter`/`assertProviderConforms` (the interface carries no plane by design).

---

# BMAD Cycle Report — Story 3.3: Route all off-chain capital movement through the `postTransfer` chokepoint

**Date:** 2026-06-16
**Pipeline:** create-story → dev-story → code-review, single story, fully autonomous (zero user checkpoints)
**Run:** "run the full BMAD pipeline for story 3-3 of epic 3"
**Final status:** ✅ **Story 3.3 DONE** (epic 3 now at 3.1–3.3 `done`; only 3.4 remains).

## Outcome at a glance

| Story | Title                                                       | Result  |
| ----- | ----------------------------------------------------------- | ------- |
| 3.1   | Single-source rule spec + conformance vectors               | ✅ done |
| 3.2   | Default-deny Authorization Provider (substitutable)         | ✅ done |
| 3.3   | Route all off-chain capital movement through `postTransfer` | ✅ done |

**Final verification gate (all green):** `typecheck` · `lint` · **Vitest 237/237** (+25 in `@rose/authorization`: `post-transfer.test.ts` 20, `chokepoint-guard.test.ts` 5; of which +3 came from review) · `format:check` · `check:regime` · `check:migrations` (up→down→up over **5** migrations — this story adds none) · **forge 3/3**.

## What was built (FR-7 — single chokepoint)

`@rose/authorization` gains the off-chain capital-movement **chokepoint** `postTransfer(from, to, amount, context)`:

- Builds a rule-spec `TransferScenario`/`AuthorizationRequest` from typed inputs and **consults the Story-3.2 `AuthorizationProvider` BEFORE any write**.
- **Fail-closed (NFR-4):** a `DENY`/`REFUSE` throws `TransferRefusedError` (carrying the non-allow `effect` + `reason` + `scenario`) and writes **nothing**; only `ALLOW` records exactly one balanced transfer entry (CREDIT `from`, DEBIT `to`) via the Story-1.6 `recordJournalEntry` primitive (the DEFERRABLE double-entry trigger is the DB backstop).
- The **10 shared conformance vectors** (Story 3.1) drive the real `makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1))` and define the ALLOW/DENY/REFUSE outcomes the chokepoint enforces — proven against the live Postgres (DENY/REFUSE ⇒ zero rows).
- **Chokepoint guard (AC-2):** a static/dependency scan locks the sole direct `postings` writer to the ledger primitive and asserts `postTransfer` routes through it after `authorize`; the runtime no-write-on-deny half + transaction-rollback composition complete the proof.
- The package now depends on `@rose/ledger` + `@rose/shared` (`workspace:*`); build order stays acyclic (`shared → rule-spec → ledger → authorization`). **No DB migration.**

## How it ran (the pipeline)

**create-story** produced the context-rich spec (architecture-cited, tightly scoped, the considered "inject a ledger port" alternative documented and rejected in favor of the architecture's explicit `authorization/post-transfer.ts` placement). **dev-story** implemented test-first/red-green and drove the full gate green (234 tests). **code-review** launched **3 parallel adversarial layers** (Blind Hunter on the diff, Edge Case Hunter probing the live Postgres, Acceptance Auditor against spec/epic/architecture). Acceptance Auditor verdict: **PASS** — both ACs met with non-vacuous evidence, scope clean. Sprint status advanced `backlog → ready-for-dev → in-progress → review → done`.

## Notable review decisions

- **Patched:** self-transfer (`from === to`) now rejected before provider/DB (no phantom no-op entry); the ALLOW audit log moved to AFTER a successful write; the static-guard regex hardened to catch `insert(schema.postings)` / quoted raw SQL and to strip comments (no false positives). +3 regression tests (→ 237).
- **Deferred (documented in `deferred-work.md`):** binding caller-supplied authorization facts to persisted account rows (Story 3.4's DB-backed fact resolution; cross-asset already fail-safe); amount-sensitive authorization (the `TransferScenario` vocabulary is frozen in 3.1 — floor-breach is modeled via `ConformanceEnv`, computed at runtime in 3.4); the aliased-import residual gap of a static dependency-scan guard.
- **Dismissed:** `throughVcc` undefined-vs-false (not a fail-open — the prohibition matches only `=== true`); the `catch {}` "masking" (the remapped float message is accurate by construction).

## Carry-forward for Story 3.4 (last of Epic 3)

- **Wire `postTransfer` to the production provider:** Story 3.4 builds the DB-backed `OffChainPolicyProvider` over a `flow_permissions` table seeded from `generateOffChainPolicy(ruleSpecV1)`, resolving the `BACKING_FLOAT` floor from `@rose/config` (key `backing_float.floor`, refuse-if-absent ⇒ the `REFUSE` effect `postTransfer` already enforces). Because the provider is substitutable, swapping it into `postTransfer` requires **zero chokepoint changes** (NFR-8) — and the new migration will move `check:migrations` from 5 → 6.
- **Resolve the deferred trust-binding here:** 3.4 owns deriving/validating `accountType`/`destinationKind`/`classification`/floor from persisted state; it should compute `ConformanceEnv.postBalanceBelowFloor` from the real `BACKING_FLOAT` balance + the config floor (NUMERIC, no float — NFR-2) and feed it into the `postTransfer` `context.env`.
- **Reuse the gates this story shipped:** `assertProviderConforms(provider)` (3.2) over the SAME 10 vectors, and the `chokepoint-guard` static scan, both remain the acceptance gates.
- **No git commit made** (project policy). All changes in-tree, gate-green.

---

# Story 3.4 — Enforce the minimal P0 rule set via the generated off-chain policy provider (LAST of Epic 3)

**Status: done.** Epic 3 is now **done** (all four stories complete). Full gate green: **263 tests** (was 237 baseline), `typecheck`, `lint`, `format:check`, `check:regime`, `check:migrations` (up→down→up over **6**). No git commit (project policy).

## What shipped

- **`flow_permissions` table (migration 0006, append-only + reversible)** + Drizzle schema. It persists the GENERATED off-chain policy artifact verbatim (one row per clause: ALLOW_RULE / PROHIBITION / FLOOR_GUARD), with CHECK-guarded `default_effect` / `clause_kind` and a UNIQUE `clause_id`. The table is a faithful PROJECTION of the single source, not an independent rule set.
- **`@rose/authorization` flow-permissions module:**
  - `policy-store.ts` — `seedFlowPermissions` (idempotent, transactional delete+insert) and `loadOffChainPolicy` (reconstructs a byte-identical `OffChainPolicyArtifact`, fail-closed on empty / inconsistent-metadata / non-DENY-default / payload-id-mismatch).
  - `db-policy-provider.ts` — `loadDbOffChainPolicyProvider` returns a substitutable `AuthorizationProvider` that DELEGATES to the Story-3.1 reference semantics over the DB-loaded artifact (no rule re-authoring) ⇒ passes the SAME 10 conformance vectors via `assertProviderConforms`.
  - `account-state.ts` — validates the declared source `accountType` against the persisted `accounts` row (`AccountFactMismatchError`) and reads the account balance in **Postgres NUMERIC → BigInt** (no float, NFR-2).
  - `resolve-env.ts` — resolves the `BACKING_FLOAT` floor from `@rose/config` (`backing_float.floor`; absent ⇒ REFUSE, negative ⇒ REFUSE) and computes `postBalanceBelowFloor` in exact integers.
  - `enforce-transfer.ts` — composes validate-facts → resolve-env → the UNCHANGED `postTransfer` with the DB provider. **Zero chokepoint change** (NFR-8): `post-transfer.ts` is not in the diff.

## How it ran (the pipeline)

**create-story** produced the architecture-cited, tightly-scoped spec (reuses 3.1 codegen + reference adapter + 3.2 conformance gate; flags the persisted-state residual up front). **dev-story** implemented test-first/red-green and drove the gate green (259 tests). **code-review** launched **3 parallel adversarial layers** (Blind Hunter on the scoped diff, Edge Case Hunter probing the live Postgres, Acceptance Auditor against spec/epic/architecture). Acceptance Auditor verdict: **PASS** — all ACs met with non-vacuous evidence, scope clean. Sprint status advanced `backlog → ready-for-dev → in-progress → review → done`; `epic-3 → done`.

## Notable review decisions

- **Patched (3, +4 regression tests → 263):**
  1. **[High] negative `BACKING_FLOAT_FLOOR` fail-open** — a negative floor satisfied `postBalance < floor === false`, silently authorizing a drain. Now treated as no usable floor ⇒ REFUSE.
  2. **[Med] non-atomic seed** — `seedFlowPermissions` delete+insert now runs in a transaction so a concurrent `loadOffChainPolicy` can't observe the empty window.
  3. **[Low] payload integrity** — `loadOffChainPolicy` now asserts each row's `payload.id === clause_id`, rejecting a tampered/mis-bucketed clause.
- **Deferred (documented in `deferred-work.md` + a code-comment trust boundary):**
  - **[High→Epic 4]** `classification` and `destinationKind` are not persisted columns in P0, so they remain caller-asserted facts (load-bearing for the Model-A prohibition + destination match). Authoritative off-chain enforcement of the principal/yield distinction is on-chain in Epic 4 (segregated principal sub-positions). Story 3.4 binds what IS persisted (source account type, asset/scale, balance, floor).
  - **[Low→Epic 6]** floor/scale parse faults surface as a raw `RangeError` (fail-closed, but not the `TransferRefusedError` contract an API maps to 4xx) — mapping belongs at the REST boundary.
- **Dismissed:** Blind Hunter's "`0005-rose-notes` import missing" — diff-only false positive (the file exists from a prior story).

## Carry-forward for Epic 4 (on-chain ERC-3643)

- The off-chain plane is the **conformance baseline**: Epic 4's on-chain compliance config must be generated from the SAME rule-spec and pass the SAME 10 vectors via an on-chain `PlaneAdapter` (the `ON_CHAIN`-tagged vectors already exist).
- The **authoritative Model-A principal/yield bright line** moves on-chain (segregated principal sub-positions), closing the off-chain `classification`/`destinationKind` trust residual.
- Migration count is now **6**; the rule-spec single-source + drift guard remain the contract both planes derive from.

---

# BMAD Cycle Report — Story 4.1: Stand up ONCHAINID identity and eligibility infrastructure (FIRST of Epic 4)

## Outcome at a glance

- **Status:** done. First on-chain story of Epic 4; `epic-4` → in-progress.
- **Plane:** Solidity / Foundry (`prod/contracts`). TypeScript packages untouched — Vitest stays **263/263**.
- **Forge tests:** **60/60** (3 pre-existing scaffold + 50 authored + 7 review-regression).
- **Full gate green:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (263), `pnpm check:regime`, `pnpm check:migrations` (6), `pnpm format:check`, and `forge test` (60).

## What was built (FR-19 foundation — identity + eligibility, no transfer enforcement yet)

A self-contained ONCHAINID / ERC-3643 identity stack on OpenZeppelin 5.6.1, under `prod/contracts/src/identity/`:

- **`Identity.sol`** — ONCHAINID (ERC-734 keys + ERC-735 claims): purpose-based key mgmt (MANAGEMENT/ACTION/CLAIM), deterministic `claimId = keccak256(abi.encode(issuer, topic))`, management-gated mutations.
- **`ClaimIssuer.sol`** — trusted claim issuer: ECDSA-signed claim validation (`isClaimValid` via OZ `ECDSA.tryRecover` + `MessageHashUtils`) and signature-keyed revocation; fail-closed on bad signatures.
- **`ClaimTopicsRegistry.sol`** / **`TrustedIssuersRegistry.sol`** — owner-curated required topics and per-topic trusted issuers (EnumerableSet-backed, dup/empty rejection, bounded).
- **`IdentityRegistry.sol`** (+ **`AgentRole.sol`**) — the **curated allowlist** (agent-gated registration) plus the **fail-closed `isVerified`** predicate that joins all three registries; this is the eligibility decision the token will enforce in 4.2.
- **`ClaimTopics.sol`** — pins `ONCHAINID_KYC = uint256(keccak256("ONCHAINID_KYC"))` to `@rose/rule-spec` `eligibility.requiredClaimTopics`, with an explicit note that **Story 4.5** will generate (not hand-pin) this mapping.
- 7 interfaces + 6 Foundry test files (incl. 2 fuzz tests + a reverting-identity mock).

## How it ran (the pipeline)

**create-story** produced an architecture-cited, tightly-scoped spec (ERC-734/735 + ERC-3643 patterns, OZ 5.6, fail-closed, rule-spec alignment; explicit OUT-of-scope list for 4.2–4.6). **dev-story** implemented the suite and drove `forge test` 53→ green plus the full TS gate. **code-review** ran **3 parallel adversarial layers** (Blind Hunter correctness, Edge-Case Hunter, Acceptance Auditor). Acceptance Auditor: **PASS** on all ACs, no scope creep, rule-spec unmodified.

## Notable review decisions

- **Patched (4, +7 regression tests → 60 forge):**
  1. **[High] last-management-key brick** — `Identity.removeKey` could remove the only MANAGEMENT key, permanently locking the identity. Guarded (matches ONCHAINID reference).
  2. **[Med] `isVerified` not truly total** — holder-identity calls (`getClaimIdsByTopic`/`getClaim`) weren't try/catch-wrapped, so a hostile registered identity could turn the eligibility predicate into a revert (DoS). Now fully wrapped — `isVerified` always returns a bool.
  3. **[Med] EOA trusted issuer** — `addTrustedIssuer` now requires the issuer address to have code (a codeless issuer would make `isVerified` revert uncatchably).
  4. **[Low] `addKey` event/storage divergence** — `KeyAdded` now emits the stored `keyType` for an already-registered key.
- **Resolved a layer disagreement by reading source:** Edge-Case Hunter's "[High] EIP-2098 compact-signature revocation bypass" was **dismissed as a false positive** — the installed OZ 5.6.1 `ECDSA.tryRecover(bytes32,bytes)` rejects any non-65-byte signature (`InvalidSignatureLength`); Blind Hunter was correct.
- **Deferred (documented in `deferred-work.md`):** empty-required-topics ⇒ verified (ERC-3643 semantics; rule-spec is `.min(1)`, topics seeded in 4.5); unbounded claims-per-topic (self-griefing OOG; revisit when `isVerified` gates transfers in 4.2); no EIP-1271 contract-signer issuers (P0 uses an EOA signing key).

## Carry-forward / interface points for Stories 4.2 → 4.6

- **4.2 (enforce eligibility on transfers):** consume `IIdentityRegistry.isVerified(address)` in the token's transfer hook. It is now **total/fail-closed** (never reverts), safe to call inline; mind the self-griefing claim-count OOG note when it becomes hot-path.
- **4.5 (rule-spec → on-chain codegen + dual-plane conformance):** replace the hand-pinned `ClaimTopics.ONCHAINID_KYC` with a generated constant and seed `ClaimTopicsRegistry` from `@rose/rule-spec`; the topic id (`uint256(keccak256("ONCHAINID_KYC"))`) and the curated-allowlist == `IdentityRegistry` mapping are the agreed equivalences. The empty-topics hardening lands here.
- **4.6 (agent powers + Sepolia deploy):** `AgentRole` is in place (addAgent/removeAgent/onlyAgent) as the gating primitive; forced-transfer/recovery/freeze/pause and the `forge script` deploy are NOT in 4.1.
- **Registries are constructor-wired** (`IdentityRegistry(owner, claimTopicsRegistry, trustedIssuersRegistry)`) — the deploy script in 4.6 must deploy the two registries first, then the registry, then `addAgent` the claim-issuer operator and the token.

---

# Story 4.2 — Enforce eligibility on transfers in the custom ERC-3643-compatible token

**Status: done** · pipeline: create-story → dev-story → code-review · 2026-06-16

## Outcome

Delivered `RoseToken`, the base custom ERC-3643-compatible token (OZ 5.6.1 `ERC20` + `Ownable`). A single override of `_update` is the eligibility chokepoint: it consults the Story-4.1 `IIdentityRegistry.isVerified` so tokens can only land on, or leave, verified holders (fail-closed, NFR-4). Because OZ-5 routes `transfer`, `transferFrom`, `_mint`, and `_burn` through `_update`, one override gates them all. `_update` is left `virtual` for Stories 4.3 (coupling) / 4.4 (Model-A).

## Files

- `prod/contracts/src/token/interface/IRoseToken.sol` (new) — `is IERC20`; adds `identityRegistry()`, `setIdentityRegistry`, `mint`, `burn`, `IdentityRegistrySet` event.
- `prod/contracts/src/token/RoseToken.sol` (new) — eligibility-gated `_update`; owner-gated `mint`/`burn`/`setIdentityRegistry`.
- `prod/contracts/test/token/RoseToken.t.sol` (new) — 17 Foundry tests (incl. 2 fuzz) reusing the 4.1 `ClaimFixtures` + identity-stack harness.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`, `deferred-work.md`, this report (updated).

## Gates

Vitest **263/263** (unchanged — Solidity-only story), forge **77/77** (baseline 60 → +17), typecheck / lint / check:regime / check:migrations / format:check all green, `forge fmt --check` clean.

## Notable review decisions

- **3 parallel adversarial layers.** Acceptance Auditor: **PASS on AC-1 and AC-2**, no scope creep, `@rose/rule-spec` unmodified.
- **Patched (1, +1 regression test → forge 77):** the both-sides check also gated owner-driven `burn`, so a revoked/de-listed holder's balance was stranded — untransferable AND unburnable. Both adversarial layers flagged it. Fix: exempt burn (`to == 0`) from the sender check (canonical ERC-3643) so the issuer can reduce a non-compliant holder's supply; real transfers still check BOTH parties, mint still checks the recipient. Regression `test_Burn_Succeeds_AfterHolderRevoked`. Side benefit: the burn path no longer loops a holder's (uncapped) claims, shrinking the OOG blast radius back to holder-self-griefing-only.
- **Dismissed (2):** reentrancy via `isVerified` (it is `view`/STATICCALL, registry calls try/catch-wrapped — no token-state mutation); zero-value transfer to an unverified recipient reverts (by-design fail-closed, NFR-4).
- **Deferred (4, in `deferred-work.md`):** no forced-transfer/recovery + no pause/freeze (Story 4.6); `setIdentityRegistry` has no holder-continuity check (owner-trusted, recoverable, mirrors T-REX); `Ownable` single-key admin / `renounceOwnership` footgun / no role separation (4.6 + ops); unbounded claims-per-topic OOG on the transfer hot path (revisit with 4.6 recovery).

## Carry-forward / interface points for Stories 4.3 → 4.6

- **4.3 (pair coupling, atomic mint/burn):** extend `RoseToken._update` (kept `virtual`) to add both-or-neither leg coupling; the eligibility gate already lives there, so coupling logic layers on top of `super._update`.
- **4.4 (Model-A principal/yield):** same `_update` extension point; add segregated principal sub-positions and block principal egress alongside the eligibility check.
- **4.5 (rule-spec → on-chain codegen):** the token binds to the registry by constructor reference today; 4.5 generates the registry/topic config from `@rose/rule-spec`. No token-side change required beyond wiring the generated registry address.
- **4.6 (agent powers + Sepolia deploy):** replace/augment `Ownable` `onlyOwner` on `mint`/`burn`/`setIdentityRegistry` with a transfer-agent role; add forced-transfer/recovery/freeze/pause; the `forge script` deploy must deploy the registries, then `RoseToken(name, symbol, identityRegistry, owner)`. The burn-exemption already gives the issuer a supply-reduction lever; recovery-to-new-wallet is 4.6.

---

# Story 4.3 — Enforce pair coupling on-chain (atomic paired mint/burn, single-leg impossible)

**Status: done** · pipeline: create-story → dev-story → code-review · 2026-06-16

## Outcome

Delivered on-chain pair coupling as **two coupled `CoupledLeg` tokens** (each a Story-4.2 eligibility-gated `RoseToken`) coordinated by a **`CoupledPair`** primitive that owns and is the SOLE minter/burner of both legs. `mintPair`/`burnPair` move BOTH legs by the same `uint256 amount` in one transaction — atomic, equal-notional. A single-leg mint/burn is impossible on TWO independent layers: (1) the legs' inherited owner-gated `mint`/`burn` are owned by the pair (an EOA reverts `OwnableUnauthorizedAccount`); (2) `CoupledLeg._update` requires `pairingInProgress()` for any mint (`from==0`) or burn (`to==0`), so even the owner cannot single-leg-emit outside the paired flow. The leg↔coupler cycle is resolved by `CoupledPair` deploying both legs in its constructor with `initialOwner == coupler == address(this)`. `CoupledLeg._update` calls `super._update` LAST so the 4.2 eligibility chokepoint (and the ERC20 mutation) stay intact, and is kept `virtual` for Story 4.4 (Model-A). Per D1, legs are independently transferable (directional/separate holding); coupling is enforced on EMISSION, not transfer — a transfer cannot change either total supply, so it can never break coupling.

## Files

- `prod/contracts/src/token/interface/ICoupledPair.sol` (new) — coupling-primitive surface: `lToken()`/`sToken()` (as `IRoseToken`), `pairingInProgress()`, `mintPair`, `burnPair`; `PairDeployed`/`PairMinted`/`PairBurned` events.
- `prod/contracts/src/token/CoupledLeg.sol` (new) — `is RoseToken`; immutable `coupler`; `_update` coupling guard layered on 4.2 eligibility (`super._update` last); kept `virtual`.
- `prod/contracts/src/token/CoupledPair.sol` (new) — `is Ownable, ICoupledPair`; deploys + owns both legs; `_pairing` flag; owner-gated atomic `mintPair`/`burnPair` at equal notional.
- `prod/contracts/test/token/CoupledPair.t.sol` (new) — 19 Foundry unit + fuzz tests (incl. 3 code-review regressions) reusing the 4.1 `ClaimFixtures` + identity-stack harness.
- `prod/contracts/test/token/CoupledPairInvariant.t.sol` (new) — handler + 2 invariants (`invariant_LegSuppliesAlwaysEqual`, `invariant_SingleLegMintNeverSucceeds`).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`, `deferred-work.md`, this report (updated).

## Gates

Vitest **263/263** (unchanged — Solidity-only story), forge **98/98** (baseline 77 → +21), typecheck / lint / check:regime / check:migrations / format:check all green, `forge fmt --check` clean. The two invariants ran 256 runs × 500 calls each (256 000 calls total), 0 reverts, supplies always equal.

## Notable review decisions

- **3 parallel adversarial layers.** Acceptance Auditor: **PASS on AC-1 and AC-2**, no scope creep, `@rose/rule-spec` unmodified; the mandatory Foundry invariant proves coupling cannot be broken.
- **Patched (2 defensive regressions → forge 98):** (a) a zero-address leg target on a paired op must revert ATOMICALLY, never become a silent no-op that desyncs the legs — confirmed safe by construction (OZ `_mint`/`_burn` revert `ERC20InvalidReceiver`/`ERC20InvalidSender` before `_update`) and locked with `test_MintPair_RevertWhen_lToIsZero` / `test_BurnPair_RevertWhen_sFromIsZero`; (b) `burnPair` atomicity under asymmetric balances — `test_BurnPair_RevertWhen_AsymmetricBalance` proves a leg with insufficient balance rolls the other back (both supplies unchanged/equal).
- **Dismissed (2):** reentrancy while `_pairing == true` (plain OZ ERC20 `_mint` has no recipient callback; `isVerified` is a `view` STATICCALL — no exploitable window); "transfers should be paired too" (by D1, transfers are separate and cannot change supply, so cannot break coupling — eligibility still gates them).
- **Deferred (3, in `deferred-work.md`):** `CoupledPair` single-key `Ownable` / `renounceOwnership` footgun (Story 4.6 + ops); leg `setIdentityRegistry` not forwarded through the pair (registry frozen post-deploy — safer now; registry-migration path is 4.6); claims-per-topic OOG on the leg mint/transfer hot path (holder-self-griefing only; revisit with 4.6 recovery).

## Carry-forward / interface points for Stories 4.4 → 4.6

- **4.4 (Model-A principal/yield):** extend `CoupledLeg._update` (kept `virtual`) to add segregated principal sub-positions and block principal egress — it layers on the SAME chokepoint, after `super._update` (eligibility) and alongside the coupling guard. The coupling primitive does not constrain Model-A; they compose on `_update`.
- **4.5 (rule-spec → on-chain codegen + dual-plane conformance):** coupling is expressed STRUCTURALLY here (coupled tokens + paired mint/burn), not via generated config; 4.5 emits eligibility/topic config from `@rose/rule-spec`. The `CoupledPair`/`CoupledLeg` constructors bind to the registry by reference — wire the generated registry address, no coupling-side change required.
- **4.6 (agent powers + Sepolia deploy):** replace `CoupledPair`'s `onlyOwner` on `mintPair`/`burnPair` with the transfer-agent role; add forced-transfer/recovery/freeze/pause on the legs; wire an owner-gated, continuity-checked leg `setIdentityRegistry` through the pair. The `forge script` deploy: registries → `CoupledPair(registry, lName, lSymbol, sName, sSymbol, owner)` (which deploys both legs) → `addAgent` the operator. `burnPair` already retires a revoked holder's coupled package (burn sender-exempt from 4.2); recovery-to-new-wallet is 4.6.
- **5.3 / 5.4 (ledger ↔ chain mint/burn):** `mintPair(lTo, sTo, amount)` is the atomic on-chain commit point for paired issuance (FR-18); `burnPair(lFrom, sFrom, amount)` for redemption (FR-21). Both emit `PairMinted`/`PairBurned` for the event-watcher/outbox-saga; the equal-notional `amount` maps to the balanced ledger entry's leg quantities.

---

# Story 4.4 — Enforce the Model-A bright line and principal/yield distinction on-chain

**Pipeline:** create-story → dev-story → code-review (autonomous). **Final status: `done`.**

## What shipped

The on-chain **segregation primitive** a plain fungible token cannot express: a per-holder **segregated principal sub-position** on `CoupledLeg`, plus the **Model-A bright line** enforced on the SAME `_update` chokepoint (eligibility 4.2 → coupling 4.3 → Model-A 4.4). Principal cannot leave a position via transfer; only the yield surplus (`balance − principal`) moves; principal decreases only via an authorized paired burn (redemption), clamped.

## Files

- `prod/contracts/src/token/CoupledLeg.sol` (modified) — segregated `_principal` mapping, `principalOf(holder)`, owner-gated `designatePrincipal`, `_update` extended AFTER `super._update` with the transfer bright line + burn clamp, events `PrincipalDesignated` / `PrincipalReducedOnBurn`; `_update` kept `virtual`.
- `prod/contracts/src/token/CoupledPair.sol` (modified) — owner-gated forwarders `designateLPrincipal` / `designateSPrincipal` (legs stay sealed from EOAs); `mintPair`/`burnPair`/`_pairing` and `ICoupledPair` untouched.
- `prod/contracts/test/token/CoupledLegPrincipal.t.sol` (new) — 20 Foundry unit + fuzz tests (incl. 2 code-review regressions) reusing the 4.1 `ClaimFixtures` + identity-stack harness.
- `prod/contracts/test/token/CoupledLegPrincipalInvariant.t.sol` (new) — handler + 3 invariants (`invariant_PrincipalNeverExceedsBalance`, `invariant_PrincipalEgressNeverSucceeds`, `invariant_LegSuppliesAlwaysEqual`).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`, `deferred-work.md`, this report (updated).

## Gates

Vitest **263/263** (unchanged — Solidity-only story), forge **121/121** (baseline 98 → +23: 20 unit/fuzz + 3 invariants), typecheck / lint / check:regime / check:migrations / format:check all green, `forge fmt --check` clean. The 3 invariants ran 256 runs × 500 calls each (128 000 calls per invariant), 0 reverts.

## Notable review decisions

- **3 parallel adversarial layers.** Acceptance Auditor: **PASS on AC-1 and AC-2**, no scope creep, `@rose/rule-spec` unmodified. Blind Hunter confirmed both headline invariants HOLD and the bright line is reentrancy-robust (absolute post-transfer balance check, no external call in the added code).
- **Patched (5 → forge 121):** clarity rename of the misleading `totalPrincipal` event param to `holderPrincipal`; strengthened the invariant handler so its assertions are non-trivial (multi-holder-per-leg principal via `designateLPrincipalBob` / `designateSPrincipalAlice`) and S-leg egress is probed (`attemptPrincipalEgressS`); added 2 unit regressions (self-transfer fully-principal, recipient-with-principal yield stacking).
- **Deferred (3, in `deferred-work.md`):** burn retires principal with no leg-level protection beyond owner+coupling gating (by-design; recovery semantics are 4.6 / Epics 5-7); additive `designatePrincipal` with no release path → owner-trusted lock-up (release/crystallization is reset, Epics 5-7); stranded-principal recovery requires burning the counterparty leg (single-leg recovery is 4.6).
- **Dismissed (2):** no zero-address/zero-amount guard on `designatePrincipal` (owner-trusted, no-op); overflow reverts with panic `0x11` not the revert string (owner-only ~2²⁵⁶ fat-finger).

## Carry-forward / interface points for Stories 4.5 → 4.6

- **4.5 (rule-spec → on-chain codegen + dual-plane conformance):** Model-A is expressed STRUCTURALLY here (segregated principal sub-position + chokepoint guard), not via generated config; 4.5 emits the on-chain compliance config from `@rose/rule-spec` and runs dual-plane vectors against it. The off-chain analogue (reject `CLIENT_COLLATERAL` principal egress, allow yield) already shipped in Story 3.4 — 4.5 proves the two planes agree. No principal-side contract change is required for codegen; bind the generated config by reference.
- **4.6 (agent powers + Sepolia deploy):** the principal primitive needs an owner-gated, role-restricted **release / forced-burn / recovery** path — `designatePrincipal` is additive-only by design, so reclassifying or releasing principal (and recovering a revoked holder's principal to a new wallet without burning the counterparty leg) lands with the transfer-agent role. The reset / P&L crystallization that makes yield withdrawable vs principal (D1a) is **Epics 5-7**, built ON this primitive.
- **5.3 / 5.4 (ledger ↔ chain):** at subscription, the issuer mints collateral then `designate{L,S}Principal` marks the principal portion (a separate owner step from `mintPair`); yield accrues as undesignated movable balance. `PrincipalDesignated` / `PrincipalReducedOnBurn` events feed the event-watcher/outbox so the off-chain ledger reconciles the principal/yield split toward the chain (D3, chain = source of truth).

---

# Story 4.5 — Generate on-chain compliance config from the rule-spec and pass dual-plane conformance

**Pipeline:** create-story → dev-story → code-review (autonomous). **Final status: `done`.**

## What shipped

The pivot that proves FR-19: both authorization planes derive from ONE source. A new on-chain codegen emitter (`generateOnChainComplianceConfig`, symmetric to `generateOffChainPolicy`) derives the on-chain compliance config from `ruleSpecV1` — as a committed JSON artifact AND a generated Solidity library (`GeneratedComplianceConfig.sol`), both drift-guarded. The hand-pinned `ClaimTopics.ONCHAINID_KYC` (4.1) now re-exports the GENERATED value; the `ClaimTopicsRegistry` is seeded via the generated `seedClaimTopics` primitive; the deferred "≥1 required topic" fail-closed hardening landed in `IdentityRegistry.isVerified`. A reference ON_CHAIN `PlaneAdapter` runs the SAME 10 shared conformance vectors through the existing harness and decides IDENTICALLY to the off-chain plane (cross-plane equivalence, SM-4).

## Files

- `prod/packages/rule-spec/src/codegen/generate-on-chain-config.ts` (new) — `generateOnChainComplianceConfig` + `OnChainComplianceConfig` types + `serializeOnChainConfig`; reuses the off-chain `FlowPermissionRule`/`Prohibition`/`FloorGuard` vocabulary.
- `prod/packages/rule-spec/src/codegen/generate-on-chain-solidity.ts` (new) — `generateOnChainSolidityConfig` emits the `GeneratedComplianceConfig` library (topic constants via `uint256(keccak256(label))`, `requiredClaimTopics()`, coupling/allowlist flags, `seedClaimTopics`).
- `prod/packages/rule-spec/src/conformance/reference-on-chain-adapter.ts` (new) — `makeReferenceOnChainAdapter` (plane `ON_CHAIN`), fail-closed resolution identical to the off-chain reference adapter.
- `prod/packages/rule-spec/src/codegen/generate-on-chain-config.test.ts`, `generate-on-chain-solidity.test.ts`, `generated-on-chain-artifact-drift.test.ts`, `conformance/dual-plane-conformance.test.ts` (new) — codegen unit tests, JSON + Solidity drift guards, dual-plane + cross-plane equivalence.
- `prod/packages/rule-spec/src/codegen/generated/on-chain-compliance.generated.json` (new, GENERATED).
- `prod/packages/rule-spec/src/codegen/cli.ts`, `codegen/paths.ts`, `index.ts` (modified) — emit both planes; new artifact paths; new exports.
- `prod/contracts/src/generated/GeneratedComplianceConfig.sol` (new, GENERATED) + `prod/contracts/test/generated/GeneratedComplianceConfig.t.sol` (new — 8 tests: topic == keccak, seeding, dual-plane eligibility on real contracts, ≥1-topic hardening).
- `prod/contracts/src/identity/ClaimTopics.sol` (constant ← generated), `src/identity/IdentityRegistry.sol` (≥1-topic fail-closed), `test/identity/IdentityRegistry.t.sol` (empty-topics test inverted), `foundry.toml` (`[fmt] ignore` for `src/generated/**`) (modified).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`, this report (updated).

## Gates

Vitest **302/302** (baseline 263 → +39: on-chain codegen unit + Solidity-generator + drift + dual-plane/cross-plane). forge **129/129** (baseline 121 → +8 in `GeneratedComplianceConfig.t.sol`; one existing test inverted to the hardened empty-topics behavior). typecheck / lint / check:regime / check:migrations / format:check all green, `forge fmt --check` clean. The SAME 10 shared vectors pass on BOTH planes with identical decisions.

## Notable review decisions

- **3 parallel adversarial layers.** Acceptance Auditor: **PASS on AC-1 and AC-2**, no scope creep, `ruleSpecV1`/`conformanceVectors`/`CoupledLeg`/`CoupledPair` untouched, no new runtime dependency. Blind Hunter: no logic defects (emitter mirrors the proven off-chain one; adapter resolution identical; hardening correctly ordered; `paths.ts` resolves under src + dist).
- **Patched (1 → Vitest 302):** the multi-topic Solidity-generator path (N>1 constants/array/assignments) was unreachable from the P0 single-topic spec — added a 2-topic regression locking constant/array/assignment generation + determinism + identifier-safety throw.
- **Dismissed (2):** the on-chain adapter intentionally duplicates the off-chain fail-closed resolution (each reads its own artifact type; the cross-plane equivalence test is the divergence tripwire); the cross-plane numeric topic tie is split (Vitest label-match + Forge keccak) by-design to keep keccak256 in the EVM and avoid a hashing dependency.
- **No new deferrals.** The 4.1 "empty topics ⇒ verified" deferral is RESOLVED here (fail-closed). Prior 4.2/4.3/4.4 `Ownable`/OOG/recovery deferrals remain 4.6 scope.

## Carry-forward / interface points for Story 4.6 (last in Epic 4)

- **Seeding hand-off:** `GeneratedComplianceConfig.seedClaimTopics(ClaimTopicsRegistry)` is the reusable, owner-invoked "amorçage" primitive the 4.6 `forge script` deploy must call (caller MUST be the registry owner — `addClaimTopic` is `onlyOwner`). The deploy wires registries → seed topics → trust issuer → deploy token/pair, then records addresses in config.
- **Generated config is the single source for deploy params:** `REQUIRE_ALLOWLIST`, `ATOMIC_PAIRED_MINT_BURN`, `SINGLE_LEG_FORBIDDEN`, and `requiredClaimTopics()` are all available to the deploy script from the generated library — do NOT hand-author them in the script.
- **Agent powers (4.6 core):** forced transfer / recovery / freeze / pause + the transfer-agent role separation land in 4.6; the ≥1-topic hardening + eligibility predicate shipped here are unchanged by that work (agent powers gate WHO can move, not WHETHER a holder is eligible).
- **Local-only vector execution:** dual-plane conformance runs entirely in `forge test`'s in-process EVM + Vitest — Sepolia/real-network execution (with secrets) is deliberately deferred to 4.6's deploy step.

---

# Story 4.6 — Provide gated transfer-agent powers and deploy to Sepolia

**Pipeline:** create-story → dev-story → code-review (autonomous). **Final status: `done`. Epic 4 → `done` (last story).**

## Deployment-scope decision honored

There are NO Sepolia secrets in the repo. Per the explicit user decision: ALL code (transfer-agent powers + agent powers + the `forge script` deploy) is implemented and proven to the hilt LOCALLY (forge in-process EVM, no `--broadcast`); the REAL Sepolia broadcast is a separate ops step, DEFERRED until secrets are provided out-of-band. NO `.env` created, NO secret/RPC/key placeholder anywhere.

## What shipped

The ERC-3643 transfer-agent agent powers, gated to the reused `AgentRole` transfer-agent role, on `RoseToken` (and therefore the `CoupledLeg`s and `CoupledPair`): `forcedTransfer`, `recoveryAddress` (lost-key reissue to a new wallet), `setAddressFrozen` / `freezePartialTokens` / `unfreezePartialTokens`, and `pause` / `unpause`. Pause + freeze are enforced on the USER `transfer`/`transferFrom` paths; the agent powers operate beneath them via two transient flags (`_agentBypass` skips ONLY sender-eligibility; `_recovering` additionally relocates the Model-A segregated principal and skips the bright line). `CoupledPair.addLegAgent`/`removeLegAgent` grant/revoke the role on both pair-owned legs. Recovery relocates a holder's FULL balance + segregated principal + freeze state to a verified new wallet (closing the 4.4 "single-leg recovery / stranded-principal" deferral) while preserving the coupling supply invariant; a plain forced transfer keeps the bright line (principal cannot leave). `DeployRoseSuite.s.sol` deploys the suite in the 4.1–4.5-validated order, seeding topics from the GENERATED `GeneratedComplianceConfig` (not hand-written), with refuse-if-absent on all network secrets.

## Files

- `prod/contracts/src/token/RoseToken.sol` (modified) — inherits `AgentRole` + OZ `Pausable`; forced transfer, recovery, address + partial freeze, pause; `_update` agent-bypass on sender-eligibility + burn frozen-clamp; user-path pause/freeze guards (`_requireMovable`).
- `prod/contracts/src/token/CoupledLeg.sol` (modified) — recovery relocates segregated principal (`PrincipalRecovered`); plain forced transfer keeps the Model-A bright line.
- `prod/contracts/src/token/CoupledPair.sol` (modified) — `addLegAgent`/`removeLegAgent` owner forwarders (grant the transfer-agent on both legs).
- `prod/contracts/src/token/interface/IRoseToken.sol`, `interface/ICoupledPair.sol` (modified) — agent-power + leg-agent surfaces (events, views, functions).
- `prod/contracts/script/DeployRoseSuite.s.sol` (new) — ordered deploy; pure `deploy(...)` (locally proven) + `run()` refuse-if-absent broadcast entrypoint.
- `prod/contracts/test/token/AgentPowers.t.sol` (new, 35 tests) — every power's gating (agent + non-agent + fuzz), forced transfer (revoked/frozen-source bypass, recipient enforced, principal protected, auto-thaw), freeze (address + partial + burn clamp), pause (blocks normal, not agent/owner), recovery (full balance + principal + freeze carry + RecoverySuccess + coupling intact + verified target), standalone `RoseToken` path.
- `prod/contracts/test/script/DeployRoseSuite.t.sol` (new, 7 tests) — local deploy proof (seeded topics == generated, trusted issuer, agents granted, ownership handed over, end-to-end eligibility + paired mint) + refuse-if-absent on `run()`.
- `_bmad-output/implementation-artifacts/{sprint-status.yaml,deferred-work.md}`, this report (updated).

## Gates

Vitest **302/302** (unchanged — no TS touched). forge **171/171** (baseline 129 → +42: AgentPowers 35, DeployRoseSuite 7). typecheck / lint / check:regime / check:migrations / format:check all green, `forge fmt --check` clean. The deploy is proven on the in-process EVM; no Sepolia broadcast.

## Notable review decisions

- **3 parallel adversarial layers.** Acceptance Auditor: **PASS on AC-1/AC-2/AC-3/AC-4**. Blind Hunter: verified the `_frozenTokens[a] <= balanceOf(a)` invariant holds in every path (no `_requireMovable` underflow), the transient flags mirror the proven `_pairing` pattern, and pause/freeze sit on the user path while forced/recovery bypass via `_transfer`. Edge-Case Hunter: confirmed Model-A + coupling preservation and flagged dead config.
- **Patched (2 → forge 171):** (1) added a test proving forced transfer bypasses an address freeze on the source holder (AC-3 coverage gap); (2) removed the unused `DeployConfig.country` env read (`deploy()` never used it; holder registration is Epic 5).
- **Dismissed (2):** recovery carrying the freeze flag to the new wallet (deliberate continuity — a frozen/sanctioned holder must not escape via recovery; targets a fresh wallet); idempotent `AddressFrozen` on no-op (harmless, mirrors ERC-3643).
- **Deferred (ops, not code):** the REAL Sepolia broadcast (secrets out-of-band; `run()` refuses until then); single-key `Ownable` + claim-issuer deployer-management-key cleanup (multisig / `Ownable2Step` / key rotation); unbounded-claims OOG (untouched — 4.6 adds no new `isVerified` loop). Recorded in `deferred-work.md`.

## Interface points for Epic 5 (ledger↔chain integration)

- **Deployed addresses** (ClaimTopicsRegistry, TrustedIssuersRegistry, IdentityRegistry, ClaimIssuer, CoupledPair, L/S tokens) are returned by `DeployRoseSuite.deploy(...)` and logged by `run()` — these are the addresses Epic 5's `chain` package (Story 5.1 viem clients/event watchers) will be configured with once the Sepolia broadcast happens.
- **Role model post-deploy:** `finalOwner` owns every contract and is the only caller of `mintPair`/`burnPair` (the Epic-5 mint/burn commit point); the `identityAgent` registers holders on the IdentityRegistry (Story 5.x onboarding); the `transferAgent` holds the agent powers on both legs (forced transfer / recovery / freeze / pause).
- **Recovery & forced transfer** are now available for Epic 5/6 reconciliation + lifecycle operations (e.g., relocating a holder's coupled position to a new wallet) without breaking the coupling supply invariant or the Model-A principal segregation.
- **Mint/burn during pause:** owner `mintPair`/`burnPair` and agent forced ops keep working while the token is paused — so an Epic-5 reconciliation/incident pause does not block the issuer's authoritative supply operations.

---

# BMAD Pipeline — Story 5.1 (Epic 5, single-story run, 2026-06-16)

**Story:** `5-1-connect-to-sepolia-via-typed-viem-clients-and-event-watchers` — Connect to Sepolia via typed viem clients and event watchers.
**Final status:** `done`. Epic 5 moved `backlog → in-progress` (first story created). No git commits made.

## Pipeline executed (create-story → dev-story → code-review)

1. **create-story** — drafted the story file with full architecture/context (chain package location, viem 2.52, chain boundary, NFR-9/D3, refuse-if-absent reference, epic-4 event/ABI sources). `epic-5 → in-progress`, story `→ ready-for-dev`.
2. **dev-story** — implemented `@rose/chain` (see below). `→ review`.
3. **code-review** — 3 parallel adversarial layers; 7 patches applied, 2 deferred, 4 dismissed. `→ done`.

## What shipped — `prod/packages/chain` (`@rose/chain`), all TypeScript

- **Typed viem clients** (`src/viem-clients.ts`): `createRoseChainClients(config, opts?)` → typed `publicClient` on the `sepolia` chain + a `getWalletClient(account)` factory **seam** (no key handling — that is 5.3/5.4). Injectable `transport`/`pollingInterval` for local tests. `readTokenBalance`/`readTotalSupply` return typed `bigint` (NFR-2) via `readContract`.
- **Typed event watchers** (`src/watchers.ts`): `watchPairEvents` (`PairMinted`/`PairBurned`), `watchTokenTransfers` (`Transfer`), `getPastPairEvents` backfill — all emit a stable typed `ChainEvent` envelope (decoded args + `blockNumber`/`transactionHash`/`logIndex`/checksummed `address`). Only mined, non-reorg-removed logs are surfaced. Each watcher returns an idempotent, failure-isolated `Unwatch`.
- **Refuse-if-absent chain config** (`src/chain-config.ts`): `loadChainConfig` (Zod, mirrors `@rose/config`) over `SEPOLIA_RPC_URL` + `ROSE_PAIR_ADDRESS`/`ROSE_L_TOKEN_ADDRESS`/`ROSE_S_TOKEN_ADDRESS`/`ROSE_IDENTITY_REGISTRY_ADDRESS`; `ChainConfigRefusalError` names every offender; rejects non-http(s) URLs and the zero/placeholder address; EIP-55-checksums addresses. NO default, NO placeholder, NO secret.
- **ABIs** (`src/abis/*.ts`): curated `as const` subsets copied verbatim from `prod/contracts/out/{RoseToken,CoupledPair}.sol/*.json` — verified signature-identical by the reviewer.

## Gates (all green; tests LOCAL only — mock EIP-1193 transport, NOT Sepolia)

- **Vitest 330/330** (baseline 302 + 28 new: config 16, clients 4, watchers 8).
- **forge 171/171** unchanged (no Solidity touched).
- `pnpm typecheck` / `lint` / `check:regime` / `check:migrations` / `format:check` — all pass.
- **No secret created; refuse-if-absent in place** — `.env.example` got 4 BLANK chain address keys; the package refuses cleanly with any key absent/invalid.

## Code-review outcome (Blind Hunter + Edge Case Hunter + Acceptance Auditor)

- **Acceptance Auditor:** PASS on AC-1/AC-2/AC-3; scope held (no outbox/mint/burn/group-view/reconcile).
- **7 patches applied:** filter pending/reorg-removed logs (protects 5.2 idempotency keys); checksum the envelope address (5.2 routing); reject the zero/placeholder address; strengthen the EIP-55 test (letter-bearing addresses); deterministic refusal ordering; idempotent + failure-isolated teardown; corrected story test-count prose.
- **2 deferred:** RPC chain-id verification → real-Sepolia ops; `getPastPairEvents` range chunking/finality → reconcile (5.6). Recorded in `deferred-work.md`.
- **4 dismissed** (by-design / mirrors-viem-API / RPC-validated / out-of-scope).

## Interfaces handed to Epic 5 (5.2 → 5.6)

- `ChainEvent` envelope → **5.2** persists into `outbox_events` (tx hash for the journal entry, NFR-3).
- `watchPairEvents`/`watchTokenTransfers`/`getPastPairEvents` → **5.2** outbox ingestion + **5.6** reconcile backfill.
- `createRoseChainClients`/`getWalletClient` → **5.3/5.4** mint/burn write txs (key handling out-of-band, not in this story).
- `readTokenBalance`/`readTotalSupply` → **5.6** ledger↔chain comparison (chain authoritative, D3).
- `loadChainConfig` → addresses for every chain consumer.

## Deferred (ops)

- REAL Sepolia connection (funded RPC + recording `DeployRoseSuite.deploy(...)` addresses into env) — awaits out-of-band secrets; see `deferred-work.md` story-5.1 ops section. The code path is complete and refuse-if-absent; it is simply not exercised against a live endpoint.

---

# BMAD Pipeline Report — Story 5-2 (2026-06-16)

**Story:** `5-2-implement-the-outbox-saga-dual-write-with-the-on-chain-tx-as-commit-point`
**Epic 5 (Ledger↔Chain Integration).** Pipeline: create-story → dev-story → code-review (autonomous, no user checkpoints).

## Final status

**DONE.** Status: backlog → ready-for-dev → in-progress → review → done. No git commit created (per instructions).

## What was delivered (outbox/saga, on-chain tx = commit point — NFR-9/NFR-3)

The outbox + saga dual-write MECHANICS where the on-chain tx confirmation is the commit point:

- **Migration 0007** (`@rose/ledger`, reversible 6→7): `outbox_events` table (lifecycle PENDING/SUBMITTED/CONFIRMED/FAILED/COMPENSATED; DB-enforced idempotency via `UNIQUE idempotency_key` + `UNIQUE tx_hash`; `journal_entry_id` FK; `payload` jsonb; `attempts`/`last_error`) + a nullable `journal_entries.tx_hash` column WITH a `UNIQUE` backstop (one on-chain tx ↔ one journal entry, NFR-3).
- **Outbox repository** (`@rose/ledger`): `recordIntent` (idempotent), `recordSubmission` (transactional row-lock + conditional update), `markConfirmed`/`markFailed`/`markCompensated` (fail-closed `LEGAL_TRANSITIONS`), `findByTxHash`/`findByTxHashForUpdate`/`findByIdempotencyKey`/`listByStatus`, `stampJournalEntryTxHash`.
- **Generic port-driven saga** (`@rose/chain/src/outbox/OutboxSaga`): `recordIntent → submit → confirm[COMMIT POINT] → compensate/resumePending`. The journal entry is posted ONLY at `confirm`, inside one DB transaction with `FOR UPDATE` row-locking + a non-SUBMITTED guard, idempotent on tx hash. `submit`/`LedgerEffect`/`OutboxStore` are ports so 5.3/5.4 plug in concrete `mintPair`/`burnPair` + `postTransfer` journal entries; consumes the 5.1 `ChainEvent` via `confirmFromEvent`.

## Files created / modified

New: `prod/packages/ledger/src/migrations/0007-outbox-events.ts`, `schema/outbox-events.ts`, `repositories/outbox-events.ts`, `outbox-events.test.ts`; `prod/packages/chain/src/outbox/outbox-saga.ts`, `outbox/index.ts`, `outbox/outbox-saga.test.ts`.
Modified: `ledger` `migrations/index.ts`, `schema/journal-entries.ts`, `schema/index.ts`, `index.ts`; `chain` `package.json` (+`@rose/ledger`), `tsconfig.json` (+`../ledger` ref), `src/index.ts`; root `pnpm-lock.yaml`; `deferred-work.md`; `sprint-status.yaml`.

## Gates (all green) — tests are LOCAL, not Sepolia

- **Vitest 356/356** (baseline 330 → +26: 17 ledger repo against LOCAL docker Postgres, 9 chain saga with in-memory fakes + synthetic `ChainEvent`s). NO network, NO RPC, NO key.
- **forge 171/171** unchanged (no Solidity touched).
- **migrations** reversible up→down→up over 7. **typecheck / lint / check:regime / check:migrations / format:check** all green.

## Code review (3 adversarial layers)

Acceptance Auditor: PASS on AC-1/AC-2/AC-3 + scope-held + no-secret + tests-local. Blind + Edge-Case Hunters converged on real concurrency/idempotency risks. **6 patches applied** (FOR UPDATE serialization + non-SUBMITTED guard in `confirm`; `journal_entries.tx_hash` UNIQUE backstop; transactional `recordSubmission` vs the submit race; submit error-preservation; two WARN-log observability gaps). **2 deferred → 5.6** (broadcast-then-throw orphan → reconcile backstop; `attempts` re-arming). **3 dismissed** (payload-float — real NFR-2 boundary is `recordJournalEntry`; `resumePending` signature; File-List labeling).

## Security / network scope

NO secret, NO placeholder RPC/key, NO `.env` created. `@rose/chain` remains the only package importing viem; the new chain→ledger dependency is DB-executor + outbox-repo only (no viem leak into ledger, no import cycle). Real Sepolia broadcast/confirmation + finality-depth tuning recorded as ops-deferred in `deferred-work.md`.

## Interfaces for 5.3 → 5.6

- **5.3 (mint) / 5.4 (burn):** supply the `submit` port (`getWalletClient` + `mintPair`/`burnPair`) and the `LedgerEffect` port (`postTransfer`-governed `recordJournalEntry`); reserved `operation_kind` codes `PAIR_MINT`/`PAIR_BURN`; tx hash stamped on the journal entry at confirm.
- **5.6 (reconcile):** `resumePending()` seam (non-terminal rows) + the deferred broadcast-orphan/`attempts`-rearm cadence; `findByTxHash`, `listByStatus` for divergence scans.
- **NFR-3 surface:** `journal_entries.tx_hash` (+ UNIQUE) and `outbox_events.journal_entry_id` give the auditable on-chain↔ledger link.

---

# Story 5.3 — Mint paired ERC-3643 L/S tokens on Sepolia and record them in the ledger

**Pipeline:** create-story → dev-story → code-review (3 adversarial layers). **Final status: done.** Branch `feat/epic-3-capital-flow-authorization`; NO git commit. NETWORK SCOPE: proven LOCAL only (mock EIP-1193 for the on-chain write, local Postgres + synthetic `PairMintedEvent`s for the dual-write) — NO real Sepolia, NO secret/placeholder/`.env`; real `mintPair` broadcast deferred (deferred-work.md story-5.3 ops).

## What shipped

The concrete paired-mint dual-write, wired onto the 5.2 `OutboxSaga`:

- **`mintPair` write seam** — `submitMintPair(clients, account, params)` (the saga `submit` for `PAIR_MINT`) calls `CoupledPair.mintPair(lTo, sTo, amount)` via the 5.1 `getWalletClient` seam; `encodeMintPairCall` is the network-free calldata seam; the `mintPair` function entry added to the curated `coupledPairAbi` (no Solidity change).
- **Commit-point balanced `LedgerEffect`** — `makeMintPairLedgerEffect(onChainArgs, plan)` posts ONE balanced journal entry linked to the coupled pair (FR-13), capturing the L+S token QUANTITY (taken from the confirmed on-chain `PairMinted` args — D3/NFR-9) + the notional VALUE; cross-checks `lTo`/`sTo`/`amount` vs the recorded intent; guards plan-account overlap.
- **Orchestration** — `MintPairDualWrite`: `start` (authorize PRE-submit, fail-closed → recordIntent PENDING → submit SUBMITTED, idempotent/no double-broadcast) and `confirmFromMintedEvent` (the commit point; never throws into the fire-and-forget watcher — returns a typed `MintConfirmOutcome`).

NO new migration/table (reuses 5.2 `outbox_events` + `journal_entries.tx_hash`); NO new package dependency edge (authorization is an injected `MintAuthorizationGate` port — `@rose/chain` stays off `@rose/authorization`).

## Code review (Blind Hunter + Edge-Case Hunter[live DB] + Acceptance Auditor)

Auditor PASS on AC-1/AC-2/scope/network-scope/P0. **8 patches applied** — headline fixes: (H) authorization moved PRE-submit (refusing after the irreversible on-chain mint would strand tokens with no recordable entry — unrecoverable NFR-9 divergence); (H) `start` short-circuits non-PENDING rows so retry/key-reuse never re-broadcasts a duplicate mint; (M) `confirmFromMintedEvent` catches effect errors → typed outcome, never throws into the watcher; (M) `lTo`/`sTo` recipient cross-check; (M) plan-account distinctness guard; (L) uint256 bound, divergence WARN, tx-hash shape check. **2 boundaries deferred** (multi-`PairMinted`-per-tx → 5.6; cross-leg same-asset → Epic 6).

## Gate (final, all green)

- **Vitest 378** (356 baseline + 22 new: 16 unit network-free + 6 real-Postgres integration; +5 from review patches)
- **forge 171/171** unchanged (no Solidity touched) · **migrations 7** (no new migration, up→down→up reversible)
- `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm format:check` — all green

## Interfaces for 5.4 → 5.6

- **5.4 (burn):** mirror `submitMintPair`/`encodeMintPairCall` with `burnPair`; reuse the `MintLedgerPlan`/`MintAuthorizationGate`/commit-point pattern + `MintConfirmOutcome`.
- **5.6 (reconcile):** `MintQuantityDivergenceError` + the SUBMITTED-row anomalies surfaced by `confirmFromMintedEvent` are the divergence signals; the live `watchPairEvents → confirmFromMintedEvent` cadence/finality-depth is 5.6-owned.

---

# BMAD Pipeline Run — Story 5-4 (burn the coupled token package on redemption)

**Date:** 2026-06-16 · **Story:** `5-4-burn-the-coupled-token-package-on-redemption-with-matching-ledger-entries` · **Final status:** `done`

## Pipeline

create-story → dev-story → code-review, executed autonomously for story 5-4 only. Sprint status transitions: `backlog → ready-for-dev → in-progress → review → done`.

## What was delivered (FR-21, NFR-9 / NFR-3)

Paired-burn dual-write on the Story-5.2 outbox/saga, the burn twin of the Story-5.3 paired-mint pattern: submit `CoupledPair.burnPair(lFrom, sFrom, amount)` (the commit point), and post the matching balanced ledger entry ONLY at the confirmed `PairBurned` event. The ledger quantity direction is the INVERSE of mint — a burn RETIRES supply (holder leg CREDIT, supply contra DEBIT). Authorization is fail-closed PRE-submit; the commit-point effect records the confirmed on-chain quantity unconditionally (D3). Idempotent replay, anti-rebroadcast on retry, never-throw-into-watcher.

## Files created / modified

- NEW `prod/packages/chain/src/pair-shared.ts` — factored direction-agnostic primitives (amount/plan/authorization guards + types) shared by the paired dual-writes.
- NEW `prod/packages/chain/src/burn/burn-pair.ts` — `BurnPairDualWrite`, `submitBurnPair`/`encodeBurnPairCall`, `makeBurnPairLedgerEffect`, `BurnPairIntent`/`BurnLedgerPlan` + burn errors.
- NEW `prod/packages/chain/src/burn/index.ts` — public surface.
- NEW `prod/packages/chain/src/burn/burn-pair.test.ts` — 17 tests (mock EIP-1193 + in-memory fakes; no DB/network).
- NEW `prod/packages/chain/src/burn/burn-pair-ledger.test.ts` — 6 tests (real local Postgres).
- MODIFIED `prod/packages/chain/src/abis/coupled-pair-abi.ts` — added the `burnPair` function entry (signature-identical; `mintPair` + events intact).
- MODIFIED `prod/packages/chain/src/index.ts` — re-export the burn surface (5.1/5.2/5.3 intact).
- MODIFIED `_bmad-output/implementation-artifacts/{deferred-work.md, sprint-status.yaml}` and the 5-4 story file.

## Gates (final)

- `pnpm test`: **401 passed** (378 baseline + 23 burn) — all LOCAL (mock EIP-1193 + local Postgres + synthetic `PairBurnedEvent`).
- `pnpm typecheck` · `pnpm lint` · `pnpm format:check` · `pnpm check:regime` · `pnpm check:migrations` (7, reversible): all green.
- `forge test`: **171 passed**, unchanged (no Solidity touched). No new migration (`PAIR_BURN` already allowed in migration 0007).

## Code review (3 adversarial layers)

Acceptance Auditor: full PASS on AC-1/AC-2/scope/network-scope/NFR-2/ABI-signature/no-migration/no-new-dep. Edge-Case Hunter: confirmed all six 5.3 hardenings reproduced + correct inverted direction + retirement asserted. Blind Hunter: posting direction correct, no float contamination. 1 patch applied (untested `sFrom` divergence branch → added unit test). 6 boundaries deferred with rationale (5.6 reconcile / Epic-6 / consistent-with-5.3). 2 dismissed (false positives). No unresolved High/Med correctness defect.

## Network scope & secrets

NO Sepolia, NO RPC, NO wallet key, NO secret, NO placeholder, NO `.env` in any asserted path. The REAL Sepolia `burnPair` broadcast + finality cadence is an ops-deferred step recorded in `deferred-work.md` (story-5.4 ops section). No git commit was created.

## Impacts / interfaces for 5-5 and 5-6

- 5-5 (group view) and 5-6 (reconcile) consume: `BurnPairDualWrite` (`start`/`confirmFromBurnedEvent`), `makeBurnPairLedgerEffect`/`BurnLedgerPlan`, `BurnQuantityDivergenceError` (the NFR-9 divergence signal), and the `burnPair` ABI entry. A confirmed burn shows supply RETIRED in the ledger, which 5-5's group view renders and 5-6's chain-vs-ledger comparison reconciles.
- `pair-shared.ts` is the new shared home for the paired dual-write primitives (mint retrofit onto it is a deferred clean-up).

---

# BMAD Pipeline Report — Story 5-5 (consolidated group view, text + JSON)

**Date:** 2026-06-16 · **Story:** `5-5-produce-the-consolidated-group-view-text-json` · **Epic 5** · **Final status: done** · **No git commit, no secret created.**

## Pipeline (create-story → dev-story → code-review)

1. **create-story** — drafted the context-rich story (FR-9), `ready-for-dev`. Decision: the group view's architecture home is a NEW `@rose/reconcile` package (`prod/packages/reconcile`, FR-9/FR-10), decoupled from `@rose/chain` via an injected on-chain-supply snapshot (the codebase's injected-port precedent).
2. **dev-story** — implemented test-first; full gate green; `review`.
3. **code-review** — 3 adversarial layers (Blind / Edge-Case / Acceptance Auditor full PASS). 1 Med patch applied + regression test, 2 defers, 2 dismissed; `done`.

## What was built (`@rose/reconcile`, READ-ONLY)

- `buildGroupView(db, opts?)` — SELECT-only assembly: per-entity → per-account-type balances (normal-side signed net), per-entity per-`(asset,scale)` subtotals, consolidated per-`(asset,scale)` group NAV (assets − liabilities) + a double-entry `balanced` flag, coupled-pair positions (V_A/V_B/K integer strings, anchor/leverage/floor decimals, state, noteId).
- `renderGroupViewText` (human text) + `serializeGroupView`/`groupViewToJson` (structured JSON, no bigint) — both derived from the ONE integer source; `MoneyView` = `{ asset, scale, smallestUnits, decimal }`.
- `chain-supply.ts` — injected `ChainSupplySnapshot` / `ChainSupplyReader` / `loadChainSupplySnapshot`; read-only divergence signal (ledger ASSET-side quantity vs on-chain totalSupply; reports `diverged`/`anyDivergence`, never corrects — 5.6 corrects).
- `ACCOUNT_NAV_CLASSIFICATION` — the single documented P0 presentation map.

## Gates (all green, LOCAL — not Sepolia)

- `pnpm test` **415** (baseline 401 + 14 new reconcile tests) · `forge test` **171** unchanged (no Solidity) · `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm check:migrations` **7** reversible (no new migration) · `pnpm format:check`.
- Tests prove: exact integer→decimal (EUR 150050 → "1500.50"), NAV = assets − liabilities, the `(asset,scale)` denomination split, empty-ledger four-entity render, JSON no-bigint round-trip, coupled-pair + note embedding, chain-consistent ⇒ no divergence, deliberate mismatch ⇒ exact delta reported + ledger UNCHANGED (read-only).

## Code-review decision

- **Patch (Med):** subtotals/consolidation/divergence keyed on `asset` only → keyed on the ledger's `(asset, decimal_scale)` balance unit + regression test.
- **Defers:** auto-derive snapshot from leg→account/token-address mapping (Epic-6/5.6); NAV classification = revisable P0 map.
- **Dismissed:** `groupViewToJson` identity (intentional API point); non-deterministic `generatedAt` default (injectable clock).

## Files

New: `prod/packages/reconcile/{package.json,tsconfig.json,src/index.ts,src/group-view.ts,src/group-view-text.ts,src/chain-supply.ts,src/group-view.test.ts,src/divergence.test.ts,src/group-view-text.test.ts,src/index.test.ts}`. Modified: root `tsconfig.json` (references), `pnpm-lock.yaml`, `deferred-work.md`, `sprint-status.yaml`, this story file.

## For 5-6 (reconcile-and-correct, last of epic 5)

`buildGroupView`/`GroupView` is the consolidated read model 5.6 extends; `ChainSupplySnapshot`/`ChainSupplyReader`/`loadChainSupplySnapshot` is the injected on-chain-supply seam 5.6 wires to `@rose/chain` `readTotalSupply`; `DivergenceView`/`ChainComparisonView` is the divergence signal 5.6 turns into a journaled correcting entry (correct-toward-chain, D3/NFR-9); `ACCOUNT_NAV_CLASSIFICATION` is reused. The real Sepolia supply read + leg→account mapping + finality/cadence/reorg remain ops/5.6-deferred (no secret).

---

# BMAD Pipeline Run — Story 5-6 (reconcile ledger↔chain, correct toward the chain) — 2026-06-16

**Scope:** single story `5-6-reconcile-ledger-chain-and-correct-the-ledger-toward-the-chain` — the LAST story of Epic 5. Full cycle: create-story → dev-story → code-review. Autonomous, LOCAL-only (no Sepolia secrets).

## Final status

- **Story 5-6: `done`.** **`epic-5: done`** (all of 5-1…5-6 complete).
- No git commits created. No `.env`, no secret, no placeholder address/RPC.

## What shipped (FR-10 / NFR-9, D3 — chain authoritative)

`@rose/reconcile` extended from the 5.5 READ-ONLY group view to the reconcile-and-CORRECT loop:

- `reconcileLedgerToChain(db, snapshot, plan)` — detects per-token divergence (`onChainTotalSupply − ledgerQuantity`) and CORRECTS the ledger TOWARD the chain via ONE balanced, journaled, auditable double-entry (`recordJournalEntry`; holder ASSET leg vs non-ASSET contra in the same `(asset, scale)`; positive integer amounts; description names the signed divergence; append-only; NOT via `postTransfer`). Idempotent (consistent ⇒ no entry; second run ⇒ no-op). Atomic (one `db.transaction`). Fail-loud (`UnreconciledDivergenceError` strict mode; `InvalidCorrectionAccountsError`).
- Internal-consistency report (AC-1) reusing `buildGroupView` consolidated `balanced` flags.
- Pure finality/cadence helpers (AC-4): `isFinal`, `classifyChainEventFinality`, `shouldReconcileOnEvent` over plain block-coordinate data (no `@rose/chain` edge) + documented default cadence (per-event + on-demand; act at confirmation depth; reorg-below-depth ⇒ reconcile).
- Proven LOCALLY: local Postgres ledger reads + correcting writes; synthetic `ChainSupplySnapshot`s + a simulated `getPastPairEvents`-style backfill→snapshot→correct re-derivation.

## Files

- NEW: `prod/packages/reconcile/src/reconcile.ts`, `finality.ts`, `reconcile.test.ts`, `finality.test.ts`
- MOD: `prod/packages/reconcile/src/index.ts`, `index.test.ts`, `group-view-text.test.ts` (pre-existing flaky regex fix)
- MOD: `_bmad-output/implementation-artifacts/{sprint-status.yaml, deferred-work.md, 5-6-…md}`
- No migration (stays 7), no Solidity (forge stays 171).

## Gates (LOCAL — not Sepolia)

- `pnpm test`: **432 passed** (baseline 415 → +17). `forge test`: **171/171** (unchanged, no Solidity).
- `pnpm typecheck`, `pnpm lint`, `pnpm check:regime`, `pnpm check:migrations` (7, reversible), `pnpm format:check`: all green.

## Code review (3 adversarial layers)

- **1 patch (Med):** finality classifier returned `reorg` for a mined-but-shallow event (would reconcile before finality) — corrected to `pending`; `reorg` reserved for `removed` logs.
- **1 patch (Low, pre-existing):** 5.5 `group-view-text.test.ts` float-artifact regex false-matched UUIDs containing "e-" — strip UUIDs first.
- **2 deferred:** read-before-write-tx TOCTOU (safe via idempotent convergence); duplicate-`(asset,scale)`-in-snapshot dedup (caller-contract / Epic-6). **2 dismissed:** injectable-clock default; identity JSON helper.
- Outcome: **Approve** — the correction stays balanced/auditable and the chain wins (D3); no unresolved High/Med defect.

## Epic-6 interface notes

`reconcileLedgerToChain` (on-demand/per-event entry point), `ReconcilePlan`/`TokenCorrectionAccounts` (caller-supplied snapshot + holder/contra topology to derive from a persisted mapping), `ReconciliationReport`/`renderReconciliationText`/`serializeReconciliationReport` (audit surface for Covenant Console/API), and `isFinal`/`classifyChainEventFinality`/`shouldReconcileOnEvent` (cadence decision to wire to `watchPairEvents`/`getPastPairEvents` + a funded RPC — ops-deferred).

---

# BMAD Pipeline Report — Story 6-1 (Epic 6) — 2026-06-16

**Story:** `6-1-expose-the-typed-rest-api-boundary-fastify-zod-openapi`
**Final status:** **done** · **Epic 6:** `backlog → in-progress`
**Pipeline:** create-story → dev-story → code-review (autonomous, no user checkpoints).

## What was built — new package `@rose/api` (`prod/packages/api`)

The typed REST boundary (Fastify + Zod + OpenAPI), FR-14 foundation, that Stories 6.2→6.6 branch onto.

- `buildApp(deps)` — Fastify factory with `fastify-type-provider-zod` (validator + serializer compilers) and `@fastify/swagger`; the Zod request/response schemas are the SINGLE source from which the OpenAPI 3.1 document is derived. Dependencies (`RoseDb`, optional `ChainSupplySnapshot`, OpenAPI info, logger) are INJECTED — the app opens no DB pool and no socket; exercised in-process via `app.inject`.
- Base READ-ONLY endpoints: `GET /health`, `GET /group-view` (consolidated group view via `@rose/reconcile`; optional injected chain-supply → divergence/`ledger+chain`), `GET /coupled-pairs/:id` (UUID-validated → 200/404), `GET /rose-notes/:id` (→ 200/404), `GET /openapi.json`.
- Structured-error contract `{ error: { code, message, details? } }` via one `mapErrorToResponse` translator + exported `installErrorHandling`: authorization `TransferRefusedError` `DENY`→403 / `REFUSE`→422 (named rule via `reason`), domain→422, invariant/idempotency→409, not-found→404, refuse-if-absent config→503, Zod→400, unknown→500 (generic, non-leaking).
- Money as decimal strings end-to-end (NFR-2): `MoneySchema` strings; coupled-pair K/V_A/V_B as raw smallest-unit integer strings; group view via `groupViewToJson`. No JS number/float, no bigint over the wire.

### Files

- NEW: `prod/packages/api/{package.json,tsconfig.json}`, `src/{index,app,errors,schemas,serializers}.ts`, `src/routes/{health,group-view,coupled-pairs,rose-notes,openapi}.ts`, `src/{errors,serializers,app,index}.test.ts`.
- MODIFIED: root `tsconfig.json` (+api reference), `pnpm-lock.yaml`, `_bmad-output/implementation-artifacts/{deferred-work.md,sprint-status.yaml}`, the story file.

### Dependencies declared (package.json + pnpm-lock.yaml)

`fastify ^5.8.5`, `fastify-type-provider-zod ^5.1.0` (zod>=3.25.67 — workspace zod 3.25.76, imported via `zod/v4`), `@fastify/swagger ^9.7.0`, `openapi-types ^12.1.3`, `zod ^3.25.0`; workspace `@rose/ledger`, `@rose/reconcile`, `@rose/shared`. NO `@rose/chain`/`viem` edge.

## Gates (all green)

- `pnpm test`: **478 passed** (baseline 432 → +46 in `@rose/api`). Tests are LOCAL/in-process: local docker Postgres (5544) for ledger reads + Fastify `app.inject` (no socket) + synthetic in-memory `ChainSupplySnapshot`. **No Sepolia, no network port, no key.**
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:regime`: green.
- `pnpm check:migrations`: **7 reversible** (unchanged — read-only story, no new migration).
- `forge`: **171** unchanged (no Solidity touched).
- DB reset to seeded state after review.

## Code-review notable decisions

- 2 regression tests added: NFR-2 precision survives the FULL Fastify serialize path (a `2^53+1` magnitude served as exact string); the injected `ChainSupplySnapshot` seam over HTTP (`source: ledger+chain` + divergence).
- 2 forward boundaries deferred (deferred-work.md story-6.1): **API-level authn/authz** (out of 6.1 ACs; surfaces 6.5/6.6 + ingress own it; nothing network-exposed in P0); **coupled-pair magnitudes as scale-less integer strings** (the reviewed 5.5 precedent, revisable).
- 1 dismissed: name-keyed registry name-collision (names unique in practice; keeps the boundary decoupled).
- Resolved a story-3.4 deferred concern: config refuse-if-absent faults map to a typed **503**, not an opaque 500.

## No secret created

No `.env`, no `SEPOLIA_RPC_URL`/key/address, no placeholder RPC. The real Sepolia-backed `/group-view` and the real listen-port composition are ops-deferred.

## Interfaces for 6.2 → 6.6

- `buildApp`/`ApiDeps` (inject `RoseDb` + optional `ChainSupplySnapshot`; add write routes later).
- `installErrorHandling`/`mapErrorToResponse`/`ApiError`/`NotFoundError` — the structured-error contract the write paths surface refusals through (registry already covers mint/burn/transfer/lifecycle error classes).
- Zod schemas (`MoneySchema`/`CoupledPairSchema`/`RoseNoteSchema`/`GroupViewSchema`/`ErrorResponseSchema`) — the OpenAPI-typed JSON the React/Vite surfaces consume.
- `serializeCoupledPair`/`serializeRoseNote` — bigint→string / Date→ISO money-safe serializers.

---

# Story 6-2 — Live subscription to a Rose Note end-to-end (testnet/paper)

**Final status:** done. Full BMAD cycle (create-story → dev-story → code-review) completed autonomously.

**Network perimeter (honored, strict):** LOCAL/paper only. NO `.env`, NO secret, NO placeholder, NO real Sepolia. The paired mint is exercised through a mock EIP-1193 transport + injected seam wallet; the `PairMinted` confirmation is a synthetic confirmed event; the eligibility allowlist stands in for the on-chain ONCHAINID claim. Real broadcast + real ONCHAINID read recorded as ops-deferred (deferred-work.md story-6.2).

## What was built

- **NEW `@rose/rose-note`** (`prod/packages/rose-note`) — the architecture-mandated FR-11 composition layer (`api → rose-note → chain → ledger → reconcile`): `makeSubscriptionService` (eligibility FR-19 + default-deny capital-flow authorization, both fail-closed BEFORE any write → 5.3 `MintPairDualWrite` → on-chain commit point posts ONE balanced journal entry incl. `NOTE_LIABILITY`, idempotent NFR-9, no optimistic success); `makeAllowlistEligibilityProvider`/`IneligibleSubscriberError`; `buildSubscriptionMintPlan` (holder=ASSET, supply=non-ASSET, value books `NOTE_LIABILITY`); `makeProviderAuthorizeGate`.
- **`@rose/api` write boundary** — `POST /rose-notes/:id/subscriptions` + `GET /subscriptions/:id` via an injected `SubscriptionService` port (`ApiDeps.subscriptions?`); money as smallest-units STRINGS (NFR-2); OpenAPI derived from new Zod schemas; the structured-error registry extended (eligibility→403, idempotency/lifecycle→409, unsupported-asset/bad-amount→422, service-absent→503; `MintAuthorizationError` DENY→403 effect split). `@rose/api` gains a `@rose/rose-note` edge but NO direct `@rose/chain`/`viem` edge.

## Gates (final)

- **Vitest 519** (baseline 478 → +41: rose-note eligibility/plan/authorize-gate/subscribe e2e + api subscriptions/errors, incl. +8 code-review regression tests). Tests are LOCAL/paper (local docker Postgres + mock EIP-1193 + synthetic `PairMinted`), NOT Sepolia.
- **forge 171/171** unchanged (no Solidity touched). **migrations 7** reversible/unchanged (no new migration — subscription state derived from the outbox row).
- `pnpm typecheck` / `lint` / `format:check` / `check:regime` all green.

## Code-review (3 adversarial lenses)

Acceptance Auditor full PASS on AC-1/AC-2/AC-3 (Review→Confirm UI deferred to 6.5/6.6). 6 real findings FIXED + 8 regression tests: (1) `operationKind === 'PAIR_MINT'` + payload-shape guard (a burn/other key no longer reads as a malformed subscription → 500); (2) reused-idempotency-key-with-different-request → 409 (`SubscriptionIdempotencyConflictError`, no silent stranger-position); (3) `confirm` never throws into the fire-and-forget watcher; (4) `MintAuthorizationError`/`BurnAuthorizationError` DENY→403 / REFUSE→422 effect split (UX-DR5); (5) terminal-failure surfacing (`SubscriptionStatus` widened to `failed`); (6) non-positive amount rejected at the boundary (400). 2 deferred/dismissed with rationale (caller-supplied topology classification = 5.3 trust boundary; `roseNoteId` empty-string unreachable for a real subscription).

## Confirmation

NO secret / `.env` / placeholder created. NO git commit.

## Interfaces for 6.3 → 6.6

- `@rose/rose-note`: `makeSubscriptionService`/`SubscriptionService`/`SubscriptionView`/`SubscribeInput` (6.3 redemption mirrors this against the 5.4 burn dual-write); `EligibilityProvider`/`makeAllowlistEligibilityProvider`; `buildSubscriptionMintPlan`/`SubscriptionAccountTopology`; `makeProviderAuthorizeGate`.
- `@rose/api`: `ApiDeps.subscriptions` injected port; `SubscribeRequestSchema`/`SubscriptionSchema`/`SubscriptionStatusSchema`; the extended error registry (the surfaces 6.5/6.6 consume the OpenAPI-typed JSON and drive the pending → confirmed lifecycle via the Review→Confirm + pending pattern UX-DR6).

---

## Story 6-3 — Live redemption of a Rose Note (FR-11) — DONE

**Cycle:** create-story → dev-story → code-review, autonomous. **Status: done.** Branch `feat/epic-3-capital-flow-authorization`, NO git commits.

**Network perimeter (strict, honoured):** PAPER/LOCAL only — local docker Postgres (5544), Fastify `app.inject`, on-chain paired burn via mock EIP-1193 transport, confirmation via synthetic `PairBurned`. NO Sepolia, NO listen port, NO key, NO `.env`, NO placeholder created. Real `burnPair` broadcast + live `PairBurned` cadence + the on-chain over-redemption revert recorded as ops-deferred (`deferred-work.md` story-6.3).

**What was built (the INVERSE mirror of the 6.2 subscription, against the 5.4 burn):**

- `@rose/rose-note` (existing package, no new dep/edge): `buildRedemptionBurnPlan` (`redemption-plan.ts`) — holder=ASSET / supply=non-ASSET quantity legs + value leg that DEBITs (extinguishes) `NOTE_LIABILITY` and CREDITs cash (the inverse of the subscription value leg); `makeRedemptionService` (`redeem.ts`) — default-deny capital-flow authorization pre-write → 5.4 `BurnPairDualWrite` → at the on-chain commit point ONE balanced journal entry RETIRING the quantity (holder CREDIT / supply DEBIT from the confirmed on-chain amount, D3/NFR-9) + extinguishing `NOTE_LIABILITY`; idempotent, no optimistic success, confirm-never-throws, row-kind guard (`PAIR_BURN`). Reuses `RoseNoteNotFoundError`/`UnsupportedPaymentAssetError`. Deliberate asymmetry: redemption does NOT consult FR-19 eligibility (token-receipt gate, not a burn).
- `@rose/api`: `POST /rose-notes/:id/redemptions` + `GET /redemptions/:id` (`routes/redemptions.ts`) via injected `ApiDeps.redemptions?` port; `RedeemRequestSchema`/`RedemptionSchema`/`RedemptionStatusSchema`/`RedemptionIdParamSchema` (money as integer strings, NFR-2); error registry extended (`RedemptionPairNotActiveError`/`RedemptionIdempotencyConflictError`→409, `InvalidRedemptionAmountError`→422; `BurnAuthorizationError` DENY→403/REFUSE→422 split exercised); service-absent→503.

**Gate (all green, LOCAL/paper — not Sepolia):** Vitest 519→554 (+35), `pnpm typecheck`/`lint`/`format:check`/`check:regime` clean, `pnpm check:migrations` 7 reversible (no new migration), `forge test` 171/171 (no Solidity touched). DB left migrated+seeded.

**Code review:** 3 lenses, full acceptance PASS; 1 finding strengthened with a regression test (divergent confirm ⇒ still-pending, posts nothing); 4 documented design/deferral decisions. No residual High/Med correctness risk. No secret created.

**Interfaces for 6.4→6.6:** `makeRedemptionService`/`RedemptionService`/`RedemptionView`/`RedeemInput`; `buildRedemptionBurnPlan`/`RedemptionAccountTopology`; `@rose/api` `RedeemRequestSchema`/`RedemptionSchema` + `ApiDeps.redemptions` injected port + extended error registry (the surfaces consume the OpenAPI-typed JSON and drive the pending/confirmed → position-closes lifecycle).

---

## Story 6-4 — Execute coupled-pair strategy in paper/testnet mode (FR-20, NFR-7)

**Final status:** done. Pipeline: create-story → dev-story → code-review, all auto-approved on green gates.

**What shipped (paper/local execution, not model validation):** a `StrategyExecutor` port (the NFR-7 seam) in `@rose/rose-note` — `makeStrategyExecutor` (`onTick` / `confirmReset` / `getReset`). `onTick` is the **threshold-only** trigger (floor `f = m·L·g`, `floorUnits = ⌊(K/2)·f⌋`; `m`/`g` from `@rose/config` refuse-if-absent, `L` from the pair row): a within-barrier tick is a strict no-op, **NEVER a clock** (no timer/interval/scheduler/`Date` in the decision path). A floor breach drives the 5.4 paired-burn dual-write (fail-closed authorization pre-write; submit then `ACTIVE→REBALANCING`); at the on-chain commit point `confirmReset` posts ONE balanced journal entry crystallizing the realized P&L tagged to `TRADING_CO` (accrues to the group NAV, AC-1), re-bases the pair (`applyCoupledPairReset`: re-anchor P₀, `V_A=V_B=K/2`, K conserved) and returns it to `ACTIVE`. `@rose/api` `POST /coupled-pairs/:id/strategy/ticks` + `GET /strategy/resets/:id` via an injected `ApiDeps.strategy?` port. The Epic-7 coupled-coin reference math + simulator are NOT reimplemented in `/prod` (marks are opaque tick inputs; `check:regime` green).

**Files:** new `strategy.ts`/`strategy-plan.ts` (+ tests) in `@rose/rose-note`, additive `applyCoupledPairReset` in `@rose/ledger` `coupled-pairs.ts` (+ `coupled-pair-reset.test.ts`), new `routes/strategy.ts` (+ `strategy.test.ts`) + `schemas.ts`/`app.ts`/`errors.ts`/`index.ts` edits in `@rose/api`; `@rose/config` test-only devDep on `@rose/rose-note`.

**Gate (all green, LOCAL/paper — not Sepolia):** Vitest **554 → 594**, `forge` 171/171 (no Solidity), migrations 7 reversible (no new migration), typecheck/lint/format/check:regime clean. Tests use local Postgres + mock EIP-1193 + synthetic `PairBurned` + provided ticks; NO Sepolia, NO key, NO `.env`, NO real price feed.

**Code review:** 3 lenses (Blind / Edge-Case / Acceptance). Full acceptance PASS on AC-1…AC-4; AC-5 PASS with the realized-P&L value postings collapsed into the `TRADING_CO` tag pair (D1a-parked). **3 correctness Highs FIXED** (all "stranded REBALANCING" hazards): validate `tick.price` up-front; submit before the lifecycle transition; widen the `confirmReset` re-base guard to recover on re-delivery — plus a Med (truthful FAILED-row reporting). +3 regression tests. 4 items documented/deferred (settlement/withdrawable split → D1a; both-legs under-count → Epic-7 model; reset-vs-redemption `PAIR_BURN` routing → 6.6; reset-key reuse → caller namespace). No residual High/Med risk. No secret created.

**Interfaces for 6.5/6.6:** `@rose/rose-note` `makeStrategyExecutor`/`StrategyExecutor`/`StrategyTick`/`StrategyTickOutcome`/`StrategyResetView` (6.6 Exchange/Trading consumes the pending/confirmed reset lifecycle + realized P&L by entity); `buildStrategyResetBurnPlan`/`StrategyResetTopology`/`deriveFloorUnits`; `@rose/ledger` `applyCoupledPairReset` (the re-anchored/re-based pair the 6.5 Coupled-Pair surface renders as live `V_A`/`V_B`/`anchor`); `@rose/api` `StrategyTick*Schema`/`StrategyResetSchema` + `ApiDeps.strategy` injected port + extended error registry.

---

## Story 6-5 — Covenant Console & Coupled-Pair surfaces on live data (2026-06-16)

**Pipeline:** create-story → dev-story → code-review (autonomous, single story). **Final status: DONE.**

### Outcome

NEW workspace package **`@rose/web`** (React 18 + Vite + TypeScript + Tailwind v4 + TanStack Query) delivering the design system + shared data-product components + the **Covenant Console** and **Coupled-Pair** operator surfaces on live `@rose/api` data. Frontend-only: the sole backend change is a one-line **additive, type-only** re-export of `GroupViewResponse` from `@rose/api` (runtime-inert; keeps the Zod schema the single contract source and the import fully erased so Fastify never enters the browser bundle).

### Surfaces & components

- Design system: DESIGN.md tokens as semantic CSS vars (rosé `--primary` brand/actions only; `--gain/--loss/--warn/--info` data; `numeric` tabular-mono + `display` roles) mapped into Tailwind v4 (`@theme inline`) so utilities follow a **persisted light/dark toggle**. No raw hex in components.
- Shared (TDD'd, reused by 6.6): `MoneyCell` (decimal-string only, never `number`/float, unit+scale `aria-label`), `DeltaIndicator` (sign+glyph+color), `StatusBadge` (6 lifecycle + live/divergent/pending, label-bearing), `LiveIndicator` (stale-flip + `aria-live`), `DivergenceBanner` (FR-10), `StatCard`, `CopyTxHash`, plus `Button/Card/Table/Skeleton`.
- Covenant Console: live group NAV hero, per-entity balances table, float-yield/exposure derived (BigInt), entity switcher, divergence banner, account drill + copy-tx-hash, loading/empty/error states.
- Coupled-Pair: live `V_A/V_B/K/floor/anchor/leverage`, `V_A+V_B=K` invariant, exact BigInt distance-to-floor (warn near/breached), lifecycle badge, live indicator, states.

### Code review (3 adversarial layers, self-run — no subagent tool in env)

- **1 patch (applied):** `sumNetByType` summed unlike-asset units across a type → restricted to the dominant asset/scale; regression test added.
- **5 deferred (recorded in `deferred-work.md`):** deep drill journal-entry→tx-hash + divergence correcting-entry link need NEW `@rose/api` read endpoints (backend, out of frontend scope); current `P` awaits the 6.4 price-feed seam; WCAG 2.2 AA contrast audit (design-QA); multi-asset KPI breakdown; SR alert-politeness refinement.
- **3 dismissed** as noise (documented floor flooring, intended disabled-query path, unbound default fetch).

### Gates (LOCAL / paper — NO Sepolia, NO secret)

- `pnpm test`: **633 passed** (594 baseline + 39 new web tests; web tests need no Postgres/network).
- `pnpm typecheck` · `pnpm lint` · `pnpm format:check` · `pnpm check:regime` · `pnpm check:migrations` (7 reversible): all green.
- `forge test`: **171 passed** (no Solidity touched). Migrations unchanged.
- Tests are LOCAL component tests (jsdom + testing-library) against typed fixtures shaped by the `@rose/api` contract — no real network, no `.env`, no secret created.

### Interfaces for 6-6 (last epic-6 story)

- Reuse the `@rose/web` design system + every shared component (`MoneyCell`/`DeltaIndicator`/`StatusBadge`/`LiveIndicator`/`DivergenceBanner`/`StatCard`/`CopyTxHash`/`EntitySwitcher`), the typed `ApiClient` + TanStack Query hooks pattern, the `import type` contract-types module, and the jsdom test harness (`src/test/setup.ts` + fixtures).
- 6-6 adds the Exchange/Trading view (paper execution/positions/P&L by entity) + the responsive Subscriber surfaces (subscribe/redeem via Review→Confirm + pending, eligibility gate) — the write/mutation flows 6.5 deliberately did NOT build. The `@rose/api` write endpoints (subscriptions/redemptions/strategy) already exist from 6.2–6.4.

---

## Story 6-6 — Exchange/Trading and Subscriber surfaces on live data (DONE — LAST epic-6 story)

**Pipeline:** create-story → dev-story → code-review, fully autonomous. Status `backlog → ready-for-dev → in-progress → review → done`. **`epic-6: done`** (all of 6-1…6-6 done). Branch `feat/epic-3-capital-flow-authorization`; baseline `NO_VCS`; **no git commit made**.

**Delivered (frontend-only, reusing the 6.5 design system):**

- **Exchange/Trading surface** (operator desktop, `src/surfaces/exchange-trading/`) — derives live paper/testnet execution, positions (`DEPLOYED_CAPITAL`), and realized P&L (`FEE_INCOME`) **by entity** from the group view + the open `coupledPairs[]` legs; `MoneyCell`/`DeltaIndicator`/`LiveIndicator`/`StatusBadge`; explicit loading/empty/error. No mockups.
- **Subscriber surfaces** (responsive `max-w-2xl`, `src/surfaces/subscriber/`) — positions list → Note detail (live position + embedded pair via the **reused `CoupledPairView`**) → subscribe/redeem behind the eligibility gate + the new `ConfirmActionPanel`. **Pessimistic Review→Confirm + pending** (UX-DR6/NFR-9): Confirm fires the mutation, then polls `GET /subscriptions|redemptions/:id` until `confirmed` — **no optimistic success**. Typed refusals (403/422/409/503) name the rule (UX-DR5). Eligibility gate gives an explicit named reason (FR-19, no self-service KYC).
- **Client/hooks:** extended `ApiClient` (`subscribe`/`redeem`/`getSubscription`/`getRedemption`/`getRoseNote` + a `post` helper sharing the typed-error parser); `useSubscribe`/`useRedeem` mutations + `useSubscription`/`useRedemption` poll-while-pending hooks. Amounts cross as smallest-units **integer strings** (NFR-2, no float).
- **`@rose/api`:** ONE additive **TYPE-ONLY** re-export (`SubscriptionResponse`/`RedemptionResponse`/`SubscribeRequest`/`RedeemRequest`) — runtime-inert, mirrors the 6.5 `GroupViewResponse` precedent. No new schema/logic/migration/Solidity.

**Code-review (3 adversarial lenses):** 1 patch applied — Exchange/Trading P&L `DeltaIndicator` double-signed a **negative** net (`▾ −-1250.00`) because the label passed the signed decimal; fixed with a `magnitude()` strip + a `tradingLossGroupView()` regression test. 2 deferred (empty-amount/address → typed 400 in paper/local; WCAG token-hex contrast audit carry-over from 6.5), 3 dismissed as noise.

**Gates (LOCAL, paper — no Sepolia):** `pnpm test` **656 passed** (633 baseline + 23 new web tests; no Postgres/network for the web tests) · `typecheck`/`lint`/`format:check` green · `check:regime` green · `check:migrations` 7 reversible · `forge test` **171 passed**. **Zero new dependencies.** **No `.env`, no secret, no placeholder** created (the subscriber address is an env var with an empty default).

**Epic 6 complete.** Residual ops/backend follow-ups (all recorded in `deferred-work.md`, none blocking): real Subscriber session auth carrying the ONCHAINID eligibility claim; the deployed API base URL + CORS + live polling/websocket cadence; the on-chain commit point that actually flips `pending → confirmed` on **real Sepolia**; a "list my positions" + a per-execution Exchange/Trading read endpoint.
