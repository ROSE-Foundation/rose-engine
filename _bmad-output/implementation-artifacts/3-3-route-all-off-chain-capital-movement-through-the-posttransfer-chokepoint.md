---
baseline_commit: NO_VCS
---

# Story 3.3: Route all off-chain capital movement through the `postTransfer` chokepoint

Status: done

## Story

As an internal operator,
I want every inter-account capital movement to pass through the single `postTransfer` function,
so that there is exactly one writer of transfer postings and it always consults authorization first (FR-7).

## Acceptance Criteria

**AC-1 — Single chokepoint that authorizes before writing**
**Given** the `postTransfer(from, to, amount, context)` function
**When** any inter-account capital movement occurs
**Then** it is the only path that writes transfer postings, and it consults the `AuthorizationProvider` **before** any write
**And** a `DENY` or `REFUSE` decision prevents every mutation — nothing is written to the ledger (fail-closed, NFR-4)
**And** only an `ALLOW` decision records the transfer (the 10 shared conformance vectors define the decisions `postTransfer` must obtain from the provider)

**AC-2 — Chokepoint guard proves no bypass**
**Given** the codebase
**When** the chokepoint guard test runs (static/dependency check + runtime guard)
**Then** it proves no module writes transfer postings outside `postTransfer`

## Tasks / Subtasks

- [x] **Task 1 — Wire `@rose/authorization` to consume `@rose/ledger` (AC: 1)**
  - [x] Add `"@rose/ledger": "workspace:*"` to `prod/packages/authorization/package.json` dependencies (keep `@rose/rule-spec`). `postTransfer` is the off-chain capital-movement chokepoint, so the authorization package legitimately writes through the ledger primitive — this is the architecture's `authorization/src/post-transfer.ts` placement. No new third-party dependency, no DB driver added directly (it is transitive via `@rose/ledger`).
  - [x] Add `{ "path": "../ledger" }` to `prod/packages/authorization/tsconfig.json` `references` (alongside `../rule-spec`) so `tsc -b` builds ledger first. Build order stays acyclic: `shared → rule-spec → ledger → authorization` (ledger never imports authorization).
  - [x] `pnpm install` to relink the workspace.
- [x] **Task 2 — The `postTransfer` chokepoint (AC: 1)** — `prod/packages/authorization/src/post-transfer.ts`
  - [x] Define the endpoint/context contract REUSING rule-spec vocabulary — `import type { AccountTypeCode, Classification, DestinationKind, AssetKind, ConformanceEnv } from '@rose/rule-spec'` and `import type { RoseExecutor } from '@rose/ledger'`. Do NOT redeclare any of these.
    - `TransferSource { readonly accountId: string; readonly accountType: AccountTypeCode; readonly classification: Classification }` — the concrete ledger account being debited of value PLUS the logical authorization facts (its type + Model-A classification).
    - `TransferDestination { readonly accountId: string; readonly destinationKind: DestinationKind }` — the concrete counter-account PLUS its logical authorization kind (`TREASURY|CLIENT_ACCOUNT|EXTERNAL`). The logical `destinationKind` drives authorization; the concrete `accountId` is where the balancing posting lands (an `EXTERNAL` destination is modeled as a real external/clearing account in the ledger — authorization uses the logical kind, the write uses the concrete id).
    - `PostTransferContext { readonly provider: AuthorizationProvider; readonly db: RoseExecutor; readonly assetKind: AssetKind; readonly throughVcc?: boolean; readonly env: ConformanceEnv; readonly description: string; readonly logger?: TransferLogger }`.
    - `TransferLogger { info(event: TransferDecisionLog): void; warn(event: TransferDecisionLog): void }` plus a `TransferDecisionLog` payload (effect, reason, from type+classification, to kind, asset kind, amount as string). Default to a no-op logger. This realizes the structured-logging-at-decision-point requirement (CLAUDE.md §11, NFR-3 auditability) WITHOUT forcing console noise or a logging dependency on a library package; the composition layer (api/rose-note, later) injects a real logger.
    - `TransferReceipt { readonly entry: JournalEntry; readonly postings: PostingView[] }` (re-use `JournalEntryWithPostings` from `@rose/ledger`).
  - [x] `TransferRefusedError extends Error` carrying `{ readonly effect: Exclude<Effect, 'ALLOW'>; readonly reason: string; readonly scenario: TransferScenario }`. Follows the repo typed-error idiom (`UnbalancedEntryError`, `ConfigRefusalError`). Distinguishes `DENY` vs `REFUSE` so a future API boundary can map them (403 vs 422). `name = 'TransferRefusedError'`.
  - [x] `async function postTransfer(from: TransferSource, to: TransferDestination, amount: bigint, context: PostTransferContext): Promise<TransferReceipt>`:
    1. **Validate amount** — `assertNotFloat(amount)` (NFR-2) and `amount > 0n`; throw `InvalidTransferError` (a new local typed error) for a non-positive / non-bigint amount. NO money float ever (NFR-2).
    2. **Build the authorization request** — `scenario = { from: from.accountType, classification: from.classification, to: to.destinationKind, assetKind: context.assetKind, throughVcc: context.throughVcc }` (a rule-spec `TransferScenario`); `request = { scenario, env: context.env }` (the SAME `AuthorizationRequest` shape from Story 3.2).
    3. **Consult authorization FIRST** — `const decision = context.provider.authorize(request)`. This call happens BEFORE any DB statement.
    4. **Log the decision** — `logger.info({...})` on ALLOW, `logger.warn({...})` on DENY/REFUSE (audit trail; observable proof of authorize-before-write).
    5. **Fail-closed** — if `decision.effect !== 'ALLOW'`, throw `TransferRefusedError(decision.effect, decision.reason, scenario)` and write NOTHING. (No try/catch around the provider — it returns a decision, never throws, per the 3.2 contract.)
    6. **Write exactly one balanced transfer entry** — only on `ALLOW`: `recordJournalEntry(context.db, { description: context.description, postings: [ { accountId: from.accountId, direction: 'CREDIT', amount }, { accountId: to.accountId, direction: 'DEBIT', amount } ] })`. Value leaves `from` (CREDIT) and arrives at `to` (DEBIT) of equal amount on the same asset; the ledger's per-(asset,scale) balance + DEFERRABLE double-entry trigger (Story 1.5) is the DB backstop. Return the receipt.
  - [x] Keep it a single small function: no DB schema change, no `flow_permissions`, no `@rose/config` floor resolution (Story 3.4); no on-chain anything (Epic 4).
- [x] **Task 3 — Barrel exports (AC: 1)** — `prod/packages/authorization/src/index.ts`
  - [x] Export `postTransfer`, `TransferRefusedError`, `InvalidTransferError`, and the public types (`TransferSource`, `TransferDestination`, `PostTransferContext`, `TransferLogger`, `TransferDecisionLog`, `TransferReceipt`). Keep all Story-3.2 exports unchanged.
- [x] **Task 4 — Runtime guard + conformance-driven behaviour tests, test-first (AC: 1, 2)** — `prod/packages/authorization/src/post-transfer.test.ts` (DB integration, follows the ledger test pattern: `createPool`/`createDb`, `hardReset`+`migrateUp` in `beforeAll`, `TRUNCATE journal_entries CASCADE` per test, `pool.end()` in `afterAll`).
  - [x] **Authorize-before-write ordering (runtime guard):** a spy provider records the order of `authorize` vs a spy logger / DB observation; assert `authorize` is invoked and that on DENY the DB is never touched. Use a spy `AuthorizationProvider` returning `DENY`; assert `postTransfer` throws `TransferRefusedError` AND `SELECT count(*)` on both `journal_entries` and `postings` is unchanged (ZERO new rows) — fail-closed, nothing written (AC-1).
  - [x] **REFUSE also writes nothing:** a spy provider returning `REFUSE` ⇒ `TransferRefusedError` with `effect === 'REFUSE'`, zero rows written.
  - [x] **ALLOW writes exactly one balanced entry:** a spy provider returning `ALLOW` ⇒ one `journal_entries` row + two balanced `postings` (CREDIT from, DEBIT to), returned in the receipt.
  - [x] **The 10 shared conformance vectors define the decisions (AC-1):** build the real policy-backed provider `makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1))` (Story 3.2/3.1). For EACH of the 10 `conformanceVectors`, map its `scenario`→concrete seeded accounts (one per `AccountTypeCode` + a TREASURY/CLIENT/EXTERNAL counter-account, same asset) and drive `postTransfer` with the vector's `env`; assert: `expected === 'ALLOW'` ⇒ a balanced entry is written; `expected ∈ {DENY, REFUSE}` ⇒ `TransferRefusedError` (matching effect) and NOTHING written. This proves `postTransfer` obtains exactly the conformance decisions from the provider and enforces them fail-closed. Assert the vector set is non-empty (no vacuous pass).
  - [x] **Amount validation:** `amount = 0n` / negative ⇒ `InvalidTransferError`, nothing written, provider NOT consulted (or consulted-but-no-write — pick authorize-after-validate; document). NFR-2: a JS-number amount is a type error / rejected.
  - [x] **Transaction composition:** `postTransfer` run inside an outer `db.transaction(...)` writes within that transaction (re-uses the `RoseExecutor` contract); a thrown `TransferRefusedError` inside the outer transaction rolls the whole thing back (no partial state).
- [x] **Task 5 — Static/dependency chokepoint guard, test-first (AC: 2)** — `prod/packages/authorization/src/chokepoint-guard.test.ts` (pure, no DB)
  - [x] Statically scan all PROD package sources `prod/packages/*/src/**/*.ts` (EXCLUDING `*.test.ts`) for direct writes to the `postings` table (`insert(postings)`, `.insert(postings`, raw `INSERT INTO postings`). Assert the ONLY file performing a direct `postings` insert is the ledger primitive `prod/packages/ledger/src/repositories/journal-entries.ts` (the single low-level writer, Story 1.6). This locks the writer set: a future module cannot introduce a bypass insert without failing this test (regression lock, mirrors `tools/check-regime-boundary.mjs`).
  - [x] Assert `@rose/authorization` never performs a raw `postings` insert — `post-transfer.ts` routes through `recordJournalEntry`, so `postTransfer` is the single transfer-posting writer that always sits behind the authorize call.
  - [x] Assert (lightweight dependency check) that `post-transfer.ts` references `recordJournalEntry` and `provider.authorize`, and that the `authorize` call textually precedes the `recordJournalEntry` call (defense-in-depth source assertion that authorization is consulted before the write).
- [x] **Task 6 — Verification gate (AC: 1, 2)**
  - [x] `pnpm install`; then `pnpm typecheck`, `pnpm lint`, `pnpm test` (prior 212 still green + new), `pnpm format` then `pnpm format:check`, `pnpm check:regime`, `pnpm check:migrations` (still 5 migrations — this story adds NONE), and `(cd prod/contracts && forge test)` all green.

### Review Findings

Adversarial code review (Blind Hunter / Edge Case Hunter / Acceptance Auditor, independent contexts; Edge Hunter probed the live Postgres). Acceptance Auditor verdict: PASS — both ACs met with non-vacuous evidence, scope clean (no Story-3.4 pull-forward, no migration). No High finding survived triage. The Patch findings below were fixed and re-validated; the rest are deferred (documented) or dismissed with reason.

- [x] [Review][Patch] Self-transfer (`from.accountId === to.accountId`) produced a phantom net-zero no-op entry — `postTransfer` now rejects it with `InvalidTransferError` before consulting the provider or the DB. [prod/packages/authorization/src/post-transfer.ts]
- [x] [Review][Patch] ALLOW audit log emitted before the write — the `logger.info` "allowed" record could overstate a transfer that failed to persist; moved to AFTER a successful `recordJournalEntry` (the decision is still computed before the write). [prod/packages/authorization/src/post-transfer.ts]
- [x] [Review][Patch] Static-guard regex was evadable / brittle — broadened `DIRECT_POSTINGS_INSERT` to catch the namespace-qualified `insert(schema.postings)` and quoted-identifier (`INSERT INTO "postings"`) bypass forms, and added comment-stripping so an explanatory comment mentioning the phrase can't false-positive; +1 regression test asserting the evasions are caught and comments ignored. [prod/packages/authorization/src/chokepoint-guard.test.ts]
- [x] [Review][Defer→3.4] Authorization facts (`accountType`, `assetKind`, `classification`, `destinationKind`) are caller-supplied and not bound to the persisted account rows — this is the documented Story-3.3 trust boundary (the IS-NOT section: "does NOT resolve account types/destination/floor from the DB — caller-supplied; resolution is Story 3.4"). Cross-asset `from`/`to` is already fail-safe (the ledger rejects the unbalanced entry; nothing persists). Binding the decision to persisted account state is Story 3.4's DB-backed fact-resolution job. [deferred-work.md]
- [x] [Review][Defer→rule-spec] The authorization scenario carries no `amount`, so per-transaction limits aren't enforceable here — BY DESIGN: the `TransferScenario` vocabulary is frozen in Story 3.1 and models floor-guarded flows abstractly via `ConformanceEnv` (`postBalanceBelowFloor`, computed at runtime in Story 3.4). Adding `amount` would redefine the single-source vocabulary. [deferred-work.md]
- [x] [Review][Dismiss] `throughVcc` undefined-vs-false "fail-open" — NOT a fail-open: the `ROUTE_THROUGH_ENTITY` prohibition matches only `throughVcc === true` (verified in `reference-off-chain-adapter.ts`), so `undefined` and `false` are semantically identical.
- [x] [Review][Dismiss] `catch {}` around `assertNotFloat` "masks errors" — `assertNotFloat` only throws a `TypeError` for the `typeof === 'number'` case by construction, so the remapped `InvalidTransferError` message is accurate; the subsequent `typeof !== 'bigint'` check is intentional belt-and-suspenders.

## Dev Notes

### Scope

- **IS:** the single off-chain capital-movement **chokepoint** — a new `postTransfer(from, to, amount, context)` in `@rose/authorization` that (1) builds a rule-spec `TransferScenario`/`AuthorizationRequest` from its typed inputs, (2) consults the Story-3.2 `AuthorizationProvider` **before any write**, (3) is **fail-closed**: a `DENY`/`REFUSE` throws `TransferRefusedError` and writes nothing, and (4) on `ALLOW` records exactly one balanced transfer journal entry via the Story-1.6 `recordJournalEntry` primitive. Plus the **chokepoint guard** (static writer-set lock + runtime no-write-on-deny) proving no module writes transfer postings outside `postTransfer` (FR-7). REUSE the 3.2 provider and the 3.1 conformance vectors to define the decisions `postTransfer` obtains.
- **IS NOT:** the **production** `OffChainPolicyProvider` reading a DB `flow_permissions` table, that table/migration, populating `flow_permissions` from the codegen, and `@rose/config` floor resolution (all **Story 3.4**); any on-chain `OnChainPolicyProvider` / compliance contract (Epic 4); any change to `@rose/rule-spec` (it is the consumed single source); any change to `@rose/ledger`'s schema (no migration — `check:migrations` stays at 5). It does NOT resolve account types / destination kinds / floor values from the database — those logical authorization facts are passed in by the caller; their runtime resolution is Story 3.4.

### Design decision — `postTransfer` lives in `@rose/authorization` and consumes `@rose/ledger`
[Source: architecture.md project tree `authorization/src/post-transfer.ts  # the single chokepoint`; architecture.md#Architectural Boundaries "Capital-movement boundary: postTransfer is the only writer of transfer postings (FR-7)"; docs/SPEC.md §3.5 lines 75–76]
The architecture explicitly places `post-transfer.ts` inside the `authorization` package, and SPEC §3.5 says "**Toute** mutation de capital passe par une fonction unique `postTransfer` … `postTransfer` consulte un `AuthorizationProvider` **avant** d'écrire." So `@rose/authorization` gains a `workspace:*` dependency on `@rose/ledger` and calls its `recordJournalEntry` primitive. The dependency graph stays acyclic (`shared → rule-spec → ledger → authorization`; ledger never imports authorization). **Considered alternative — a dependency-injected ledger-write port** (keeping authorization a pure leaf): rejected for 3.3 because it makes the "single concrete writer" guarantee more abstract than the AC wants and diverges from the architecture's explicit file placement; the direct dependency keeps the chokepoint concrete and the integration tests follow the established `@rose/ledger` DB-test pattern. `postTransfer` still composes inside a caller transaction via the `RoseExecutor` contract, so the seam for higher-level orchestration is preserved.

### Design decision — reuse the 3.2 provider + 3.1 vectors; the chokepoint adds no rule logic
[Source: 3-2 story (AuthorizationProvider/`authorize`, `makePolicyAuthorizationProvider`); 3-1 story (`conformanceVectors`, `generateOffChainPolicy`, `makeReferenceOffChainAdapter`); CYCLE-BRIEF "réutiliser le provider de 3-2, ne pas le redéfinir"]
`postTransfer` is a CALLER of the substitutable `AuthorizationProvider` — it authors zero rules. It maps its inputs to the rule-spec `TransferScenario` (the SAME shape the 3.2 `AuthorizationRequest` and the 3.1 harness drive, so no field re-mapping) and obeys whatever `Effect` the injected provider returns. The conformance-driven test uses the real `makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1))` so the 10 shared vectors literally define the ALLOW/DENY/REFUSE outcomes `postTransfer` must enforce. Because the provider is substitutable, swapping in the Story-3.4 DB-backed provider (or an Epic-4 on-chain provider) requires zero `postTransfer` changes (NFR-8).

### Design decision — fail-closed: a non-ALLOW throws and writes nothing
[Source: epics.md#Story 3.3 AC; docs/SPEC.md §3.5 "Refus par défaut"; NFR-4 fail-closed; SPEC §5 line 91 "Un transfert de principal de CLIENT_COLLATERAL vers la trésorerie est rejeté par postTransfer (test)"]
The provider returns a decision (it never throws on a DENY/REFUSE — Story 3.2 contract). `postTransfer` translates a non-ALLOW decision into a thrown `TransferRefusedError` **before** issuing any DB statement, so the runtime guarantee is observable: on DENY/REFUSE the `journal_entries`/`postings` tables gain zero rows. ALLOW is the ONLY path to a write. The error carries the `effect` (`DENY` vs `REFUSE`) and `reason` for the audit trail and for a later API mapping (403 vs 422 — architecture.md#API boundary).

### Design decision — the chokepoint guard (static writer-set lock + runtime no-write)
[Source: epics.md#Story 3.3 AC-2 "static/dependency check + runtime guard"; architecture.md#Implementation Patterns "Single chokepoint, no exceptions: no module writes transfer postings except through postTransfer (FR-7). A test proves this (e.g. static/dependency check + runtime guard)"]
Two complementary guards: (1) a **static/dependency scan** of `prod/packages/*/src/**/*.ts` (non-test) asserting the ONLY direct `postings`-table writer is the ledger primitive `journal-entries.ts` and that `@rose/authorization` never does a raw `insert(postings)` — a regression lock so a new module cannot add a bypass (mirrors the precedent `tools/check-regime-boundary.mjs` static guard); and (2) a **runtime guard** proving a DENY/REFUSE through `postTransfer` leaves zero rows written and that `authorize` is consulted before the write. Note: `recordJournalEntry` remains the shared low-level primitive used by both `postTransfer` (transfers) and `issuance` (paired mint/burn, FR-13) — the guard targets *transfer* postings specifically; issuance is a distinct event (bringing a pair live), not an inter-account transfer, and legitimately uses the same primitive.

### Architecture constraints
[Source: architecture.md#Naming Patterns / #Implementation Patterns / #Architectural Boundaries; CYCLE-BRIEF; 3-2 Dev Notes]
- TypeScript 5.9 strict, ESM, NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Files `kebab-case.ts`; types/interfaces `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. `import type` for type-only imports. Internal imports use the `.js` extension; cross-package imports use the bare `@rose/...` specifier. Package tsconfig must NOT exclude `*.test.ts`.
- **Glossary discipline:** the verb is exactly `postTransfer` (architecture.md#Naming "Domain function names use glossary verbs exactly: postTransfer, …"). Re-use `Authorization Provider`, `Model-A bright line`, `flow_permissions` terms verbatim where referenced.
- **Money/NFR-2:** `amount` is a `bigint` in smallest units; `assertNotFloat` + positive-integer guard; never a binary float. Floor presence/breach is carried abstractly via the rule-spec `ConformanceEnv` (the concrete NUMERIC floor math is Story-3.4 runtime).
- **No DB migration** — `check:migrations` stays at 5; this story touches no `@rose/ledger` schema.
- New cross-package wiring: `package.json` (+`@rose/ledger` `workspace:*`) + `tsconfig.json` (+`references: [../ledger]`) + `pnpm install`. Root `tsconfig.json` already references `authorization`.
- **Regime boundary:** `/prod` only; never import `/throwaway`. `pnpm check:regime` must stay green.

### Reusable APIs (consume — do NOT reimplement)
[Source: prod/packages/authorization/src/index.ts; prod/packages/rule-spec/src/index.ts; prod/packages/ledger/src/index.ts]
- From `@rose/authorization` (Story 3.2): `AuthorizationProvider`, `AuthorizationRequest`, `AuthorizationDecision`, `makePolicyAuthorizationProvider`, `makeDefaultDenyProvider`, `denyByDefault`, `DEFAULT_EFFECT`.
- From `@rose/rule-spec` (Story 3.1): `Effect`, `TransferScenario`, `ConformanceEnv`, `AccountTypeCode`, `Classification`, `DestinationKind`, `AssetKind`, `conformanceVectors`, `generateOffChainPolicy`, `ruleSpecV1`.
- From `@rose/ledger` (Story 1.6 / 1.4): `recordJournalEntry`, `JournalEntryWithPostings`, `PostingView`, `JournalEntry`, `RoseExecutor`, `RoseDb`, `createPool`, `createDb`, `hardReset`, `migrateUp`.

### Prior-story learnings (Story 3.1 / 3.2 / Epic 1–2)
- `@rose/authorization` already depends on `@rose/rule-spec` and re-exports `Effect`; the `AuthorizationRequest = { scenario, env }` shape is exactly what `postTransfer` builds — no re-mapping.
- The 3.2 policy-backed provider already inherits the 3.1 fail-closed resolution order; `postTransfer` gets correct ALLOW/DENY/REFUSE for free by consulting it.
- DB integration tests share ONE database, run serially (`vitest.config.ts` `fileParallelism:false`), `hardReset`+`migrateUp` in `beforeAll`, `TRUNCATE … CASCADE` per test, `pool.end()` in `afterAll` (ledger test pattern). The full `pnpm test` needs Postgres up (host port 5544). Baseline is **212 tests, 21 files**.
- Typed-error idiom for refusals (`UnbalancedEntryError`, `ConfigRefusalError`, `AccountPlacementError`) — `TransferRefusedError` follows it.

### Project Structure Notes
- New files under `prod/packages/authorization/`:
  - `src/post-transfer.ts`
  - `src/post-transfer.test.ts` (DB integration)
  - `src/chokepoint-guard.test.ts` (pure static scan)
- Modified: `prod/packages/authorization/package.json` (+`@rose/ledger`), `prod/packages/authorization/tsconfig.json` (+`references: [../ledger]`), `prod/packages/authorization/src/index.ts` (+exports), `pnpm-lock.yaml` (via `pnpm install`).
- Matches architecture's `authorization/src/post-transfer.ts # the single chokepoint`.

### Testing standards
[Source: architecture NFR-6 "test-first on invariants"; CYCLE-BRIEF; 3-2 Testing standards]
Vitest, co-located `*.test.ts`. **Test-first on the two invariants:** (1) fail-closed chokepoint — authorize is consulted before any write and a non-ALLOW writes nothing (proven against the LIVE Postgres by asserting zero new rows), with the 10 shared vectors defining the ALLOW/DENY/REFUSE outcomes; (2) single-writer — a static scan proves no module other than the ledger primitive writes `postings`, and `postTransfer` is the only transfer-posting path. Cover amount validation (NFR-2), transaction rollback composition, and non-vacuity (vector set non-empty).

### References
- [Source: epics.md#Story 3.3] — user story + both AC scenarios (single writer that consults authorization first; static/dependency + runtime guard proving no bypass).
- [Source: epics.md#Epic 3] — single chokepoint (FR-7), default-deny (FR-8), fail-closed (NFR-4), single rule source (FR-19).
- [Source: docs/SPEC.md §3.5 lines 75–76] — every capital mutation passes through one `postTransfer`; it consults an `AuthorizationProvider` before writing; refuse-by-default.
- [Source: docs/SPEC.md §5 line 91] — acceptance: a `CLIENT_COLLATERAL` principal transfer to treasury is rejected by `postTransfer` (test).
- [Source: architecture.md#Architectural Boundaries] — "Capital-movement boundary: postTransfer is the only writer of transfer postings (FR-7). The double-entry trigger is the database-level backstop (FR-3)."
- [Source: architecture.md#Implementation Patterns] — "Single chokepoint, no exceptions … A test proves this (static/dependency check + runtime guard)."
- [Source: implementation-artifacts/3-2-*.md] — the consumed `AuthorizationProvider` + `makePolicyAuthorizationProvider`; "A concrete caller is `postTransfer`, which is Story 3.3."
- [Source: implementation-artifacts/3-1-*.md] — the consumed `conformanceVectors`, `generateOffChainPolicy`, `ruleSpecV1`.
- [Source: prod/packages/ledger/src/repositories/journal-entries.ts] — the `recordJournalEntry` primitive + `RoseExecutor` transaction composition.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Gate: `pnpm typecheck` ✓; `pnpm lint` ✓; `pnpm test` ✓ **234** (+22 in `@rose/authorization`: `post-transfer.test.ts` 18, `chokepoint-guard.test.ts` 4); `pnpm format` then `pnpm format:check` ✓; `pnpm check:regime` ✓; `pnpm check:migrations` ✓ (5, unchanged); `(cd prod/contracts && forge test)` ✓ 3.

### Completion Notes List

- **AC-1 (single chokepoint, authorize-before-write, fail-closed):** new `postTransfer(from, to, amount, context)` in `@rose/authorization` builds a rule-spec `TransferScenario`/`AuthorizationRequest` from typed inputs, consults the Story-3.2 `AuthorizationProvider` BEFORE any DB statement, and is fail-closed — a `DENY`/`REFUSE` throws `TransferRefusedError` (carrying the non-allow `effect` + `reason` + `scenario`) and writes NOTHING; only `ALLOW` records exactly one balanced transfer entry (CREDIT `from`, DEBIT `to`) via the Story-1.6 `recordJournalEntry` primitive. Proven against the LIVE Postgres: on DENY/REFUSE `journal_entries`/`postings` gain ZERO rows; on ALLOW exactly 1 entry + 2 postings. The **10 shared conformance vectors** drive the real `makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1))` provider and define the ALLOW/DENY/REFUSE outcomes the chokepoint enforces.
- **AC-2 (no bypass — static + runtime guard):** `chokepoint-guard.test.ts` statically scans every non-test `prod/packages/**/src/**/*.ts` and asserts the ONLY direct `postings`-table writer is the ledger primitive `journal-entries.ts`, that `@rose/authorization` never does a raw `insert(postings)`, and that `post-transfer.ts` calls `.authorize(` before `recordJournalEntry(` (source ordering). The runtime no-write-on-deny half lives in `post-transfer.test.ts`.
- **Money/NFR-2:** `amount` is a `bigint`; `assertNotFloat` + positive-integer guard reject a JS-number/float or non-positive amount with `InvalidTransferError` BEFORE the provider/DB is touched. Floor presence/breach is carried abstractly via `ConformanceEnv` — no money float in this layer.
- **Transaction composition:** `postTransfer` accepts a `RoseExecutor`, so it writes inside a caller's open transaction; a proven test rolls the outer transaction back and the transfer is discarded (no partial state).
- **Scope:** NO production `OffChainPolicyProvider` / `flow_permissions` table / codegen population / `@rose/config` floor resolution (Story 3.4); NO on-chain anything (Epic 4); NO `@rose/rule-spec` change; **NO DB migration** (`check:migrations` stays at 5). `postTransfer` does not resolve account type / destination kind / floor from the DB — those logical facts are caller-supplied (their runtime resolution is Story 3.4).
- **Wiring:** `@rose/authorization` now depends on `@rose/ledger` + `@rose/shared` (`workspace:*`); build order stays acyclic (`shared → rule-spec → ledger → authorization`).

### File List

New (under `prod/packages/authorization/`):
- `src/post-transfer.ts`
- `src/post-transfer.test.ts` (DB integration — runtime guard + 10-vector behaviour suite)
- `src/chokepoint-guard.test.ts` (pure static/dependency scan)

Modified:
- `prod/packages/authorization/package.json` — `+@rose/ledger`, `+@rose/shared` (`workspace:*`).
- `prod/packages/authorization/tsconfig.json` — `references += ../ledger, ../shared`.
- `prod/packages/authorization/src/index.ts` — export `postTransfer`, error classes, and public types.
- `pnpm-lock.yaml` — relinked via `pnpm install`.

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-06-16 | 0.1 | Story drafted (create-story) — ready-for-dev | Bob (SM) |
| 2026-06-16 | 0.2 | Implemented the `postTransfer` chokepoint (authorize-before-write, fail-closed) + static & runtime chokepoint guards + 10-vector behaviour suite; full gate green (234 tests) — review | Amelia (Dev) |
| 2026-06-16 | 0.3 | Code review: self-transfer guard + ALLOW-log-after-write + hardened/comment-stripped static guard regex; +3 regression tests (237), 2 findings deferred to 3.4/rule-spec, 2 dismissed; gate green — done | Amelia (Dev) |

## Senior Developer Review (AI)

**Reviewer:** Amelia (autonomous adversarial review — Blind Hunter / Edge Case Hunter / Acceptance Auditor, independent contexts; Edge Hunter probed the live Postgres and restored it afterward).
**Date:** 2026-06-16
**Outcome:** Approve (both ACs independently confirmed MET with non-vacuous evidence; scope clean — no Story-3.4 pull-forward, no migration; all actionable findings fixed and regression-tested).

### Acceptance verdict
- **AC-1 (single chokepoint, authorize-before-write, fail-closed)** met — `postTransfer` consults `provider.authorize(...)` before any DB statement and only reaches `recordJournalEntry` past the `decision.effect !== 'ALLOW'` gate; proven against live Postgres (DENY/REFUSE ⇒ zero rows; ALLOW ⇒ 1 entry + 2 balanced postings). The 10 shared `conformanceVectors` drive the real `makePolicyAuthorizationProvider(generateOffChainPolicy(ruleSpecV1))` and define the enforced ALLOW/DENY/REFUSE outcomes (non-vacuity asserted: `length === 10`, mixed effects).
- **AC-2 (no bypass — static + runtime guard)** met — the static scan locks the sole direct `postings` writer to the ledger primitive (regex independently confirmed to match it, so the assertion is not a vacuous empty-set equality), now hardened against namespace-qualified/quoted bypass forms and comment false-positives; the runtime no-write-on-deny half + source-ordering check complete the guard.
- **Scope** clean — only `@rose/authorization` (+`@rose/ledger`,`@rose/shared` workspace deps) and the chokepoint files; no `flow_permissions`/`@rose/config`/DB-backed provider (3.4), no on-chain (Epic 4), no `@rose/rule-spec` change, no migration (stays at 5). Glossary verb `postTransfer` exact; 3.2 provider + 3.1 vectors reused, not redefined; NFR-2 integer-bigint money with float rejected.

### Action Items
- [x] **[Patch] Self-transfer guard** — reject `from === to` before provider/DB. [`post-transfer.ts`]
- [x] **[Patch] ALLOW log after write** — audit "allowed" only on a persisted transfer. [`post-transfer.ts`]
- [x] **[Patch] Hardened static guard** — catch `insert(schema.postings)` / quoted raw SQL; strip comments; +1 regression test. [`chokepoint-guard.test.ts`]
- [x] **[Defer→3.4] Bind authorization facts to persisted accounts** — documented 3.3 trust boundary; cross-asset already fail-safe; DB-backed fact resolution is Story 3.4.
- [x] **[Defer→rule-spec] Amount not in scenario** — `TransferScenario` vocabulary frozen in 3.1; floor-breach carried via `ConformanceEnv` (3.4 runtime).

### Dismissed (with reason)
- **`throughVcc` undefined-vs-false** — not a fail-open; the prohibition matches only `=== true`, so undefined ≡ false.
- **`catch {}` masks errors** — `assertNotFloat` throws only for `typeof === 'number'` by construction; the remapped message is accurate (belt-and-suspenders with the `typeof !== 'bigint'` check).

### Regression tests added (+3, total 237)
- self-transfer rejected (provider not consulted, zero rows); ALLOW audit emitted only after a successful write; hardened-regex catches namespace-qualified/quoted writes and ignores comments.
