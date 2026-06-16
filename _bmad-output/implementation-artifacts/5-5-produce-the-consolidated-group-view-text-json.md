---
baseline_commit: NO_VCS
---

# Story 5.5: Produce the consolidated group view (text + JSON)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an internal operator / steward,
I want a `reconcile` group-view that renders per-entity, per-account-type balances and the consolidated group view (group NAV) as BOTH human-readable text AND structured JSON,
so that I can see group NAV and balances for sign-off, with the chain as the source of truth made explicit (FR-9).

## Acceptance Criteria

1. **Given** a populated ledger, **when** I run the group-view output, **then** it renders per-entity, per-account-type balances PLUS the consolidated group view (group NAV per asset, the four fixed entities, their typed accounts/balances, coupled-pair positions V_A/V_B/K/floor/anchor/leverage/state and the rose-note embedding), as BOTH human-readable text AND structured JSON. Every monetary amount is formatted EXACTLY from the integer smallest-units at the asset's decimal scale (NFR-2) — never a binary float; the JSON carries each amount as both the raw smallest-unit integer string AND the formatted decimal string, so the two views are derived from the one integer source.
2. **Given** a balanced, chain-consistent ledger (ledger token quantities equal the on-chain supplies it is compared against), **when** the group view runs, **then** it reports NO divergence. The group view MAY agg­regate ledger + chain and, when it does, it explicitly labels the source (`ledger-only` vs `ledger+chain`, D3 — chain authoritative). When an on-chain supply is supplied that does NOT match the ledger quantity, the divergence is REPORTED (read-only signal) but NOT corrected — correction is Story 5.6.

### Scope boundary (P0, this story only)

- IN SCOPE: a new PROD package `@rose/reconcile` (the architecture home for FR-9/FR-10, `prod/packages/reconcile`) delivering the READ-ONLY consolidated group view:
  (a) `buildGroupView(db, opts?)` — reads the ledger (entities, typed accounts, postings → per-account net balances; coupled_pairs; rose_notes) and assembles a JSON-serialisable `GroupView`: per-entity → per-account-type balances, per-entity per-asset subtotals, and the CONSOLIDATED per-asset view (assets / liabilities / equity-income / NAV) plus coupled-pair positions and note embedding;
  (b) `renderGroupViewText(view)` — a deterministic human-readable text rendering of the same `GroupView`;
  (c) `groupViewToJson(view)` / `serializeGroupView(view)` — the structured JSON (a plain object with NO `bigint`, every amount as `{ asset, scale, smallestUnits, decimal }`), directly `JSON.stringify`-able;
  (d) the READ-ONLY divergence signal: an OPTIONAL caller-supplied `ChainSupplySnapshot` (per-token on-chain `totalSupply`) the view compares against the ledger's ASSET-side quantity for that asset, reporting `divergence`/`diverged` and `anyDivergence`/source — AC-2's "reports no divergence" when consistent. Proven LOCALLY (real local Postgres for the ledger reads; synthetic in-memory `ChainSupplySnapshot`s for the comparison — NO Sepolia, NO RPC, NO key).
- REUSE — factor, do not duplicate: `@rose/shared` `toDecimalString`/`money`/`assertNotFloat` for EXACT integer→decimal formatting (NFR-2); `@rose/ledger` schema (`entities`, `accounts`, `postings`, `coupledPairs`, `roseNotes`), `RoseDb`, the `numericToBigInt` smallest-units contract (mirror the established private helper — reject a real fractional part). The account routing/placement map (`ENTITY_ALLOWED_ACCOUNT_TYPES`) and the four-fixed-entity / five-fixed-account-type model are REUSED, not re-modelled.
- OUT OF SCOPE (later stories — do NOT implement): the ledger↔chain **reconcile-and-correct** loop + the journaled correcting entry (5.6); finality/confirmation-depth + reorg re-derivation + reconciliation cadence (5.6); the REAL on-chain read of `totalSupply`/`balanceOf` against Sepolia (the `@rose/chain` `readTotalSupply`/`readTokenBalance` seam is wired into the injected `ChainSupplySnapshot` at the Epic-6 composition layer / 5.6 — secrets out-of-band); any mutation of the ledger (the group view is strictly READ-ONLY); the live REST surface / Covenant Console rendering (Epic 6, 6.1/6.5). This story signals a divergence; it never closes it.
- OUT OF SCOPE (ops, deferred): the actual Sepolia supply read that feeds `ChainSupplySnapshot`. The view's chain comparison is a pure function of caller-supplied on-chain quantities; the real read awaits secrets provided out-of-band. Record it in `deferred-work.md` (story-5.5 ops section). **No real secret is ever created. No `.env`. No placeholder address/RPC.**

## Tasks / Subtasks

- [x] Task 1 — Scaffold the `@rose/reconcile` PROD package (AC: 1)
  - [x] `prod/packages/reconcile/package.json` (`@rose/reconcile`, ESM, `workspace:*` deps on `@rose/ledger` + `@rose/shared`; `drizzle-orm` for typed reads, matching `@rose/authorization`'s dep shape), `tsconfig.json` (extends `tsconfig.base.json`, `references` → `../ledger`, `../shared`), and register the package in the root `tsconfig.json` `references`. Run `pnpm install`.
  - [x] `prod/packages/reconcile/src/index.ts` re-exporting the public surface. No new dependency on `@rose/chain` — the on-chain supply is an INJECTED data contract (the codebase's injected-port precedent: `@rose/chain` stays decoupled from `@rose/authorization` via an injected gate; `@rose/reconcile` stays decoupled from `@rose/chain` via the injected `ChainSupplySnapshot`).
- [x] Task 2 — The account NAV classification map (the one documented P0 interpretation) (AC: 1)
  - [x] Define `ACCOUNT_NAV_CLASSIFICATION: Record<AccountType, { normalSide: 'DEBIT'|'CREDIT'; navRole: 'ASSET'|'LIABILITY'|'EQUITY' }>` as ONE reviewable, frozen constant (mirroring `ENTITY_ALLOWED_ACCOUNT_TYPES`): `BACKING_FLOAT`→{DEBIT,ASSET}, `DEPLOYED_CAPITAL`→{DEBIT,ASSET}, `CLIENT_COLLATERAL`→{CREDIT,LIABILITY}, `FEE_INCOME`→{CREDIT,EQUITY}, `NOTE_LIABILITY`→{CREDIT,LIABILITY}. Net balance is reported in the account's NORMAL-side sign (DEBIT-normal ⇒ debit−credit; CREDIT-normal ⇒ credit−debit). NAV per asset = Σ ASSET net − Σ LIABILITY net (the accounting identity ⇒ this equals total EQUITY; report EQUITY separately for transparency). Document this as the single P0 interpretation.
- [x] Task 3 — `buildGroupView` ledger reads + assembly (AC: 1)
  - [x] Read all `entities` (4 fixed), `accounts`, `postings`, `coupledPairs`, `roseNotes`. Aggregate per account in `bigint` (debit/credit totals → normal-side net). Build per-entity → accounts[], per-entity per-asset subtotals, and consolidated per-asset {assets, liabilities, equity, nav, balanced}. `balanced` = (Σ all postings debit − credit per asset === 0) — the double-entry identity surfaced read-only.
  - [x] Coupled-pair positions: V_A=`longLegValue`, V_B=`shortLegValue`, K=`collateralPool` as raw smallest-unit integer strings (no fabricated scale); `anchorPrice`/`leverage`/`floor` as their stored decimal strings; `state`, `referenceAsset`; `noteId` if embedded (join `roseNotes` by `coupledPairId`). NFR-2: smallest-unit magnitudes pass through as integer strings, never floats.
  - [x] Every `MoneyView` = `{ asset, scale, smallestUnits: string, decimal: string }` where `decimal = toDecimalString({ asset, scale, amount })` from the SAME `bigint` (one integer source → both representations). No `number`/`parseFloat` anywhere.
- [x] Task 4 — Text render + JSON serialisation (AC: 1)
  - [x] `renderGroupViewText(view)`: deterministic, stable ordering (entities in the fixed `VCC, HOLDING, TRADING_CO, COIN_ISSUER` order; accounts by type then asset; assets sorted). Sections: header (generatedAt, source), per-entity blocks (account-type rows with formatted decimals), consolidated NAV per asset, coupled-pair positions, and a divergence section (or "no divergence"). Amounts shown as formatted decimals.
  - [x] `groupViewToJson(view)` returns the plain object; assert (test) `JSON.stringify` round-trips with NO `bigint` and NO `NaN`/float.
- [x] Task 5 — Read-only chain divergence signal (AC: 2)
  - [x] `ChainSupplySnapshot` = `{ source: 'ledger+chain'; tokens: ReadonlyArray<{ asset; scale; totalSupply: bigint }> }`; a `ChainSupplyReader` port + `loadChainSupplySnapshot(reader, tokens)` that maps a `(token) => Promise<bigint>` reader over the token list (the seam the Epic-6 composition wires to `@rose/chain` `readTotalSupply`). `buildGroupView(db, { chainSupplies })`: per token, ledger quantity = Σ over ASSET-classified accounts of that asset of (debit−credit); `divergence = totalSupply − ledgerQuantity`; `diverged = divergence !== 0n`; `anyDivergence`; `source` = `ledger+chain` when supplied else `ledger-only`. STRICTLY read-only — reports, never corrects (5.6).
- [x] Task 6 — Tests, test-first on the invariants (AC: 1, 2) — LOCAL only
  - [x] `group-view.test.ts` (real local Postgres, mirrors the `@rose/ledger`-DB harness `createPool`/`createDb`/`hardReset`/`migrateUp`, `TRUNCATE … CASCADE`): per-entity per-account-type balances correct (DEBIT/CREDIT → normal-side net); consolidated NAV = assets − liabilities per asset; `balanced` true on a balanced ledger; coupled-pair position + note embedding surfaced; amounts EXACT from integers (e.g. EUR scale 2: 150050 → "1500.50"); JSON has NO bigint and `JSON.stringify` round-trips; empty ledger renders the four entities with zero balances.
  - [x] `divergence.test.ts`: chain-consistent snapshot ⇒ `anyDivergence === false`, source `ledger+chain` (AC-2); a deliberate mismatch ⇒ `diverged === true`, divergence = exact integer delta, and the ledger is UNCHANGED (read-only — no journal entry, no correction); `ledger-only` when no snapshot.
  - [x] `group-view-text.test.ts`: text contains each entity, the per-account-type rows, the consolidated NAV, and the divergence/no-divergence line; amounts are formatted decimals (no `e`/`NaN`/bare smallest-units in the human view).
  - [x] `index.test.ts`: the public surface re-exports resolve.
  - [x] Baseline to preserve: **Vitest 401** (+ the new reconcile tests), **forge 171** unchanged (no Solidity), **migrations 7** unchanged (NO new migration — the group view is read-only).
- [x] Task 7 — Boundary, docs, gates
  - [x] `@rose/reconcile` imports only `@rose/ledger` + `@rose/shared` (+ `drizzle-orm`); NO `@rose/chain` edge, NO `viem`, NO cycle. `pnpm check:regime` green (no `/throwaway` import).
  - [x] Record the REAL-Sepolia supply read wiring (the `ChainSupplyReader` → `@rose/chain` `readTotalSupply` composition) + the leg→account mapping it will need in `deferred-work.md` (story-5.5 ops section). NO secret, NO placeholder, NO `.env`.
  - [x] Full gate green: `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm check:migrations` (7, reversible) · `pnpm format:check`; `forge test` 171/171 (no Solidity touched). `sprint-status.yaml` + File List + Change Log updated.

## Dev Notes

### Architecture-mandated decisions (follow exactly)

- **The group view is the FR-9 read surface; its home is `prod/packages/reconcile`.** The architecture project structure lists `reconcile/ # FR-9, FR-10 — group view + ledger↔chain correct-toward-chain` and the component table maps "Reconciliation & group view | FR-9, FR-10 | `prod/packages/reconcile`". `reconcile` produces the consolidated group view (per entity, per account type) as text AND JSON (FR-9), verifies per-entity/consolidated consistency AND ledger token quantities vs on-chain balances. 5.5 delivers ONLY the group view + the read-only divergence signal; the correct-toward-chain loop is 5.6. [Source: architecture.md lines 165, 312-318, 356; epics.md Story 5.5 (lines 658-672)]
- **Chain = source of truth (D3) / NFR-9.** When the view aggregates ledger + chain it labels the source and treats the chain as authoritative; AC-2's "reports no divergence" holds when the ledger token quantities equal the on-chain supplies. 5.5 only REPORTS divergence — the journaled correction toward the chain is 5.6 (P0 acceptance criterion there). [Source: architecture.md lines 25, 165-166; epics.md Story 5.5 AC-2 / Story 5.6]
- **Money / NFR-2 — exact integer formatting, never float.** Every amount originates as an integer smallest-unit (`bigint` from `postings.amount`/`coupled_pairs` NUMERIC). Format via `@rose/shared` `toDecimalString({ asset, scale, amount })` at the asset's decimal scale; the JSON carries the raw integer string too so both views derive from one integer. Reject a non-integer NUMERIC fraction on read (the established `numericToBigInt` contract). Never `number`/`parseFloat`/`toFixed`. [Source: architecture.md line 45; CLAUDE.md NFR-2; money.ts `toDecimalString`; journal-entries.ts `numericToBigInt`]
- **The four fixed entities + five fixed account types are the model — do not invent.** Entities `VCC|HOLDING|TRADING_CO|COIN_ISSUER`; account types `BACKING_FLOAT|DEPLOYED_CAPITAL|CLIENT_COLLATERAL|FEE_INCOME|NOTE_LIABILITY`. The group view groups exactly by these. The structural placement (VCC = cash/NAV; exchange/CEX/DEX under TRADING_CO; coin treasury / on-chain liquidity under COIN_ISSUER) is reflected, reusing `ENTITY_ALLOWED_ACCOUNT_TYPES` semantics. [Source: schema/entities.ts; schema/accounts.ts; repositories/accounts.ts `ENTITY_ALLOWED_ACCOUNT_TYPES`; PRD addendum F]
- **Read-only / append-oriented.** The group view performs SELECTs only — no INSERT/UPDATE/migration. The divergence signal records nothing. The audit trail is untouched. No migration ⇒ `pnpm check:migrations` stays green at 7. [Source: architecture.md "append-oriented"; journal-entries.ts header]
- **Decoupling via injected data contract (the codebase precedent).** `@rose/chain` avoided depending on `@rose/authorization` by taking an injected gate port; `@rose/reconcile` likewise takes the on-chain supplies as an injected `ChainSupplySnapshot` rather than importing `@rose/chain`. This keeps the package edge minimal, the view a pure function of (ledger, snapshot), and the whole thing LOCAL-testable with no RPC/secret. The Epic-6/5.6 composition wires the real `@rose/chain` `readTotalSupply` into the `ChainSupplyReader`. [Source: mint-pair.ts `MintAuthorizationGate` injected port; viem-clients.ts `readTotalSupply`/`readTokenBalance`; architecture.md line 206 "reconcile depends on both ledger and chain reads"]
- **Naming.** Files `kebab-case.ts`; types `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. The glossary verb is `reconcile`; the group-view builder is `buildGroupView`. [Source: architecture.md lines 218-222]

### P0 interpretation (documented, not invented scope)

- **Account NAV classification (`normalSide` + `navRole`).** The epics/PRD name "group NAV" but do not enumerate each account type's accounting sign. The single documented interpretation: BACKING_FLOAT/DEPLOYED_CAPITAL are debit-normal ASSETs; NOTE_LIABILITY and CLIENT_COLLATERAL are credit-normal LIABILITIES (collateral held is owed back); FEE_INCOME is credit-normal EQUITY (retained income). NAV per asset = Σ ASSET net − Σ LIABILITY net, which by the double-entry identity equals total EQUITY (reported separately). Kept as ONE frozen reviewable map (like `ENTITY_ALLOWED_ACCOUNT_TYPES`); refine when product specifies. This is a presentation classification only — it changes no ledger data.
- **Ledger token quantity for the divergence check = Σ over ASSET-classified accounts of that token asset of (debit−credit).** Every minted token is held in some holder (ASSET) account (mint DEBITs the holder leg); the supply-contra is the credit-normal counter. So the ASSET-side ledger sum for a token asset equals circulating supply, comparable to on-chain `totalSupply`. The caller declares which assets are tokens by including them in the snapshot — no hard-coded leg→account map (that mapping is the Epic-6 concern the 5.3/5.4 reviews deferred). Read-only; correction is 5.6.

### Reuse — do NOT reinvent

- **`@rose/shared`** — `toDecimalString`, `money`, `fromDecimalString`, `assertNotFloat` (EXACT integer↔decimal, NFR-2). [Source: prod/packages/shared/src/money.ts]
- **`@rose/ledger`** — `RoseDb`/`createDb`/`createPool`/`hardReset`/`migrateUp`; schema `entities`/`accounts`/`postings`/`coupledPairs`/`roseNotes`; `EntityCode`/`AccountType`/`PostingDirection`; the `numericToBigInt` smallest-units read contract (mirror it — reject a real fractional part); `ENTITY_ALLOWED_ACCOUNT_TYPES`. [Source: prod/packages/ledger/src/index.ts; schema/*; repositories/accounts.ts, journal-entries.ts]
- **DB test harness** — `createPool`/`createDb`/`hardReset`/`migrateUp` in `beforeAll`, `pool.end()` in `afterAll`, `TRUNCATE … CASCADE` per test; entities are seeded by migration 0001. Mirror `prod/packages/chain/src/mint/mint-pair-ledger.test.ts`. [Source: mint-pair-ledger.test.ts; vitest.config.ts `fileParallelism:false`]

### Files being created / modified (read before editing — preserve existing behavior)

- NEW `prod/packages/reconcile/**` (package.json, tsconfig.json, src/index.ts, src/group-view.ts, src/group-view-text.ts, src/chain-supply.ts + co-located tests).
- MODIFY root `tsconfig.json` — ADD `{ "path": "prod/packages/reconcile" }` to `references` (append-only; keep the existing six).
- MODIFY `_bmad-output/implementation-artifacts/deferred-work.md` — story-5.5 ops section (real Sepolia supply read + leg→account mapping).
- MODIFY `_bmad-output/implementation-artifacts/sprint-status.yaml` — 5-5 status transitions; bump `last_updated`. Touch NO other story.
- NO change to `@rose/ledger`/`@rose/chain` source, the migrations/schema, `pnpm-workspace.yaml` (the `prod/packages/*` glob already covers the new package), or `prod/contracts` (no Solidity ⇒ forge stays 171).

### Testing standards summary

- **Vitest** (`vitest run`), tests co-located `*.test.ts`; package tsconfig must NOT exclude `*.test.ts` (so `tsc -b` typechecks tests). Test-first on the invariants (NFR-6): exact integer formatting, NAV identity, balanced flag, read-only divergence signal, JSON has no bigint/float.
- **LOCAL only — no Sepolia, no network, no key.** Ledger reads hit the local docker Postgres (5544), serialized via `fileParallelism:false`. The chain comparison uses synthetic in-memory `ChainSupplySnapshot`s. The real supply read is the deferred-ops seam.
- Baseline to preserve: **Vitest 401**, **forge 171**, **migrations 7** (no new migration; no Solidity).

### Project Structure Notes

- `@rose/reconcile` adds one dependency edge (`→ @rose/ledger`, `→ @rose/shared`); no cycle (ledger/shared do not import reconcile). No `@rose/chain`/`viem` edge — on-chain supply is injected. The `prod/packages/*` workspace glob + the lint/regime ignores already cover the new package; only the root `tsconfig.json` `references` needs the new entry for `tsc -b`.
- Regime boundary: PROD only; no `/throwaway` import. `pnpm check:regime` backstops this.

### Anti-patterns to avoid (disaster prevention — carried from 5.1–5.4 reviews)

- Do NOT correct the ledger or post any journal entry — 5.5 is strictly READ-ONLY; divergence is reported, correction is 5.6.
- Do NOT use `number`/`parseFloat`/`toFixed`/binary float for ANY amount — `bigint` smallest-units → `toDecimalString` only (NFR-2). The JSON must contain NO `bigint` (serialise to string) and NO float.
- Do NOT add a migration, a new table, or a `@rose/chain`/`viem` dependency — read-only ledger SELECTs + an injected supply snapshot.
- Do NOT invent entities/account types — the four entities and five account types are fixed; group exactly by them.
- Do NOT fabricate a decimal scale for the coupled-pair smallest-unit magnitudes (V_A/V_B/K) — pass them through as integer strings; format only assets whose scale the account row carries.
- Do NOT create any `.env`/secret/placeholder RPC or address — the chain supply is injected data; the real read is ops-deferred.
- Do NOT break the existing six `tsconfig` references or the 5.1–5.4 public surfaces.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.5 (lines 658-672); FR-9 (line 47), FR-9→Epic 5 (line 163)]
- [Source: _bmad-output/planning-artifacts/architecture.md — lines 25, 45, 165-166, 181, 206, 312-318, 356]
- [Source: prod/packages/shared/src/money.ts — `toDecimalString`/`money`/`assertNotFloat`]
- [Source: prod/packages/ledger/src/schema/{entities,accounts,postings,coupled-pairs,rose-notes}.ts; repositories/accounts.ts `ENTITY_ALLOWED_ACCOUNT_TYPES`; repositories/journal-entries.ts `numericToBigInt`]
- [Source: prod/packages/chain/src/viem-clients.ts — `readTotalSupply`/`readTokenBalance` (the injected reader the Epic-6 composition wires); mint-pair.ts injected-gate precedent]
- [Source: _bmad-output/implementation-artifacts/5-4-...md — the burn mirror + the deferred leg→account mapping the divergence check inherits]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Local Postgres (docker `rose-engine-postgres`, port 5544) was already up; the DB-backed group-view tests reuse the exact `@rose/ledger`-DB harness (`createPool`/`createDb`/`hardReset`/`migrateUp`, `TRUNCATE … CASCADE`). No network, no Sepolia, no key in any path.
- The four entities are seeded by migration 0001, so `buildGroupView` always renders `VCC, HOLDING, TRADING_CO, COIN_ISSUER` even on an empty (truncated) ledger; test accounts are inserted via raw SQL (`mkAccount`) so token-asset accounts can use any type without the routing-rule constraint (the routing rule is a write-time concern, not a read-view concern).
- `pnpm install` picked up the new `@rose/reconcile` workspace package (8 projects). `tsc -b` required the new entry in the root `tsconfig.json` `references` to typecheck/build the package + its tests.

### Completion Notes List

- **AC-1 (per-entity / per-account-type balances + consolidated group view, text AND JSON):** `buildGroupView(db, opts?)` SELECTs entities/accounts/postings/coupled_pairs/rose_notes, aggregates per-account debit/credit in `bigint`, and assembles: per-entity → typed accounts (normal-side signed net), per-entity per-asset subtotals, the consolidated per-asset view (assets / liabilities / equity / NAV + a `balanced` flag = Σ(debit−credit) per asset === 0), and the coupled-pair positions (V_A/V_B/K as raw integer strings, anchor/leverage/floor as stored decimals, `state`, `noteId`). `renderGroupViewText` renders the SAME `GroupView` as a deterministic human report; `serializeGroupView`/`groupViewToJson` give the structured JSON. Every `MoneyView` carries BOTH the raw smallest-unit integer string AND the exact decimal (`toDecimalString`) from the ONE `bigint` source. Tests prove EUR scale-2 `150050 → "1500.50"`, NAV = assets − liabilities, cross-entity consolidation, the empty-ledger four-entity render, and a JSON view with NO bigint that round-trips through `JSON.stringify`.
- **AC-2 (read-only divergence; chain-consistent ⇒ no divergence):** with an injected `ChainSupplySnapshot`, `buildGroupView` computes per-token ledger quantity = Σ over ASSET-classified accounts of that asset of (debit−credit) and reports `divergence = onChainTotalSupply − ledgerQuantity` (chain authoritative, D3), `diverged`, `anyDivergence`, and labels `source: 'ledger+chain'`. A chain-consistent snapshot ⇒ `anyDivergence === false`; a deliberate mismatch ⇒ exact integer delta REPORTED and the ledger UNCHANGED (the test asserts the journal-entry count is identical — no correcting entry, that is 5.6). With no snapshot the view is `ledger-only` and performs no check.
- **STRICTLY READ-ONLY / scope held:** the package performs SELECTs only — no INSERT/UPDATE, no migration, no new table. NO `@rose/chain`/`viem` dependency: the on-chain supply enters as an injected `ChainSupplySnapshot` (the codebase's injected-port decoupling precedent), so the whole feature is LOCAL-testable with no RPC/key. NO reconcile-and-correct, NO finality/cadence/reorg (all 5.6). NO Solidity (forge stays 171). Migrations unchanged at 7.
- **NFR-2 everywhere:** amounts are `bigint` smallest-units → `toDecimalString` only; the JSON contains NO `bigint` (a deep `assertNoBigint` test guards it) and NO float; coupled-pair magnitudes pass through as integer strings (no fabricated scale); `numericToBigInt` rejects a real fractional part on read.
- **TESTS ARE LOCAL — NOT Sepolia.** Ledger reads hit the local docker Postgres (5544, serialized via `fileParallelism:false`); the chain comparison uses synthetic in-memory snapshots. No RPC, no key, no secret, no `.env`. The real supply read is recorded in `deferred-work.md` (story-5.5 ops).
- **P0 interpretation (documented):** `ACCOUNT_NAV_CLASSIFICATION` is the single reviewable map giving each account type its `normalSide` + `navRole`; group NAV = Σ ASSET − Σ LIABILITY (= total EQUITY by the double-entry identity). It is a presentation classification only and changes no ledger data.
- **Interfaces for 5.6:** `buildGroupView`/`GroupView` (the consolidated read model 5.6's reconcile consumes and extends), `ChainSupplySnapshot`/`ChainSupplyReader`/`loadChainSupplySnapshot` (the injected on-chain-supply seam 5.6 wires to `@rose/chain` `readTotalSupply`), the `DivergenceView`/`ChainComparisonView` shapes (the divergence signal 5.6 turns into a journaled correcting entry), and `ACCOUNT_NAV_CLASSIFICATION`.

### File List

**New — `@rose/reconcile`:**

- `prod/packages/reconcile/package.json` (`@rose/reconcile`; deps `@rose/ledger`, `@rose/shared`, `drizzle-orm`)
- `prod/packages/reconcile/tsconfig.json` (references `../ledger`, `../shared`)
- `prod/packages/reconcile/src/index.ts` (public surface)
- `prod/packages/reconcile/src/group-view.ts` (`buildGroupView`, `GroupView` + view types, `ACCOUNT_NAV_CLASSIFICATION`, `ENTITY_DISPLAY_ORDER`, `groupViewToJson`, `serializeGroupView`)
- `prod/packages/reconcile/src/group-view-text.ts` (`renderGroupViewText`)
- `prod/packages/reconcile/src/chain-supply.ts` (`ChainSupplySnapshot`/`ChainTokenSupply`/`ChainTokenDescriptor`/`ChainSupplyReader`, `loadChainSupplySnapshot`)
- `prod/packages/reconcile/src/group-view.test.ts` (DB integration — balances/NAV/coupled-pair/empty/JSON-no-bigint)
- `prod/packages/reconcile/src/divergence.test.ts` (DB integration — read-only divergence signal + reader seam)
- `prod/packages/reconcile/src/group-view-text.test.ts` (DB integration — text rendering)
- `prod/packages/reconcile/src/index.test.ts` (public surface)

**Modified:**

- `tsconfig.json` (root — add `{ "path": "prod/packages/reconcile" }` to `references`)
- `pnpm-lock.yaml` (new workspace package wiring)
- `_bmad-output/implementation-artifacts/deferred-work.md` (story-5.5 ops-deferred section)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5-5 backlog → ready-for-dev → in-progress → review)

## Change Log

| Date       | Version | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Author |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Amelia |
| 2026-06-16 | 0.2     | Implemented the consolidated group view (FR-9) as a new READ-ONLY `@rose/reconcile` package: `buildGroupView` (per-entity/per-account-type balances + consolidated group NAV + coupled-pair positions), `renderGroupViewText` (text) and `serializeGroupView`/`groupViewToJson` (structured JSON, no bigint), and a read-only ledger↔chain divergence signal via an injected `ChainSupplySnapshot` (no `@rose/chain`/`viem` edge). Exact integer→decimal money (NFR-2). Proven LOCALLY (local Postgres + synthetic snapshots — NO Sepolia, NO key, NO secret). Vitest 401→414, forge 171 unchanged, migrations 7 unchanged; full gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers: Blind Hunter, Edge-Case Hunter [live project read], Acceptance Auditor — Auditor full PASS on AC-1/AC-2/scope/read-only/no-migration/no-`@rose/chain`-edge/NFR-2). 1 patch applied (Med): the per-entity subtotals, consolidated view, and divergence keyed on `asset` alone, but the ledger's balance unit is `(asset, decimal_scale)` — keyed all three on the `(asset, scale)` denomination + added a regression test (same EUR label at scale 2 vs 4 stays two distinct balanced rows). 2 boundaries deferred (leg→account/token-address snapshot derivation → Epic-6/5.6; NAV classification = documented P0 presentation map, revisable). 2 dismissed (`groupViewToJson` identity = intentional stable API point; non-deterministic `generatedAt` default = by-design injectable clock). Vitest 414→415 (+1 patch test), forge 171 unchanged, migrations 7 unchanged; full gate green; no unresolved High/Med correctness defect; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] Per-entity subtotals, consolidated view, and divergence keyed on `asset` only, not the ledger's `(asset, decimal_scale)` balance unit — applied: introduced `denomKey(asset, scale)` + `sortByDenom`, keyed all three on `(asset, scale)`, divergence now matches token scale; regression test added [prod/packages/reconcile/src/group-view.ts; group-view.test.ts] (Blind+Edge, Med)
- [x] [Review][Defer] Auto-deriving the `ChainSupplySnapshot` from a persisted leg→token-account / token-address mapping [prod/packages/reconcile/src/chain-supply.ts] — deferred; the asset-keyed caller-supplied snapshot is the in-scope contract; the canonical mapping is the Epic-6/5.6 composition concern already recorded (deferred-work story-5.5 + story-5.3/5.4). (Edge, Low)
- [x] [Review][Defer] `ACCOUNT_NAV_CLASSIFICATION` is a documented P0 presentation interpretation, not a product-ratified accounting policy [prod/packages/reconcile/src/group-view.ts] — deferred; it is one frozen reviewable map that changes no ledger data and is revisable by product (recorded in deferred-work story-5.5). (Auditor, Low)
- [x] [Review][Dismiss] `groupViewToJson` is an identity function — dismissed; intentional stable public API point that documents the view is already JSON-ready (no bigint), parallel to `serializeGroupView`.
- [x] [Review][Dismiss] `generatedAt` defaults to `new Date()` (non-deterministic) — dismissed; by design, with an injected `opts.now` clock for deterministic tests/callers.

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (1 patch applied; 2 boundaries deferred with rationale; 2 dismissed; no unresolved High/Med correctness defect)

Three adversarial layers ran against the Story-5.5 `@rose/reconcile` diff. The **Acceptance Auditor** (diff + story spec + supporting ledger/architecture sources) returned a full PASS on AC-1 (per-entity, per-account-type balances + the consolidated group view rendered as BOTH human-readable text AND structured JSON; coupled-pair positions V_A/V_B/K/floor/anchor/leverage/state + note embedding; every amount formatted EXACTLY from integer smallest-units, the JSON carrying both the raw integer string and the decimal) and AC-2 (a chain-consistent ledger reports no divergence; a deliberate mismatch is REPORTED with the exact integer delta and the ledger left UNCHANGED — read-only, source labelled `ledger+chain`, D3), plus PASS on scope (READ-ONLY group view + divergence signal only; NO reconcile-and-correct, NO finality/cadence — all 5.6), no new migration (read-only; migrations stay 7), no `@rose/chain`/`viem` dependency edge (on-chain supply is an injected `ChainSupplySnapshot`, mirroring the codebase's injected-port decoupling), and NFR-2 integer-only money with a JSON view that carries no bigint and no float (a deep `assertNoBigint` test guards it). The **Edge-Case Hunter** (diff + project read) and the **Blind Hunter** (diff only) jointly surfaced one real correctness issue: the per-entity subtotals, the consolidated view, and the divergence ledger-quantity all grouped/keyed by `asset` alone, whereas the ledger's balance unit — enforced by the Story-1.5 double-entry trigger — is the `(asset, decimal_scale)` pair; a same-label asset at two scales would have produced a meaningless cross-scale smallest-unit sum and a misleading `balanced` flag. The single patch closed it: a `denomKey(asset, scale)` + `sortByDenom` now key all three aggregations on the `(asset, scale)` denomination, the divergence matches the token's scale, and a regression test asserts EUR@2 and EUR@4 stay two distinct balanced rows. Two boundaries were deferred with rationale: auto-deriving the snapshot from a persisted leg→token-account / token-address mapping (the Epic-6/5.6 composition concern already recorded from 5.3/5.4), and the `ACCOUNT_NAV_CLASSIFICATION` P0 presentation map (one frozen reviewable constant that changes no ledger data, revisable by product). Two findings were dismissed: `groupViewToJson` as an identity function (an intentional, stable JSON-ready API point) and the non-deterministic `generatedAt` default (by design, with an injected clock). After the patch: Vitest 414 → 415 (+1), forge 171/171 unchanged, migrations 7 (no new migration), and `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` all green. No residual High/Med correctness risk. TESTS REMAIN LOCAL — local Postgres for the ledger reads, synthetic in-memory `ChainSupplySnapshot`s for the comparison; no real Sepolia, no secret/placeholder, the real supply read deferred (deferred-work.md story-5.5 ops).
