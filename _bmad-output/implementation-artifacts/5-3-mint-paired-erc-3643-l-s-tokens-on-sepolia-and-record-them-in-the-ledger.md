---
baseline_commit: 4369bfced4c172917b0c5f19f4c24a79d11ac349
---

# Story 5.3: Mint paired ERC-3643 L/S tokens on Sepolia and record them in the ledger

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Investment Manager,
I want issuing a pair to mint paired L/S tokens on Sepolia and record quantity + value in the ledger,
so that issuance is real on-chain and reconcilable to the books (FR-18).

## Acceptance Criteria

1. **Given** a pair issuance, **when** the mint executes, **then** one L-Token and one S-Token are minted at equal notional via the custom contract on Sepolia (atomic), and the ledger records both quantity and value in ONE balanced entry (with FR-13). The dual-write flows through the Story-5.2 outbox/saga: the on-chain `mintPair` tx is the **commit point** — the balanced journal entry is posted **only after** the `PairMinted` confirmation (`ChainEvent`), never at intent or at submission (NFR-3).
2. **Given** the minted position, **when** reconciliation reads on-chain quantities, **then** minted on-chain quantities match ledger token quantities (NFR-9), and a single-leg mint is impossible. Replaying the same `PairMinted` (watcher re-delivery / reorg re-scan) does NOT double the ledger entry (idempotent commit point, from 5.2).

### Scope boundary (P0, this story only)

- IN SCOPE: the concrete **paired-mint dual-write orchestration** wired onto the 5.2 `OutboxSaga` — (a) a typed on-chain `mintPair` write seam (`submitMintPair`, the saga `submit` port) calling the epic-4 `CoupledPair.mintPair(lTo, sTo, amount)` via the 5.1 `getWalletClient`; (b) a concrete `LedgerEffect` (`makeMintPairLedgerEffect`) that, at the commit point, posts ONE balanced journal entry linked to the coupled pair (FR-13 `recordJournalEntry`) capturing the minted **token quantity** (taken from the confirmed on-chain `PairMinted.amount` — chain = source of truth, D3 / NFR-9) **and** the notional **value**, fail-closed behind the authorization seam `postTransfer` consults; (c) the mint orchestration `MintPairDualWrite` (record intent `PAIR_MINT` → submit → confirm-from-event) and the `PairMinted → confirm` wiring. All proven **LOCALLY** (real local Postgres for the ledger effect, mock EIP-1193 transport / in-memory fakes + synthetic `PairMintedEvent`s for the orchestration + write encoding — NOT against real Sepolia, no wallet key).
- OUT OF SCOPE (later stories — do NOT implement): the package **burn**/redemption + its journal entry (5.4), the consolidated **group view** (5.5), the full ledger↔chain **reconcile-and-correct** loop + finality/reorg cadence (5.6). This story delivers MINT + the balanced ledger recording only.
- OUT OF SCOPE (ops, deferred): the REAL Sepolia broadcast/confirmation of `mintPair` (no `SEPOLIA_RPC_URL`, no signing key, no confirmation-depth tuning against a live chain). The write code (`submitMintPair`) is code-complete and proven locally; the actual broadcast awaits secrets provided out-of-band. Record it in `deferred-work.md` (story-5.3 ops section). **No real secret is ever created.**

## Tasks / Subtasks

- [x] Task 1 — On-chain `mintPair` write seam in `@rose/chain` (AC: 1)
  - [x] Added the `mintPair(address lTo, address sTo, uint256 amount)` FUNCTION entry to the curated `prod/packages/chain/src/abis/coupled-pair-abi.ts` (signature-identical to the generated `CoupledPair.json` — `nonpayable`, `[lTo, sTo, amount]`). Events intact. NO Solidity change ⇒ `forge test` stays 171.
  - [x] Added `submitMintPair(clients, account, { pairAddress, lTo, sTo, amount })` in `prod/packages/chain/src/mint/mint-pair.ts`: builds the wallet client via the 5.1 `getWalletClient(account)` seam and `writeContract(... functionName: 'mintPair', args: [lTo, sTo, amount])`, returning `{ txHash }`. `amount` is `bigint` (NFR-2 guarded). Added `encodeMintPairCall(params)` (pure `encodeFunctionData`) as the deterministic, network-free calldata seam.
- [x] Task 2 — Concrete mint `LedgerEffect` (the commit-point balanced entry) (AC: 1, 2)
  - [x] Added `makeMintPairLedgerEffect(onChainAmount, plan)` returning a 5.2 `LedgerEffect`: (1) **binds NFR-9** — the recorded quantity IS the confirmed on-chain `PairMinted.amount`, asserting `onChainAmount === BigInt(payload.amount)`, throwing `MintQuantityDivergenceError` on mismatch (nothing posted); (2) **fail-closed** — a non-`ALLOW` `MintAuthorizationGate` decision throws `MintAuthorizationError`, posts NOTHING (NFR-4); (3) posts ONE balanced `recordJournalEntry({ coupledPairId, postings })` — L+S quantity postings (each leg balances holder DEBIT vs supply CREDIT at `onChainAmount`) + caller-supplied value postings, linked to the pair (FR-13).
  - [x] **Single-leg-impossible (ledger side):** the effect ALWAYS constructs BOTH leg-quantity postings from the single `onChainAmount` (no single-leg path); the per-(asset,scale) balance + DB trigger reject a mis-asseted plan. `payload` amounts are decimal strings → `bigint` at the boundary.
- [x] Task 3 — Mint orchestration + `PairMinted → confirm` wiring (AC: 1, 2)
  - [x] Added `MintPairDualWrite` over a 5.2 `OutboxSaga`: `start(request)` → `recordIntent(PAIR_MINT)` then `submit(id, () => submitMintPair(...))` (PENDING → SUBMITTED; NO ledger effect yet). `confirmFromMintedEvent(event, plan)` → `saga.confirmFromEvent(event, makeMintPairLedgerEffect(event.args.amount, plan))` (commit point). Live wiring documented in the docstring.
  - [x] Defined the typed `MintPairIntent` payload + Zod parser (zod is a `@rose/chain` dep) and `MintLedgerPlan` (caller-supplied account topology + value postings + authorization gate) — the established caller-supplied-facts trust boundary.
  - [x] Added `prod/packages/chain/src/mint/index.ts` and re-exported the mint surface from `prod/packages/chain/src/index.ts`; the 5.1/5.2 re-exports remain intact.
- [x] Task 4 — Tests, test-first on the invariants (AC: 1, 2) — LOCAL only
  - [x] `prod/packages/chain/src/mint/mint-pair.test.ts` (16 tests, NO Postgres, NO network — mock EIP-1193 + in-memory `OutboxStore` fake + synthetic `PairMintedEvent`): `encodeMintPairCall` encodes `mintPair(lTo,sTo,amount)` + rejects bad/over-uint256 amount; `submitMintPair` returns the hash and the signed raw tx targets `pairAddress` with `mintPair` calldata (real viem sign/encode, no network); `start` records PAIR_MINT intent then SUBMITTED, no effect, is idempotent (no double-broadcast on retry), and vetoes pre-submit on DENY; effect guards (amount/recipient divergence, plan-account collision, bad amount, malformed payload) throw before any write.
  - [x] `prod/packages/chain/src/mint/mint-pair-ledger.test.ts` (6 tests, real local Postgres): ONE balanced entry linked to the pair capturing quantity + value, posted ONLY at confirm (zero entries after submit) (AC-1); **ledger token quantity == on-chain `PairMinted.amount`** (NFR-9); idempotent replay (one entry); a pre-submit DENY records nothing (no intent, no mint); a quantity divergence / mis-asseted plan is a non-applied anomaly that posts NOTHING (outbox stays SUBMITTED); `journal_entries.tx_hash` stamped (NFR-3).
  - [x] Baseline preserved: **Vitest 356 → 378** (+22, incl. +5 from review patches), **forge 171** unchanged, migrations unchanged at **7** (NO new migration).
- [x] Task 5 — Boundary, docs, gates
  - [x] `@rose/chain` remains the only PROD package importing `viem`; NO new package dependency edge — the authorization gate is an injected port (`MintAuthorizationGate`), so `@rose/chain` does NOT import `@rose/authorization`. `pnpm check:regime` green.
  - [x] Recorded the REAL-Sepolia `mintPair` broadcast/confirmation wiring + finality cadence + caller-supplied plan/gate in `deferred-work.md` (story-5.3 ops section).
  - [x] Full gate green: `pnpm test` (378) · `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm check:migrations` (7, reversible) · `pnpm format:check`; `forge test` 171/171. `sprint-status.yaml` + File List + Change Log updated.

## Dev Notes

### Architecture-mandated decisions (follow exactly)

- **Dual-write ordering (NFR-9 / NFR-3) — reuse 5.2, do not reinvent:** intent (`PAIR_MINT`) → on-chain `mintPair` tx (**commit point**) → on `PairMinted` confirmation, post the balanced journal entry. The 5.2 `OutboxSaga` already enforces this (commit-point ordering, idempotent confirm, fail-closed transitions, `journal_entries.tx_hash` stamping). 5.3 supplies the concrete `submit` (`submitMintPair`) and `LedgerEffect` (`makeMintPairLedgerEffect`) ports the 5.2 saga was built to receive. [Source: architecture.md lines 164, 243-244, 261; story 5-2 Completion Notes "Interfaces for 5.3 → 5.6"]
- **Chain = source of truth (D3) / NFR-9 binding:** the ledger token quantity is taken from the CONFIRMED on-chain `PairMinted.amount`, NOT from the intent payload — so ledger quantity == on-chain quantity by construction. The intent's `payload.amount` is cross-checked against the on-chain amount; divergence throws (nothing posted) and is left for reconcile (5.6). [Source: architecture.md "chain authoritative"; epics.md Story 5.3 AC-2]
- **Atomic paired mint / single-leg impossible:** the epic-4 `CoupledPair.mintPair` mints BOTH legs by the same `amount` in one tx (the `_pairing` guard makes a single-leg leg-mint impossible; either both or neither — the whole tx reverts). The ledger effect mirrors this: it always builds BOTH leg-quantity postings from the single `onChainAmount`. The contract is the source-of-truth backstop; the ledger never records a single leg. [Source: CoupledPair.sol `mintPair`; story 4-3]
- **One balanced entry (FR-13) + postTransfer-governed (P0 interpretation, see below):** AC-1 says "records both quantity and value in ONE balanced entry (with FR-13)". 5.3 records exactly one `recordJournalEntry` linked to `coupled_pair_id` (FR-13's primitive), and gates the value movement fail-closed via the SAME default-deny authorization decision `postTransfer` consults — injected as a port so `@rose/chain` stays decoupled from `@rose/authorization`. [Source: epics.md Story 5.3 AC-1; FR-13; post-transfer.ts; story 5-2 "LedgerEffect via postTransfer-governed recordJournalEntry"]
- **Money / NFR-2:** all token quantities + values are integers (`bigint` in TS; `uint256` on-chain; `NUMERIC` in the ledger). `payload` jsonb stores amounts as decimal strings; the effect converts to `bigint` for `recordJournalEntry`. The raw uint256 mint `amount` is the ledger smallest-unit quantity (exact bigint equality — NFR-9). Never coerce to `number`/float. [Source: architecture.md line 45; CLAUDE.md NFR-2; journal-entries.ts `numericToBigInt`/`assertNotFloat`]
- **No migration in 5.3:** the `outbox_events` table + `journal_entries.tx_hash` (NFR-3) already exist from 5.2 (migration 0007). 5.3 adds NO migration — `pnpm check:migrations` stays green at 7. [Source: migrations/0007-outbox-events.ts]
- **Chain boundary (hard rule):** `@rose/chain` is the only module talking to Sepolia (viem). The mint write uses the existing 5.1 `getWalletClient` seam; no key is held/derived here. [Source: architecture.md line 342; viem-clients.ts]
- **Naming:** files `kebab-case.ts`; types `PascalCase`; funcs/vars `camelCase`. The glossary verb is `mintPair`. The outbox `operation_kind` code is `PAIR_MINT` (reserved by 5.2). [Source: architecture.md lines 218, 222]

### P0 interpretation (documented, not invented scope)

- **"One balanced entry" + "postTransfer-governed":** `postTransfer` records a single-asset, exactly-two-posting VALUE transfer and cannot, by itself, express the combined quantity(TOKEN)+value(notional) entry AC-1 mandates. FR-13's primitive (`recordJournalEntry` with `coupled_pair_id`) is what records a coupled event as ONE balanced entry. Therefore 5.3 records ONE combined balanced entry via `recordJournalEntry`, and honors "postTransfer-governed" by consulting the SAME substitutable default-deny authorization decision `postTransfer` consults (injected `MintAuthorizationGate`) BEFORE any write — fail-closed (NFR-4). This keeps the chokepoint's governance while satisfying the single-entry + FR-13 requirement, and keeps `@rose/chain` decoupled from `@rose/authorization` (no new edge/cycle — the port pattern 5.2 established for `LedgerEffect`/`OutboxStore`). A future composition layer (Epic 6) injects the real `postTransfer` provider into the gate.
- **Account topology is caller-supplied:** like `postTransfer` (account types/classification/destinationKind) and `issueCoupledPair` (postings), the concrete L/S holder + supply-contra accounts and the value postings are supplied by the caller via `MintLedgerPlan`. 5.3 does not model a fixed account layout (leg→token-account linkage is an Epic-6 concern); it guarantees the invariants (one balanced entry, quantity == on-chain amount, both legs always present, fail-closed).

### Reuse — do NOT reinvent (extend these existing pieces)

- **5.2 `OutboxSaga`** (`recordIntent`/`submit`/`confirm`/`confirmFromEvent`/`resumePending`) + the `LedgerEffect`/`OutboxStore` ports — `prod/packages/chain/src/outbox/outbox-saga.ts`. 5.3 plugs concrete ports in; it does NOT change the saga.
- **5.1 `getWalletClient` seam** + `RoseChainClients` + the `coupledPairAbi` — `prod/packages/chain/src/viem-clients.ts`, `abis/coupled-pair-abi.ts`. The write reuses the seam; key handling is out-of-band/deferred.
- **5.1 `PairMintedEvent`/`watchPairEvents`** — `prod/packages/chain/src/watchers.ts`. The confirmation is the `PairMinted` `ChainEvent`; `confirmFromEvent` keys on `event.transactionHash` and carries `event.args.amount` (the NFR-9 quantity).
- **FR-13 `recordJournalEntry(executor, { description, coupledPairId, postings })`** + `RoseExecutor` — `prod/packages/ledger/src/repositories/journal-entries.ts`. Validates ≥2 postings, per-(asset,scale) balance, integer amounts; the DEFERRABLE double-entry trigger is the DB backstop.
- **`stampJournalEntryTxHash` (NFR-3)** — already invoked by the 5.2 saga `confirm` after the effect returns `journalEntryId`; 5.3's effect only returns the id.
- **`assertNotFloat`** (NFR-2) — `@rose/shared`. The authorization decision vocabulary (`Effect`, `TransferScenario`, `ConformanceEnv`) — `@rose/rule-spec` (used only to TYPE the injected gate's inputs if needed; the gate itself is an opaque thunk to avoid a new dep edge).
- **DB test harness** (`createPool`/`createDb`/`hardReset`/`migrateUp`, `TRUNCATE … CASCADE`) — `prod/packages/authorization/post-transfer.test.ts` (a `@rose/ledger`-DB test living OUTSIDE `@rose/ledger`), `prod/packages/ledger/src/issuance.test.ts`. The mock EIP-1193 write/read transport — `prod/packages/chain/src/viem-clients.test.ts`, `watchers.test.ts`.

### Files being modified (read before editing — preserve existing behavior)

- `prod/packages/chain/src/abis/coupled-pair-abi.ts` — ADD the `mintPair` function entry only; keep all existing events. `as const` preserved for viem inference.
- `prod/packages/chain/src/index.ts` — ADD the mint re-exports only; the 5.1/5.2 surface re-exports must remain intact.
- (No change to `outbox-saga.ts`, the ledger schema/migrations, `package.json`, or `tsconfig.json` — 5.3 needs no new table and no new dependency.)

### Testing standards summary

- Framework: **Vitest** (`vitest run`), tests co-located `*.test.ts`. Test-first on the invariants (NFR-6): commit-point ordering, NFR-9 quantity match, fail-closed authorization, idempotent replay, single-leg-impossible.
- **LOCAL only — no Sepolia, no network, no wallet key for the asserted flow.** The ledger-effect test hits the local Postgres (5544) exactly like the other `@rose/ledger`-DB tests (serialized via `fileParallelism: false`). The orchestration + write-encoding tests use a mock EIP-1193 transport + in-memory fakes + synthetic `PairMintedEvent`s. The `submit` broadcast is the deferred-ops seam; the asserted full flow injects a deterministic hash + a synthetic confirmed event (the 5.2 philosophy).
- Baseline to preserve: **Vitest 356**, **forge 171**, **migrations 7** (no new migration). No Solidity touched ⇒ `forge test` stays 171.

### Full gate (must all pass before review)

`pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm check:regime` · `pnpm check:migrations` · `pnpm format:check`. No Solidity touched ⇒ run `forge test` to confirm it stays 171/171. [Source: package.json scripts; CLAUDE.md]

### Project Structure Notes

- `@rose/chain` gains no new dependency edge: the mint module reuses `@rose/ledger` (already a dep from 5.2 for the outbox/ledger effect) and `viem`; the authorization gate is an injected port (no `@rose/authorization` import → no new edge, no cycle).
- No new table/migration — 5.3 reuses the 5.2 `outbox_events` + `journal_entries.tx_hash`. `prod/contracts` is untouched (no Solidity) ⇒ `forge test` count unchanged.
- Regime boundary: PROD only; no `/throwaway` import. `pnpm check:regime` backstops this.

### Anti-patterns to avoid (disaster prevention)

- Do NOT post the journal entry at intent or submission time — only at `confirm` (the commit point, enforced by the 5.2 saga). 5.3 must not add a write before confirmation.
- Do NOT take the ledger token quantity from the intent payload as the source of truth — take it from the confirmed on-chain `PairMinted.amount` (D3 / NFR-9); cross-check the payload and throw on divergence.
- Do NOT post a single leg — always build BOTH leg-quantity postings from one `onChainAmount`.
- Do NOT bypass authorization — a non-`ALLOW` gate decision must post NOTHING (fail-closed, NFR-4).
- Do NOT add a migration, a new table, or a new package dependency — reuse 5.2's table + ports.
- Do NOT use `number`/`parseFloat` for any amount — `bigint`/`NUMERIC` only (NFR-2); `payload` amounts are decimal strings.
- Do NOT add a placeholder RPC/key or create any `.env`/secret — the write uses the 5.1 `getWalletClient` seam; the real broadcast is ops-deferred.
- Do NOT change the 5.2 `OutboxSaga`, the ledger migrations/schema, or break the 5.1/5.2 re-exports.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.3 (lines 626-640); FR-18]
- [Source: _bmad-output/planning-artifacts/architecture.md — lines 45, 164, 218, 243-244, 261, 342]
- [Source: _bmad-output/implementation-artifacts/5-2-...md — `OutboxSaga`, `LedgerEffect`/`OutboxStore` ports, "Interfaces for 5.3 → 5.6"]
- [Source: _bmad-output/implementation-artifacts/5-1-...md — `getWalletClient`, `PairMintedEvent`/`watchPairEvents`]
- [Source: prod/packages/chain/src/outbox/outbox-saga.ts — the saga 5.3 plugs into]
- [Source: prod/packages/chain/src/viem-clients.ts, watchers.ts, abis/coupled-pair-abi.ts]
- [Source: prod/contracts/src/token/CoupledPair.sol — `mintPair`/`PairMinted`]
- [Source: prod/packages/ledger/src/repositories/journal-entries.ts, issuance.ts — `recordJournalEntry`, FR-13]
- [Source: prod/packages/authorization/src/post-transfer.ts, post-transfer.test.ts — the chokepoint provider seam + the @rose/ledger-DB test pattern outside @rose/ledger]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Unit test `submitMintPair`/`encodeMintPairCall` initially failed with `InvalidAddressError` — the literal mixed-case test addresses had invalid EIP-55 checksums; fixed by normalizing via viem `getAddress(lowercase)`. The mock EIP-1193 write provider answers `eth_chainId`/`eth_getTransactionCount`/`eth_estimateGas`/fee+block methods/`eth_sendRawTransaction` so viem's real local signing path runs with no network.
- `pnpm typecheck` (tsc -b) flagged 3 in the integration test (vitest/esbuild had passed): `import type pg from 'pg'` (pg is not a `@rose/chain` dep) → switched to `ReturnType<typeof createPool>` (the `post-transfer.test.ts` pattern); `ledgerOutboxStore` imported from `@rose/ledger` (it actually lives in `@rose/chain`) → dropped the import and let `new OutboxSaga({ db })` default to it; the consequent implicit-any on the balances `.map` cleared once `pool` was typed.
- The "mis-asseted plan" test first PASSED the confirm (the swapped legs coincidentally balanced per asset); corrected the bad plan to point one leg's supply contra at an EUR account so the ROSE_L debit + EUR credit each stand alone within their asset group ⇒ `UnbalancedEntryError`, nothing persists.
- `pnpm format` reflowed the 3 new files; `format:check` clean after. `forge test` 171/171 (no Solidity touched). Full Vitest suite 356 → 373.

### Completion Notes List

- **AC-1 (atomic paired mint on-chain + ONE balanced ledger entry at the commit point):** `MintPairDualWrite.start` records the `PAIR_MINT` intent (PENDING) and submits `CoupledPair.mintPair(lTo, sTo, amount)` via the 5.1 `getWalletClient` seam (SUBMITTED) — NO journal entry yet. `confirmFromMintedEvent` (driven by the 5.1 `PairMinted` `ChainEvent`) is the commit point: it posts ONE balanced `recordJournalEntry` linked to the coupled pair (FR-13) capturing the L+S token QUANTITY and the notional VALUE, inside the 5.2 saga's confirm transaction (atomic with `SUBMITTED → CONFIRMED` + the `journal_entries.tx_hash` stamp). The integration test proves zero entries after submit and exactly one balanced entry (6 postings: 4 quantity + 2 value) after confirm. The single L/S amount is contract-enforced atomic on-chain (epic 4 `mintPair`).
- **AC-2 (NFR-9 quantity match + single-leg impossible + idempotent):** the recorded quantity is taken from the CONFIRMED on-chain `PairMinted.amount` (chain = source of truth, D3); the test asserts each leg's ledger balance equals the on-chain amount exactly (bigint equality). A divergence between the recorded intent's amount and the on-chain amount throws `MintQuantityDivergenceError` and posts nothing. The effect ALWAYS builds both leg-quantity postings from the one amount (no single-leg path); a mis-asseted plan is rejected by the per-(asset,scale) balance + DB trigger. Replaying the same confirmed `PairMinted` applies the effect once (`applied: false` on the second — the 5.2 idempotent `confirm`).
- **Fail-closed (NFR-4):** the value movement is gated by an injected `MintAuthorizationGate` — the SAME default-deny decision `postTransfer` consults; a non-`ALLOW` decision throws `MintAuthorizationError` BEFORE any write and the confirm transaction rolls back (outbox stays SUBMITTED, zero journal entries) — proven against real Postgres.
- **P0 interpretation (documented):** AC-1's "ONE balanced entry (with FR-13)" + "postTransfer-governed" is satisfied by recording one combined `recordJournalEntry(coupledPairId)` (quantity TOKEN legs + value notional) and gating it fail-closed via the same authorization decision `postTransfer` uses — injected as a port (`MintAuthorizationGate`) so `@rose/chain` stays decoupled from `@rose/authorization` (no new package edge / no cycle). `postTransfer` itself records a single-asset 2-posting transfer and cannot express the combined quantity+value entry the AC mandates; FR-13's `recordJournalEntry` can. Account topology is caller-supplied (the `postTransfer`/`issueCoupledPair` trust boundary).
- **Scope held:** MINT + balanced ledger recording only. NO burn (5.4), NO group view (5.5), NO reconcile cadence/finality (5.6). NO new migration/table/package dependency (reuses the 5.2 `outbox_events` + `journal_entries.tx_hash`). NO Solidity change (forge stays 171).
- **TESTS ARE LOCAL — NOT against Sepolia.** The write encoding/signing is proven against a mock EIP-1193 transport (real viem, no network); the full dual-write is proven against the local docker Postgres with an injected deterministic submit hash + a synthetic Story-5.1 `PairMintedEvent`. No RPC, no wallet key, no secret, no `.env`. The real broadcast + finality cadence are recorded in `deferred-work.md` (story-5.3 ops).
- **Interfaces for 5.4 → 5.6:** `MintPairDualWrite` (`start`/`confirmFromMintedEvent`); `submitMintPair`/`encodeMintPairCall` (the `mintPair` write seam — 5.4 mirrors with `burnPair`); `makeMintPairLedgerEffect`/`MintLedgerPlan`/`MintAuthorizationGate` (the commit-point balanced-entry pattern + caller-supplied topology + injected fail-closed gate); `MintQuantityDivergenceError` (the NFR-9 divergence signal 5.6's reconcile consumes); the `mintPair` ABI function entry on `coupledPairAbi`.

### File List

**New — `@rose/chain`:**

- `prod/packages/chain/src/mint/mint-pair.ts` (`MintPairDualWrite`, `submitMintPair`/`encodeMintPairCall`, `makeMintPairLedgerEffect`, `MintPairIntent`/`MintLedgerPlan`/`MintAuthorizationGate` + errors)
- `prod/packages/chain/src/mint/index.ts` (mint public surface)
- `prod/packages/chain/src/mint/mint-pair.test.ts` (11 tests — mock EIP-1193 + in-memory fakes, NO network/DB)
- `prod/packages/chain/src/mint/mint-pair-ledger.test.ts` (6 tests — real local Postgres)

**Modified:**

- `prod/packages/chain/src/abis/coupled-pair-abi.ts` (add the `mintPair` function entry; events intact)
- `prod/packages/chain/src/index.ts` (re-export the mint surface)
- `_bmad-output/implementation-artifacts/deferred-work.md` (story-5.3 ops-deferred section)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5-3 backlog → ready-for-dev → in-progress → review)

## Change Log

| Date       | Version | Description                                  | Author |
| ---------- | ------- | -------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev  | Amelia |
| 2026-06-16 | 0.2     | Implemented the paired-mint dual-write (FR-18, NFR-9/NFR-3) on the 5.2 outbox/saga: `mintPair` write seam (`submitMintPair`/`encodeMintPairCall` + ABI function) via the 5.1 `getWalletClient`, the commit-point balanced `LedgerEffect` (`makeMintPairLedgerEffect` — quantity from the confirmed on-chain `PairMinted.amount`, value notional, fail-closed via an injected authorization gate, ONE entry linked to the pair), and the `MintPairDualWrite` orchestration (intent → submit → confirm-from-event). Proven LOCALLY (mock EIP-1193 for the write + real local Postgres for the dual-write — NO Sepolia, NO key, NO secret). Vitest 356→373, forge 171 unchanged, migrations 7 unchanged; full gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers: Blind Hunter, Edge-Case Hunter [live DB], Acceptance Auditor — Auditor PASS on AC-1/AC-2/scope/network-scope/P0). 8 patches applied: (H) **authorization moved PRE-submit** in `start` (refusing after the irreversible on-chain mint would strand tokens with no recordable entry — unrecoverable NFR-9 divergence; the commit-point effect now records the chain truth unconditionally); (H) `start` **short-circuits non-PENDING rows** so a retry/key-reuse never re-broadcasts a duplicate mint; (M) `confirmFromMintedEvent` **catches effect errors → typed `MintConfirmOutcome`**, never throwing into the fire-and-forget watcher; (M) **`lTo`/`sTo` recipient cross-check** vs intent (NFR-9); (M) **`assertPlanAccountsDisjoint`** (quantity-leg account distinctness + value-posting disjointness) prevents silent quantity-netting; (L) uint256 upper bound, divergence WARN log, tx-hash shape validation. 2 boundaries deferred to 5.6/Epic 6 (multi-`PairMinted`-per-tx; cross-leg same-asset). Vitest 373→378 (+5 patch tests), forge 171 unchanged, migrations 7 unchanged; full gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] Authorization ran at the post-mint commit point → an unrecoverable chain↔ledger divergence; moved fail-closed authorization PRE-submit [prod/packages/chain/src/mint/mint-pair.ts `start`/`makeMintPairLedgerEffect`] — once the chain has minted, the ledger MUST record it (D3/NFR-9), so a fail-closed veto at confirm would strand real tokens with no recordable entry. The `MintAuthorizationGate` is now consulted in `start` BEFORE the on-chain mint (non-`ALLOW` → `MintAuthorizationError`, no intent, no mint); the commit-point effect records the confirmed on-chain quantity unconditionally. (Blind+Auditor, High)
- [x] [Review][Patch] `start()` re-broadcast a DUPLICATE on-chain mint on idempotency-key reuse/retry [prod/packages/chain/src/mint/mint-pair.ts `start`] — `recordIntent` was idempotent but `submit` always broadcast first, then `recordSubmission` threw an illegal-transition OUTSIDE `submit`'s try/catch, losing the duplicate hash. `start` now inspects the returned row and SHORT-CIRCUITS any non-`PENDING` row (returns it with `alreadyStarted: true`, no re-broadcast) — exactly-once on-chain mint. New test asserts a retried `start` broadcasts only once. (Edge, High)
- [x] [Review][Patch] A throwing ledger effect escaped `confirm` into the fire-and-forget watcher (unhandled rejection, stranded row) [prod/packages/chain/src/mint/mint-pair.ts `confirmFromMintedEvent`] — the watcher-facing method now CATCHES effect/confirm errors and returns a typed `MintConfirmOutcome` (`applied`/`noop`/`no-row`/`anomaly`) with a WARN, never throwing into the watcher; the row stays SUBMITTED for reconcile (5.6). The saga's direct `confirm` still throws (the ledger-test boundary). (Blind+Edge, Med)
- [x] [Review][Patch] Only `amount` was cross-checked against the chain; `lTo`/`sTo` were not (NFR-9) [prod/packages/chain/src/mint/mint-pair.ts `makeMintPairLedgerEffect`] — the effect now takes the full `PairMintedArgs` and cross-checks EIP-55-normalized `lTo`/`sTo` AND `amount` against the recorded intent, throwing `MintQuantityDivergenceError` on any mismatch. New unit test covers recipient divergence. (Blind+Edge, Med)
- [x] [Review][Patch] Overlapping/duplicate plan accounts would silently net the recorded quantity while still "balancing" + passing the amount cross-check [prod/packages/chain/src/mint/mint-pair.ts `assertPlanAccountsDisjoint`] — the effect now asserts the four quantity-leg accounts are pairwise distinct AND that no value posting targets a quantity-leg account (`MintPlanError`). New unit tests cover both. (Blind+Edge, Med)
- [x] [Review][Patch] No uint256 upper-bound check (rejected late by viem after a PENDING row was persisted) [prod/packages/chain/src/mint/mint-pair.ts `assertMintAmount`] — `assertMintAmount` now rejects `amount > 2^256-1` (and non-bigint / non-positive) before any write. New unit test. (Edge confirmed the NUMERIC round-trip is lossless; this is fail-early hardening.) (Blind, Low/Med)
- [x] [Review][Patch] Divergence path logged nothing (unlike the auth path); unchecked `as Hex` cast on the tx hash [prod/packages/chain/src/mint/mint-pair.ts] — added a structured WARN on the divergence path and a `0x`-hex shape validation before the `Hex` cast in `start`. (Blind, Low)
- [x] [Review][Defer] Multiple `PairMinted` logs under one tx hash (owner multicall/batch) would record only the first [prod/packages/chain/src/mint/mint-pair.ts] — impossible for the ROSE flow (`mintPair` is `onlyOwner`, emits exactly one `PairMinted` per tx); recipient cross-check guards the realistic case; batch-mint topology owned by reconcile 5.6. Recorded in deferred-work.md. (Edge, Low)
- [x] [Review][Defer] Cross-leg same-ASSET collision (distinct accounts) remains a caller-supplied-plan trust boundary [prod/packages/chain/src/mint/mint-pair.ts] — the distinct-account-id guard catches the netting bug; detecting same-asset different-account legs needs the account assets loaded (an Epic-6 leg→account-mapping concern). The per-asset balance + DB trigger still prevent an unbalanced entry. Recorded in deferred-work.md. (Blind, Med — partially patched)

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (8 patches applied; 2 boundaries deferred with rationale; no unresolved High/Med)

Three parallel adversarial layers ran against the 5.3 diff. **Blind Hunter** (diff only) and **Edge-Case Hunter** (diff + live local Postgres) converged on the central design risk: authorization was enforced at the post-mint commit point, where a fail-closed refusal would strand real on-chain tokens with no recordable ledger entry — an unrecoverable NFR-9 divergence that directly contradicts the story's own "chain = source of truth" intent. The fix re-seats the fail-closed gate PRE-submit (`start`), so a denial vetoes the dual-write before the irreversible on-chain mint, while the commit-point effect records the confirmed on-chain quantity unconditionally (NFR-9 by construction). The Edge-Case Hunter independently surfaced the most severe concrete bug — `start()` re-broadcasting a duplicate paired mint on any retry / idempotency-key reuse (the `recordIntent` idempotency did not cover the broadcast, and the subsequent illegal-transition threw outside `submit`'s try/catch, losing the duplicate hash) — now closed by short-circuiting non-`PENDING` rows so the on-chain mint is exactly-once. Both layers flagged the throwing effect escaping into the fire-and-forget watcher (now caught → typed `MintConfirmOutcome`, never thrown), the missing `lTo`/`sTo` cross-check (now checked alongside `amount`, NFR-9), and the silent quantity-netting from overlapping plan accounts (now guarded by `assertPlanAccountsDisjoint`). Lower-severity uint256-bound, divergence-logging, and tx-hash-shape items were patched. The Edge-Case Hunter verified (against the live DB) that the uint256-max value round-trips through `NUMERIC` losslessly and that `confirm` against terminal states never double-posts. **Acceptance Auditor** (diff + spec) returned **PASS on AC-1/AC-2, scope, network-scope, and the P0 interpretation**, with one CONCERN (the value/authorization gate was optional-on-confirm) — fully resolved by moving authorization to `start`. Two residual boundaries (multiple `PairMinted` per tx; cross-leg same-asset distinct-account collision) are documented and deferred to reconcile 5.6 / the Epic-6 composition layer. After the 8 patches: Vitest 373 → 378 (+5), forge 171/171 unchanged, migrations 7 (no new migration), `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` all green. No residual High/Med correctness risk. TESTS REMAIN LOCAL — mock EIP-1193 for the write, local Postgres + synthetic `PairMintedEvent`s for the dual-write; no real Sepolia, no secret/placeholder, real broadcast deferred (deferred-work.md story-5.3 ops).
