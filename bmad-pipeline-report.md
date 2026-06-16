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
