---
baseline_commit: 4369bfced4c172917b0c5f19f4c24a79d11ac349
---

# Story 5.2: Implement the outbox/saga dual-write with the on-chain tx as commit point

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an internal operator,
I want dual writes to use an outbox/saga with the on-chain transaction as the commit point,
so that ledger and chain stay consistent with idempotency and compensation on failure (NFR-9, NFR-3).

## Acceptance Criteria

1. **Given** a dual-write operation, **when** it executes, **then** the off-chain intent is recorded first (outbox row, status `PENDING`) → the on-chain tx is submitted (status `SUBMITTED`, tx hash recorded) → and the matching balanced journal entry (value + token quantity) is posted **only after the on-chain tx is confirmed** (status `CONFIRMED`), via a caller-supplied `postTransfer`-governed ledger effect. The on-chain confirmation is the **commit point**: no journal entry is ever posted at intent or at submission time (NFR-3, dual-write ordering).
2. **Given** a retried or partially-failed dual write, **when** the saga runs, **then** every step carries an idempotency key so retries are safe (the same intent is recorded at most once; the same confirmed tx applies its ledger effect at most once — replay/reorg-redelivery safe), and a failed/reverted tx is moved to `FAILED` and **compensated** (no ledger effect applied) or left for reconciliation; the on-chain tx hash is recorded on the related journal entry (NFR-3).
3. **Given** outbox rows left in a non-terminal state (`PENDING`/`SUBMITTED`) by a crash or restart, **when** recovery runs, **then** they can be re-driven deterministically from their persisted state (a `confirm` for an already-`CONFIRMED` row is a no-op; a `SUBMITTED` row whose tx is later observed confirmed advances to `CONFIRMED`), giving the reconcile story (5.6) a safe resume seam. No incoherent intermediate state is ever observable as committed.

### Scope boundary (P0, this story only)

- IN SCOPE: the `outbox_events` table + reversible migration (0006 → 0007); a nullable `tx_hash` column on `journal_entries` (NFR-3, append-only); a typed outbox **repository** in `@rose/ledger` with **DB-level idempotency** (unique idempotency key, unique tx hash) and explicit status transitions; a generic, port-driven **saga orchestrator** in `@rose/chain/src/outbox/` that sequences intent → submit → confirm(commit point) → compensate/resume, parameterized by a `LedgerEffect` port (where `postTransfer` plugs in at 5.3/5.4) and consuming the 5.1 `ChainEvent` confirmation signal. All proven **LOCALLY** (real local Postgres for the repo, in-memory fakes + synthetic `ChainEvent`s for the saga — NOT against real Sepolia, no wallet key).
- OUT OF SCOPE (later stories — do NOT implement): the concrete paired mint orchestration + its journal entry (5.3), the package burn + its journal entry (5.4), the consolidated group view (5.5), the full ledger↔chain reconcile-and-correct loop (5.6). This story delivers the **outbox mechanics + consistency invariants** those stories wire into; 5.3/5.4 supply the concrete `submit` (via `getWalletClient` + `mintPair`/`burnPair`) and `LedgerEffect` (via `postTransfer`-governed journal entries), and 5.6 owns the cadence/finality-depth recovery policy that calls the resume seam.
- OUT OF SCOPE (ops, deferred): real Sepolia broadcast/confirmation wiring (no `SEPOLIA_RPC_URL`, no signing key, no confirmation-depth tuning against a live chain). Record it in `deferred-work.md` (story-5.2 ops section). No real secret is ever created.

## Tasks / Subtasks

- [x] Task 1 — Persist the outbox: migration 0007 + schema (AC: 1, 2, 3)
  - [x] Add `prod/packages/ledger/src/migrations/0007-outbox-events.ts` (`Migration` with `up`/`down`, mirroring the raw-SQL style of `0006-flow-permissions.ts`). Table `outbox_events`: `id uuid PK DEFAULT gen_random_uuid()`, `idempotency_key text NOT NULL UNIQUE`, `operation_kind text NOT NULL` with `CHECK (operation_kind IN ('PAIR_MINT','PAIR_BURN'))`, `status text NOT NULL DEFAULT 'PENDING'` with `CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED','COMPENSATED'))`, `payload jsonb NOT NULL`, `tx_hash text` (nullable until submitted), `journal_entry_id uuid REFERENCES journal_entries(id)` (nullable until confirmed), `last_error text`, `attempts integer NOT NULL DEFAULT 0`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`. Add `CONSTRAINT outbox_events_tx_hash_key UNIQUE (tx_hash)` (Postgres treats multiple NULLs as distinct, so it is effectively a partial-unique on submitted rows — idempotency on tx hash). Add `idx_outbox_events_status ON outbox_events (status)` (recovery scans).
  - [x] In the SAME migration `up`, `ALTER TABLE journal_entries ADD COLUMN tx_hash text` (nullable; NFR-3 — the on-chain tx hash recorded on the related journal entry). `down` reverses both (`DROP TABLE IF EXISTS outbox_events;` then `ALTER TABLE journal_entries DROP COLUMN IF EXISTS tx_hash;`). Exact inverse, `IF EXISTS`-safe.
  - [x] Register `migration0007` in `prod/packages/ledger/src/migrations/index.ts` (append only — never reorder/edit merged ones).
  - [x] Add drizzle schema `prod/packages/ledger/src/schema/outbox-events.ts` (`outboxEvents` pgTable mirroring the migration; export inferred types + the status/kind union string-literal types). Add `txHash: text('tx_hash')` to `prod/packages/ledger/src/schema/journal-entries.ts`. Re-export from `schema/index.ts`.
- [x] Task 2 — Outbox repository with DB-level idempotency + status transitions (AC: 1, 2, 3)
  - [x] Add `prod/packages/ledger/src/repositories/outbox-events.ts`. Functions (all take `RoseExecutor` so they compose inside one `db.transaction`): `recordIntent({ idempotencyKey, operationKind, payload })` → inserts `PENDING`, idempotent (on conflict on `idempotency_key`, return the existing row — never a duplicate intent); `recordSubmission({ idempotencyKey | id, txHash })` → `PENDING → SUBMITTED`, sets `tx_hash` (rejects illegal source state); `findByIdempotencyKey`, `findByTxHash`; `markFailed({ id, error })` → `→ FAILED`, increments `attempts`, sets `last_error`; `markCompensated({ id })` → `FAILED → COMPENSATED`; `listByStatus(status)` for recovery scans. Add `stampJournalEntryTxHash(executor, { journalEntryId, txHash })` updating `journal_entries.tx_hash` (NFR-3 surface used at confirmation).
  - [x] Export the repo from `prod/packages/ledger/src/index.ts`.
  - [x] Structured logs at each transition (CLAUDE.md §11): include `idempotencyKey`, `operationKind`, `status` change, `txHash`, `journalEntryId` where known — the "outbox commit" decision point named in architecture.md §Monitoring/logging.
- [x] Task 3 — Generic, port-driven saga orchestrator in `@rose/chain` (AC: 1, 2, 3)
  - [x] Add `@rose/ledger` to `prod/packages/chain/package.json` `dependencies` (`workspace:*`) and add `{ "path": "../ledger" }` to `prod/packages/chain/tsconfig.json` `references` (mirror `@rose/authorization`'s cross-package wiring). Run `pnpm install`.
  - [x] Add `prod/packages/chain/src/outbox/outbox-saga.ts`. Define the ports: `OutboxStore` (the subset of repo ops the saga needs, so the saga is unit-testable with an in-memory fake) and `LedgerEffect = (executor, ctx: { outboxId; operationKind; payload; txHash }) => Promise<{ journalEntryId: string }>` (5.3/5.4 implement this via `postTransfer`-governed `recordJournalEntry`). Implement: `submitAndRecord` (records the tx hash the caller's `submit` returned: `PENDING → SUBMITTED`), and `confirm({ txHash }, ledgerEffect, db)` — the **commit point**: in ONE `db.transaction`, look up the row by tx hash; if already `CONFIRMED`, **return without re-applying** (idempotent replay/reorg-redelivery guard); else apply `ledgerEffect`, `stampJournalEntryTxHash`, set `journal_entry_id`, and move `SUBMITTED → CONFIRMED`. Add `compensate(...)` (`FAILED → COMPENSATED`, never posts a ledger effect) and `resumePending(db, { onConfirmed })` (lists `PENDING`/`SUBMITTED` rows for the reconcile story to re-drive — seam only).
  - [x] Add `prod/packages/chain/src/outbox/index.ts` and re-export the outbox surface from `prod/packages/chain/src/index.ts`. Document that `confirm` is intended to be driven by the 5.1 `watchPairEvents` `ChainEvent` (match `event.transactionHash` → `confirm`).
- [x] Task 4 — Tests, test-first on the consistency invariants (AC: 1, 2, 3) — LOCAL only
  - [x] `prod/packages/ledger/src/outbox-events.test.ts` (real local Postgres, `hardReset` + `migrateUp` like `rose-notes.test.ts`): migration 0007 applies and is reversible (covered by `check:migrations` too); `recordIntent` is idempotent on `idempotencyKey` (second call returns the same row, count stays 1); duplicate `tx_hash` is rejected by the unique constraint; legal transitions succeed and illegal ones are rejected; `stampJournalEntryTxHash` writes the hash onto a real journal entry; `journal_entries.tx_hash` defaults NULL on existing insert paths (no regression to 5.1/earlier entries).
  - [x] `prod/packages/chain/src/outbox/outbox-saga.test.ts` (in-memory fake `OutboxStore` + fake `LedgerEffect` + synthetic `ChainEvent`s — NO Postgres, NO network): **commit-point ordering** — the `LedgerEffect` is NEVER invoked before `confirm`, and IS invoked exactly once on `confirm` (assert call order/counters); **idempotent replay** — delivering the same confirmed tx hash twice applies the effect once (second `confirm` is a no-op); **compensation** — a `FAILED` row never triggers a `LedgerEffect`; **resume** — `resumePending` surfaces non-terminal rows. Drive `confirm` from a synthetic `PairMintedEvent`/`PairBurnedEvent` to prove the 5.1 `ChainEvent` wiring.
  - [x] Preserve the baseline: Vitest 330 (this story adds tests on top), forge 171 unchanged (no Solidity touched). Migrations 6 → 7.
- [x] Task 5 — Boundary, docs, gates
  - [x] `@rose/chain` remains the only PROD package importing `viem`/opening an RPC; the new chain→ledger dependency is for the DB executor + outbox repo only (no other package gains a viem import). `pnpm check:regime` green (no `/throwaway` import).
  - [x] Record the real-Sepolia confirmation/broadcast wiring + confirmation-depth tuning in `deferred-work.md` (story-5.2 ops section), joining the 5.1 ops-deferred items.
  - [x] Full gate green: `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm check:migrations` · `pnpm format:check`. `forge test` stays 171 (run to confirm no accidental Solidity change). Update `sprint-status.yaml` and this story's File List + Change Log.

## Dev Notes

### Architecture-mandated decisions (follow exactly)

- **Dual-write ordering (NFR-9 / NFR-3) — THE central invariant:** intent → on-chain tx (**commit point**) → on confirmation, post the balanced journal entry. Every dual-write step carries an **idempotency key**; retries are safe; failures compensate or are reconciled. The journal entry MUST NOT be posted before on-chain confirmation. [Source: architecture.md lines 164, 243-244, 261]
- **Outbox location & shape:** the outbox/saga + idempotency + compensation live under `chain/src/outbox/`; the persisted projection is the `outbox_events` table; "the outbox sits between Rose Note orchestration and the chain." The DB itself (migrations, schema, repositories) is owned by `@rose/ledger` — every table in this project has its migration + drizzle schema + repository there (entities, accounts, journal_entries, postings, coupled_pairs, flow_permissions). Therefore: the `outbox_events` **table/migration/schema/repository go in `@rose/ledger`**, and the **saga orchestration** (which also needs the chain confirmation signal) goes in `@rose/chain/src/outbox/`, depending on `@rose/ledger`. This mirrors how `@rose/authorization` depends on `@rose/ledger`. [Source: architecture.md lines 206, 218, 315, 342; existing `prod/packages/ledger/src/{migrations,schema,repositories}`; `prod/packages/authorization/package.json`]
- **Chain events → outbox:** "ingested via viem watchers into `outbox_events`/reconcile; on-chain tx hash recorded on the related journal entry (NFR-3)." 5.1 delivered the typed `ChainEvent` envelope (carrying `transactionHash`, filtered to confirmed/non-removed logs, EIP-55 address). 5.2 consumes that envelope's `transactionHash` to drive `confirm`. [Source: architecture.md line 244; story 5-1 Completion Notes "Interfaces for 5.2 → 5.6"]
- **Chain boundary (hard rule):** the `chain` package is the only module talking to Sepolia (viem). The new chain→ledger dependency does NOT add a viem import elsewhere; it lets the saga persist/read the outbox + post the ledger effect via the ledger executor. [Source: architecture.md line 342]
- **Money / NFR-2:** all token quantities + values are integers (`bigint` in TS, `NUMERIC`/`uint256`-derived). `payload` jsonb stores amounts as decimal strings (never JS floats); the ledger effect converts to `bigint` for `recordJournalEntry`. Never coerce to `number`/float. [Source: architecture.md line 45; CLAUDE.md NFR-2; `repositories/journal-entries.ts` `numericToBigInt`]
- **Migrations append-only + reversible (NFR-5):** add `0007`; never edit/reorder `0001`–`0006`. `up`/`down` are exact inverses, `IF EXISTS`-safe. `pnpm check:migrations` (`migrate-cli verify`: up→down→up) must stay green at 7 migrations. [Source: `prod/packages/ledger/src/migrate.ts`, `migrate-cli.ts`; CLAUDE.md]
- **Naming:** files `kebab-case.ts`; tables/columns `snake_case`, tables plural, FK `<singular>_id`, enums = uppercase glossary codes, indexes `idx_<table>_<cols>`; types/classes `PascalCase`; functions/vars `camelCase`. The glossary verbs `mintPair`/`burnPair` belong to 5.3/5.4 — do NOT implement them here; the outbox `operation_kind` codes `PAIR_MINT`/`PAIR_BURN` only *name* the dual-writes the outbox will carry. [Source: architecture.md lines 218, 222]
- **Local dev:** real local Postgres (docker-compose, host port 5544) for the repo tests exactly as the existing ledger tests; the saga unit tests use in-memory fakes + synthetic `ChainEvent`s. Per the network-scope decision for THIS run there are NO Sepolia secrets — the real broadcast/confirmation path stays code-complete but unexercised. [Source: architecture.md line 185; story 5-1 network-scope precedent]

### State machine (the outbox lifecycle)

```
recordIntent          submitAndRecord          confirm (COMMIT POINT)
   │                       │                         │
   ▼                       ▼                         ▼
 PENDING ───────────► SUBMITTED ──────────────► CONFIRMED   (ledger effect posted here, ONCE)
   │                       │
   │ (tx fails/reverts)    │ (tx fails/reverts)
   ▼                       ▼
 FAILED ───── compensate ──────► COMPENSATED            (NO ledger effect ever posted)
```

- The **only** transition that posts a journal entry is `SUBMITTED → CONFIRMED`, and it does so inside one DB transaction together with `stampJournalEntryTxHash` and setting `journal_entry_id`. Atomic: either the row is `CONFIRMED` with its journal entry + tx hash, or nothing changed. This is what makes the on-chain tx the commit point with no incoherent intermediate committed state (NFR-3).
- **Idempotency keys** (two layers, both DB-enforced): `idempotency_key UNIQUE` makes `recordIntent` exactly-once for a logical operation; `tx_hash UNIQUE` + the "already `CONFIRMED` ⇒ no-op" guard in `confirm` make the ledger effect exactly-once per tx even if the watcher re-delivers or a reorg re-scans (5.1 already filters pending/removed logs, but 5.2 must not rely on at-most-once delivery).
- `attempts`/`last_error` support retry/observability; `resumePending` is the seam 5.6 calls on its reconcile cadence to re-drive non-terminal rows. 5.2 provides the seam, NOT the cadence/finality-depth policy.

### Reuse — do NOT reinvent (extend these existing pieces)

- `recordJournalEntry(executor, input)` + `RoseExecutor`/`RoseTransaction` (compose the ledger effect inside the saga's confirm transaction) — `prod/packages/ledger/src/repositories/journal-entries.ts`, `db.ts`. The `LedgerEffect` port receives the executor so 5.3/5.4 call `recordJournalEntry` (governed by `postTransfer`) atomically with the status flip.
- The migration `Migration {version, up, down}` + `MIGRATIONS` array + `migrate-cli verify` — `prod/packages/ledger/src/migrate.ts`, `migrations/index.ts`. Copy the `0006-flow-permissions.ts` raw-SQL style.
- The DB test harness pattern (`createPool`/`createDb`/`hardReset`/`migrateUp`, `TRUNCATE … CASCADE` in `beforeEach`) — `prod/packages/ledger/src/rose-notes.test.ts`.
- The 5.1 `ChainEvent`/`PairMintedEvent`/`PairBurnedEvent` envelope + `watchPairEvents` — `prod/packages/chain/src/watchers.ts`. `confirm` keys on `event.transactionHash`; the envelope is already confirmed/non-removed and EIP-55-checksummed.
- `assertNotFloat` / `numericToBigInt` for the money boundary (NFR-2) — `@rose/shared`, `repositories/journal-entries.ts`.
- The refuse-if-absent + chain config (`loadChainConfig`) is unchanged here; the saga takes already-built clients/config from its caller.

### Files being modified (read before editing — preserve existing behavior)

- `prod/packages/ledger/src/schema/journal-entries.ts` — add `txHash` column only; the existing `coupledPairId` FK + `recordJournalEntry` callers must keep working (new column is nullable, defaults NULL, so all 5.1/earlier inserts are unaffected). Do NOT change `recordJournalEntry`'s signature in this story (stamping is a separate helper used at confirm time).
- `prod/packages/ledger/src/migrations/index.ts` — append `migration0007` only.
- `prod/packages/ledger/src/schema/index.ts`, `prod/packages/ledger/src/index.ts` — add the new re-exports only.
- `prod/packages/chain/package.json`, `prod/packages/chain/tsconfig.json`, root `tsconfig.json` — add the `@rose/ledger` reference (the chain package already builds composite; mirror authorization).
- `prod/packages/chain/src/index.ts` — add the outbox re-exports; the 5.1 surface re-exports must remain intact.

### Testing standards summary

- Framework: **Vitest** (`vitest run`), tests co-located as `*.test.ts`. Test-first on the three consistency invariants (NFR-6): commit-point ordering, idempotent replay, compensation-never-posts.
- **LOCAL only — no Sepolia, no network, no wallet key.** Repo tests hit the local Postgres (5544) exactly like the existing ledger integration tests (serialized via `fileParallelism: false` in `vitest.config.ts`). Saga tests are pure/in-memory (fake `OutboxStore`, fake `LedgerEffect`, synthetic `ChainEvent`s) — they assert the orchestration invariants without any DB or RPC, so the commit-point ordering is proven deterministically.
- Baseline to preserve: **Vitest 330**, **forge 171**, **migrations 6 → 7**. No Solidity touched ⇒ `forge test` stays 171. [Source: story 5-1 Gates]

### Full gate (must all pass before review)

`pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm check:migrations` · `pnpm format:check`. No Solidity touched ⇒ run `forge test` to confirm it stays 171/171. [Source: package.json scripts; CLAUDE.md]

### Project Structure Notes

- `@rose/chain` gaining a `@rose/ledger` dependency is consistent with the layering (`@rose/authorization` already depends on `@rose/ledger`); it introduces no import cycle (ledger does not depend on chain). The new dependency is purely DB-executor + outbox-repo access — it does NOT leak viem into ledger.
- `outbox_events` slots into the existing migration chain at `0007`; `prod/contracts` is untouched (no Solidity), so `forge test` count is unchanged.
- Regime boundary: both packages are PROD; neither imports `/throwaway`. `pnpm check:regime` backstops this.

### Anti-patterns to avoid (disaster prevention)

- Do NOT post the journal entry at intent or submission time — only at `confirm` (the commit point). Posting early breaks NFR-3 and is the exact failure this story exists to prevent.
- Do NOT rely on at-most-once event delivery; make `confirm` idempotent (already-`CONFIRMED` ⇒ no-op) and lean on the `tx_hash` unique constraint.
- Do NOT implement the concrete mint (5.3), burn (5.4), group view (5.5), or reconcile cadence/finality policy (5.6). Keep `submit` and `LedgerEffect` as ports; provide only the resume *seam* for 5.6.
- Do NOT edit/reorder migrations `0001`–`0006`; append `0007` only. Keep `up`/`down` exact inverses.
- Do NOT use `number`/`parseFloat` for any amount — `bigint`/`NUMERIC` only (NFR-2); store amounts in `payload` as decimal strings.
- Do NOT introduce a viem import in `@rose/ledger` or any non-chain package; the chain→ledger dependency is one-directional.
- Do NOT add a placeholder RPC/key or create any `.env`/secret — the saga receives already-built clients from its caller; the broadcast/confirmation wiring is ops-deferred.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.2 (lines 610-625)]
- [Source: _bmad-output/planning-artifacts/architecture.md — lines 45, 66, 164, 166, 176, 188, 200, 206, 218, 220, 243-244, 261, 315, 342, 365]
- [Source: _bmad-output/implementation-artifacts/5-1-...md — `ChainEvent` envelope, watchers, "Interfaces for 5.2 → 5.6"]
- [Source: prod/packages/ledger/src/migrations/0006-flow-permissions.ts — raw-SQL migration style]
- [Source: prod/packages/ledger/src/repositories/journal-entries.ts, db.ts — `recordJournalEntry`, `RoseExecutor`]
- [Source: prod/packages/ledger/src/rose-notes.test.ts — DB test harness pattern]
- [Source: prod/packages/chain/src/watchers.ts — `ChainEvent`/`watchPairEvents`]
- [Source: prod/packages/authorization/package.json, tsconfig.json — chain→ledger cross-package wiring precedent]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `pnpm typecheck` initially failed: `row.status` is `string` (drizzle `text()`), not `OutboxStatus`, at the 4 `assertTransition(row.status, …)` call sites → widened `assertTransition`'s `from` param to `string` with a defensive `LEGAL_TRANSITIONS` lookup. Clean after.
- `pnpm exec vitest run` (new files) → 24/24 (15 ledger repo against local Postgres, 9 chain saga in-memory). Full suite 354/354.
- `pnpm lint` flagged 2 unused-args in the test's `vi.fn(async (_db, _input) => {})` (the project's `no-unused-vars` is `args: after-used`, so two trailing unused args are caught) → declared the mock param-less (`vi.fn(async () => {})`); `vi.fn` still records the call args the saga passes. Clean after.
- `pnpm format:check` flagged the 5 new files → `prettier --write`. `pnpm check:migrations` → reversibility OK over 7 migrations. `forge test` 171/171 unchanged (no Solidity touched).

### Completion Notes List

- **AC-1 (on-chain tx = commit point):** `OutboxSaga` sequences `recordIntent` (PENDING) → `submit` (SUBMITTED, records the caller's tx hash) → `confirm` (CONFIRMED). The `LedgerEffect` (the journal-entry post, governed by `postTransfer` in 5.3/5.4) is invoked ONLY inside `confirm`, in ONE `db.transaction` together with `stampJournalEntryTxHash` + `markConfirmed`. Saga unit test asserts the effect is NEVER called at intent or submission and is called exactly once at confirm. No journal entry exists before confirmation.
- **AC-2 (idempotency + compensation, tx hash on entry, NFR-3):** two DB-enforced idempotency layers — `outbox_events.idempotency_key UNIQUE` (`recordIntent` returns the existing row on conflict → exactly-once intent) and `outbox_events.tx_hash UNIQUE` + the "already-CONFIRMED ⇒ no-op" guard in `confirm` (a replayed/reorg-redelivered confirmed tx applies its effect at most once). `submit` failure → `markFailed` (+attempts/lastError); `compensate` does `FAILED → COMPENSATED` and never posts a ledger effect. The on-chain tx hash is recorded on the related journal entry via `journal_entries.tx_hash` (`stampJournalEntryTxHash`) AND linked from `outbox_events.journal_entry_id`.
- **AC-3 (recovery/resume):** `confirm` is deterministic + idempotent from persisted state; `resumePending` returns the non-terminal (`PENDING`/`SUBMITTED`) rows for the reconcile story (5.6) to re-drive. The commit-point flip is atomic (one transaction), so no incoherent intermediate state is ever observable as committed.
- **State machine (fail-closed):** `LEGAL_TRANSITIONS` rejects illegal moves (`IllegalOutboxTransitionError`) — e.g. `PENDING → CONFIRMED` is refused (must be `SUBMITTED` first), a `CONFIRMED`/`COMPENSATED` row is terminal. Proven by the repo tests against real Postgres.
- **Layering:** the table/migration/schema/repository live in `@rose/ledger` (the DB owner, matching every other table); the saga orchestration lives in `@rose/chain/src/outbox/` and depends on `@rose/ledger` (mirrors `@rose/authorization` → `@rose/ledger`). No viem import was added to `@rose/ledger`; `@rose/chain` is still the only package talking to the chain. No import cycle (ledger does not import chain).
- **TESTS ARE LOCAL — NOT against Sepolia.** Repo tests use the local docker Postgres (5544) exactly like the other ledger integration tests; saga tests use in-memory fakes + synthetic Story-5.1 `ChainEvent`s. No RPC, no wallet key, no secret, no `.env`. The `submit`/`confirm` chain wiring is a SEAM for 5.3/5.4; real broadcast/confirmation + finality-depth tuning recorded in `deferred-work.md` (story-5.2 ops).
- **Scope held:** no concrete mint (5.3), burn (5.4), group view (5.5), or reconcile cadence/finality policy (5.6). `submit` and `LedgerEffect` stay ports; only the `resumePending` *seam* is provided for 5.6. No Solidity changed (forge stays 171).
- **Interfaces for 5.3 → 5.6:** `OutboxSaga` (`recordIntent`/`submit`/`confirm`/`confirmFromEvent`/`fail`/`compensate`/`resumePending`); the `LedgerEffect` port (5.3/5.4 implement it via `postTransfer`-governed `recordJournalEntry`); the `OutboxStore` port + `ledgerOutboxStore` default; the `@rose/ledger` outbox repo (`recordIntent`/`recordSubmission`/`markConfirmed`/`markFailed`/`markCompensated`/`findByTxHash`/`findByIdempotencyKey`/`listByStatus`/`stampJournalEntryTxHash`) and `journal_entries.tx_hash` (NFR-3 surface); `operation_kind` codes `PAIR_MINT`/`PAIR_BURN` reserved for 5.3/5.4.
- **Gates:** Vitest 330 → 354 (+24), forge 171/171 unchanged, migrations 6 → 7 (reversible), `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` all green.

### File List

**New — `@rose/ledger`:**

- `prod/packages/ledger/src/migrations/0007-outbox-events.ts` (migration: `outbox_events` table + `journal_entries.tx_hash` column; reversible)
- `prod/packages/ledger/src/schema/outbox-events.ts` (drizzle schema + `OutboxStatus`/`OutboxOperationKind` types)
- `prod/packages/ledger/src/repositories/outbox-events.ts` (repository: idempotency + fail-closed transitions + `stampJournalEntryTxHash`)
- `prod/packages/ledger/src/outbox-events.test.ts` (15 tests — real local Postgres)

**New — `@rose/chain`:**

- `prod/packages/chain/src/outbox/outbox-saga.ts` (`OutboxSaga`, `OutboxStore`/`LedgerEffect` ports, `ledgerOutboxStore`)
- `prod/packages/chain/src/outbox/index.ts` (outbox public surface)
- `prod/packages/chain/src/outbox/outbox-saga.test.ts` (9 tests — in-memory fakes + synthetic `ChainEvent`s)

**Modified:**

- `prod/packages/ledger/src/migrations/index.ts` (append `migration0007`)
- `prod/packages/ledger/src/schema/journal-entries.ts` (add nullable `txHash`)
- `prod/packages/ledger/src/schema/index.ts` (re-export outbox-events schema)
- `prod/packages/ledger/src/index.ts` (re-export outbox-events repo)
- `prod/packages/chain/package.json` (add `@rose/ledger` workspace dependency)
- `prod/packages/chain/tsconfig.json` (add `../ledger` project reference)
- `prod/packages/chain/src/index.ts` (re-export outbox surface)
- `pnpm-lock.yaml` (link `@rose/ledger` into `@rose/chain`)
- `_bmad-output/implementation-artifacts/deferred-work.md` (story-5.2 ops-deferred section)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5-2 backlog → ready-for-dev → in-progress → review)

## Change Log

| Date       | Version | Description                                                                 | Author |
| ---------- | ------- | --------------------------------------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev                                 | Amelia |
| 2026-06-16 | 0.2     | Implemented outbox/saga dual-write with the on-chain tx as commit point: migration 0007 (`outbox_events` + `journal_entries.tx_hash`, reversible), `@rose/ledger` outbox repository (DB-enforced idempotency on key + tx hash, fail-closed state machine, `stampJournalEntryTxHash`), and the generic port-driven `OutboxSaga` in `@rose/chain/src/outbox` (intent → submit → confirm[commit point] → compensate/resume; `LedgerEffect`/`OutboxStore` ports for 5.3/5.4). Proven LOCALLY (local Postgres for the repo, in-memory fakes + synthetic `ChainEvent`s for the saga — NO Sepolia, NO key, NO secret). Vitest 330→354, migrations 6→7, forge 171 unchanged; full gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers: Blind Hunter, Edge-Case Hunter, Acceptance Auditor — Auditor PASS on all 3 ACs + scope/no-secret/tests-local). 6 patches applied (row-locking `FOR UPDATE` + non-SUBMITTED guard in `confirm` so concurrent re-delivery can't double-post; `journal_entries.tx_hash` UNIQUE backstop in 0007; `recordSubmission` transactional row-lock + conditional update vs the submit race; submit error-preservation; WARN on confirm-with-no-row; WARN on confirm-of-non-SUBMITTED anomaly); 2 deferred (broadcast-then-throw orphan → reconcile 5.6; `attempts` re-arming → 5.6); 3 dismissed (payload-float — real NFR-2 boundary is `recordJournalEntry`; `resumePending` signature; File-List labeling). Vitest 354→356 (+2 patch tests); migrations 7 reversible; forge 171 unchanged; full gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] Concurrent `confirm()` could double-apply the ledger effect (unlocked read + unconditional update) [prod/packages/chain/src/outbox/outbox-saga.ts; prod/packages/ledger/src/repositories/outbox-events.ts] — `confirm` now reads the row via `findByTxHashForUpdate` (`SELECT … FOR UPDATE`) inside its transaction, so concurrent re-deliveries of the same confirmed tx serialize: the first confirms, the rest re-read CONFIRMED and no-op. The ledger effect is applied exactly once even under concurrency (NFR-9). (Blind+Edge, High)
- [x] [Review][Patch] `journal_entries.tx_hash` had no UNIQUE backstop — nothing in the DB prevented a duplicate ledger post for one on-chain tx [prod/packages/ledger/src/migrations/0007-outbox-events.ts; schema/journal-entries.ts] — added `ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_tx_hash_key UNIQUE (tx_hash)` (NULLs distinct, so off-chain entries unconstrained) + the drizzle `unique(...)`; the fail-closed DB backstop that makes a racing/replayed double-post impossible (NFR-3). New repo test proves it. (Blind+Edge, High/Low → patched)
- [x] [Review][Patch] `confirm()` on a non-SUBMITTED row whose tx later matched ran `ledgerEffect` then threw `IllegalOutboxTransitionError` into the watcher [prod/packages/chain/src/outbox/outbox-saga.ts] — `confirm` now guards `status !== 'SUBMITTED'` BEFORE invoking the effect: CONFIRMED → no-op; FAILED/COMPENSATED/PENDING-with-matching-hash → `{ applied: false }` + WARN (a reconcile-5.6 anomaly), never throwing into the watcher and never posting a wasted-then-rolled-back effect. New saga test covers the FAILED-then-confirms path. (Blind+Edge, Med)
- [x] [Review][Patch] `recordSubmission` race: two concurrent submissions for one PENDING row were last-writer-wins (no lock / no conditional update) [prod/packages/ledger/src/repositories/outbox-events.ts] — wrapped read+flip in a transaction with `SELECT … FOR UPDATE` + a conditional `WHERE status = 'PENDING'` update; the loser serializes, re-reads SUBMITTED, and is rejected (cross-row unique `tx_hash` additionally backstops two rows racing one hash). (Edge, Med)
- [x] [Review][Patch] `submit()` masked the original broadcast error if `markFailed` itself threw [prod/packages/chain/src/outbox/outbox-saga.ts] — the `markFailed` call is now wrapped in try/catch so the ORIGINAL submit error is always rethrown (the mark failure is WARN-logged), preserving the diagnostically important on-chain failure cause. (Blind, Med)
- [x] [Review][Patch] `confirm()` returned `null` silently for a confirmed tx with no recorded intent [prod/packages/chain/src/outbox/outbox-saga.ts] — added a WARN log (a confirmed on-chain tx with no outbox row is a reconcile-5.6 signal, per the project logging policy). (Blind, Low)
- [x] [Review][Defer] Broadcast-then-throw orphan — `submit()` failing after the node accepts the tx loses the hash → on-chain effect with no hash-matchable journal entry [prod/packages/chain/src/outbox/outbox-saga.ts] — deferred to reconcile **5.6** (architecture names reconciliation as the dual-write-failure backstop; it matches chain-vs-ledger balances per entity, not only by tx hash) and the concrete `submit`/key handling to **5.3/5.4**. Partially mitigated (original error now preserved). Recorded in deferred-work.md. (Blind+Edge, High/Med)
- [x] [Review][Defer] `attempts` counter caps at 1 (FAILED→FAILED illegal) — retry re-arming belongs to the reconcile cadence [prod/packages/ledger/src/repositories/outbox-events.ts] — deferred to **5.6**; 5.2 ships the column + `resumePending` seam. Recorded in deferred-work.md. (Edge, Low)
- [Review][Dismiss] `payload` jsonb amounts not runtime-validated against NFR-2 — the BINDING money→`bigint` boundary is `recordJournalEntry`/`assertNotFloat` at the commit point (the `LedgerEffect` in 5.3/5.4); `payload` is a generic envelope that may legitimately carry non-amount numeric metadata, and 5.2 introduces no float. (Edge+Auditor, Low/informational)
- [Review][Dismiss] `resumePending()` signature deviates from the spec's literal `resumePending(db, { onConfirmed })` — AC-3 intent (a safe seam surfacing non-terminal rows for 5.6) is fully met; the instance-held `db` is cleaner and the `onConfirmed` re-drive callback is a 5.6 concern that wraps the returned rows. (Auditor, Low)
- [Review][Dismiss] File List labels the three `@rose/chain` files "Modified" though git sees them untracked-from-5.1 — they WERE modified by this story (added the `@rose/ledger` dep, the `../ledger` reference, the outbox re-exports); they are absent from the tracked-only diff because 5.1 was never committed. Labeling is accurate from the working-tree perspective. (Auditor, Low)

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (6 patches applied; 2 deferred with rationale; 3 dismissed — no unresolved High/Med)

Three parallel adversarial layers ran against the 5.2 diff. **Blind Hunter** (diff only) and **Edge-Case Hunter** (diff + project access) converged tightly on the central risk: the exactly-once commit-point invariant was enforced only by an unlocked read + an unconditional update, so concurrent re-delivery of the same confirmed tx could post two journal entries — and `journal_entries.tx_hash` had no UNIQUE backstop. Both are now closed (row-locking `FOR UPDATE` serialization in `confirm` AND the DB UNIQUE constraint as the fail-closed backstop). They also surfaced the `recordSubmission` race (now transactional + conditional), the `confirm`-on-non-SUBMITTED state-machine gap (now guarded before the effect, no throw into the watcher), and the submit error-masking + silent-null observability gaps (now WARN-logged with the original error preserved). The broadcast-then-throw orphan and the `attempts` re-arming are deferred to reconcile **5.6** — the architecture-sanctioned backstop for dual-write failures — with rationale recorded. **Acceptance Auditor** (diff + spec) returned **PASS on AC-1/AC-2/AC-3** and on scope-held (no 5.3/5.4/5.5/5.6 leakage — `submit`/`LedgerEffect` stay ports), no-secret/placeholder/RPC/key, and tests-genuinely-LOCAL (local Postgres + in-memory fakes + synthetic `ChainEvent`s), with only Low/informational notes (all dismissed with rationale). After the 6 patches: Vitest 354 → 356 (+2 patch tests, 356 total), migrations 7/7 reversible, forge 171/171 unchanged, `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` all green. No residual High/Med correctness risk.
