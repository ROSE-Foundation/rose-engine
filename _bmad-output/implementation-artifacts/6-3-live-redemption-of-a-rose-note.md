---
baseline_commit: NO_VCS
---

# Story 6.3: Live redemption of a Rose Note

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Subscriber (Rose Member),
I want to redeem (buy back) a Rose Note,
so that I can exit my position with the books and chain staying consistent (FR-11).

## Acceptance Criteria

1. **Given** a Subscriber holding a Rose Note, **when** they redeem it, **then** the redemption drives the package burn (Epic 5) and produces balanced journal entries, respecting the chokepoint and segregation rules **and** the redemption is visible in the group view and reconciles supply ↔ ledger.
2. **Given** the Subscriber surface (UX-DR6), **when** the Subscriber initiates a redemption, **then** it passes the **Review → Confirm** panel and shows a **pending** state until the burn's on-chain commit point resolves, then the position closes (no optimistic success).

### Scope boundary (P0, this story only — PAPER/LOCAL)

- **Network perimeter (binding, strict).** "Live" = **paper/local**: local Postgres, Fastify in-process (`app.inject`), the on-chain paired burn exercised through a **mock EIP-1193 transport / injected seam wallet** (the same precedent as the 5.4 burn tests + the 6.2 subscribe loop), and the `PairBurned` confirmation supplied as a **synthetic confirmed `ChainEvent`**. **Refuse-if-absent on every network secret. Create NO `.env`, NO secret, NO placeholder RPC/address/key.** The REAL Sepolia broadcast is **ops-deferred** (recorded in `deferred-work.md`, story-6.3 section), exactly as 5.4/6.2 deferred their real broadcasts.

- **IN SCOPE:**
  - (a) The redemption composition layer in the existing **`@rose/rose-note`** package (`prod/packages/rose-note`) — the FR-11 mirror of the 6.2 subscription, against the 5.4 burn. It hosts the redemption orchestration `makeRedemptionService(...)`/`redeem(...)` that COMPOSES the already-built seams (it authors NO new ledger/chain/authorization primitive):
    1. reads the existing Rose Note → its embedded coupled pair (`@rose/ledger` `getRoseNote`/`getCoupledPair`; absent ⇒ typed not-found, reusing `RoseNoteNotFoundError`);
    2. checks **capital-flow authorization** (the default-deny `postTransfer` decision) via an INJECTED `BurnAuthorizationGate` — fail-closed: a non-`ALLOW` decision REFUSES before any on-chain write (the irreversible burn must never run ahead of an unrecordable ledger entry, NFR-4). **Note:** FR-19 recipient eligibility is a token-RECEIPT gate (subscription); a redemption RETIRES the holder's tokens and pays cash back, so it does not consult the ONCHAINID-claim allowlist — the chokepoint authorization is the gate that applies;
    3. derives the `BurnLedgerPlan` for the redemption (the token-quantity legs RETIRED + the **VALUE leg that extinguishes `NOTE_LIABILITY`** against the cash paid out) — the INVERSE direction of the 6.2 subscription plan;
    4. drives the **paired burn dual-write** (`@rose/chain` `BurnPairDualWrite` from 5.4) — `start` returns **pending** (SUBMITTED, tx hash), NO ledger entry yet (no optimistic success);
    5. at the **commit point** (the confirmed synthetic `PairBurned`), `confirmFromBurnedEvent` posts **exactly one balanced journal entry** (token quantities RETIRED from the confirmed on-chain `amount` — D3/NFR-9 — holder leg CREDITED, supply contra DEBITED — plus the value postings that extinguish `NOTE_LIABILITY`), idempotent under re-delivery;
    6. exposes a read of the redemption's **pending → confirmed** status derived from the outbox `PAIR_BURN` row (the "pending until commit point" lifecycle the surfaces 6.5/6.6 consume; the position closes on confirm).
  - (b) WRITE endpoints on `@rose/api` branching onto the 6.1 boundary, symmetric to the 6.2 subscription endpoints: `POST /rose-notes/:id/redemptions` (redeem; Zod-validated body; money as integer STRINGS, NFR-2; returns the **pending** redemption resource) and `GET /redemptions/:id` (read the pending/confirmed status). The route calls an INJECTED `RedemptionService` port (`ApiDeps.redemptions?`) — the `@rose/rose-note` concrete impl is injected by the composition root / tests. When the service is not wired (paper mode not composed) the write path is a typed **503** refusal (refuse-if-absent), never an opaque 500.
  - (c) Extend the 6.1 structured-error registry (`@rose/api` `errors.ts`) with the new typed refusal classes this write path raises (`RedemptionPairNotActiveError` ⇒ **409**, `RedemptionIdempotencyConflictError` ⇒ **409**). The capital-flow authorization mapping (`BurnAuthorizationError` DENY ⇒ 403 / REFUSE ⇒ 422 + name-registry 422 fallback) ALREADY exists from 6.1/6.2; `RoseNoteNotFoundError` (404), `UnsupportedPaymentAssetError` (422) are REUSED as-is. Refusals are NEVER collapsed into a generic error; the `code`/`message` name the refusing rule (UX-DR5/NFR-4).
  - (d) The **end-to-end loop proven LOCALLY**: a `@rose/rose-note` test drives (seed a minted position →) redeem → authorize → paired burn (mock chain) → synthetic confirmed `PairBurned` → ONE balanced journal entry (incl. `NOTE_LIABILITY` extinguishment) at the commit point → the position **reflected in the consolidated group view** (`@rose/reconcile` `buildGroupView`, 5.5), with ledger circulating quantity reconciling to the (synthetic) post-burn on-chain supply (NFR-9 — supply ↔ ledger). An `@rose/api` test proves the HTTP contract over `app.inject` (pending → confirmed shape, money as strings, authorization refusal → 403/422, idempotency conflict → 409, service-absent → 503).

- **OUT OF SCOPE (later stories — do NOT implement):** paper/testnet STRATEGY execution (6.4); the React/Vite UI surfaces — Covenant Console (6.5), exchange + subscriber surfaces (6.6), incl. the actual Review→Confirm UI panel (6.3 delivers the BACKEND flow + the pending/confirmed lifecycle the surface consumes, not the rendered panel). Do NOT re-open the Epic-2 issuance contract; do NOT implement reset/settlement P&L crystallization (D1a — the reset mechanics live at epics 5-7, NOT 6.3; 6.3 is a simple redemption: burn the package + extinguish the note liability + balanced ledger entries). Do NOT implement an on-ledger insufficient-balance precondition (the authoritative over-redemption guard is the on-chain `burnPair` revert — Epic 4 — ops-deferred).

- **OUT OF SCOPE (ops, deferred — record in `deferred-work.md` story-6.3):** the REAL Sepolia `burnPair` broadcast + the REAL `PairBurned → confirmFromBurnedEvent` cadence (the 5.4 ops seam); a persisted `redemptions` model richer than the outbox payload (the surfaces' concern, 6.5/6.6); API-level authn/authz (the 6.1-deferred surface/ingress concern); the on-chain over-redemption / insufficient-balance revert that the paper burn stands in for (Epic 4). **NO secret, NO `.env`, NO placeholder.**

## Tasks / Subtasks

- [x] **Task 1 — The redemption `BurnLedgerPlan` derivation incl. `NOTE_LIABILITY` extinguishment (AC: 1)**
  - [x] `prod/packages/rose-note/src/redemption-plan.ts`: `buildRedemptionBurnPlan(input): BurnLedgerPlan` (the `@rose/chain` 5.4 type). It derives, from the caller-supplied account topology (the established `BurnLedgerPlan` caller-supplied-facts trust boundary — the composition layer supplies the concrete accounts, mirroring 6.2's `buildSubscriptionMintPlan`):
    - **token-quantity legs** — both holder accounts are **ASSET-classified** (so the retired quantity reduces ledger circulating quantity and reconciles to the on-chain `totalSupply`, NFR-9 / 5.5), and each supply contra is a **non-ASSET** account (LIABILITY/EQUITY). The 5.4 `makeBurnPairLedgerEffect` posts the holder leg CREDITED and the supply contra DEBITED (the INVERSE of a mint) from the on-chain amount — the plan supplies only the account IDs. **Mirror the topology proven in `prod/packages/chain/src/burn/burn-pair-ledger.test.ts` exactly.**
    - **the VALUE leg (the redemption economics, incl. `NOTE_LIABILITY`)** — the INVERSE of the 6.2 subscription value leg: DEBIT `NOTE_LIABILITY` (extinguish the issued-note obligation) and CREDIT a VCC ASSET cash account (`BACKING_FLOAT` for the outbound cash paid to the redeemer), both in the payment asset, EQUAL amount so the value leg balances per (asset, scale). This is what makes the commit-point entry "touch the appropriate accounts incl. `NOTE_LIABILITY`" (AC-1) — extinguished, not booked.
  - [x] `RedemptionAccountTopology` interface (the redemption mirror of `SubscriptionAccountTopology`); `InvalidRedemptionAmountError extends Error` (non-positive / float amount, NFR-2 — maps to 422). All amounts `bigint` smallest-units. The plan must satisfy the 5.4 `assertPairPlanAccountsDisjoint` guard.

- [x] **Task 2 — The redemption orchestration `makeRedemptionService` (AC: 1, 2)**
  - [x] `prod/packages/rose-note/src/redeem.ts`: a `makeRedemptionService(deps)` factory returning the `RedemptionService` port. `deps` are INJECTED (no connection opened here): `{ db: RoseDb, burn: BurnPairDualWrite, pairAddress, authorize: BurnAuthorizationGate, topology: RedemptionAccountTopology, paymentAsset }`.
  - [x] `redeem(input: RedeemInput): Promise<RedemptionView>` — `input = { roseNoteId, redeemer (address holding BOTH legs), amount (bigint smallest-units), paymentAsset, idempotencyKey }`:
    1. Reject a payment asset other than the service's configured paper asset (`UnsupportedPaymentAssetError`, REUSED, 422).
    2. Resolve the Rose Note → coupled pair (`getRoseNote` → `getCoupledPair`); absent ⇒ `RoseNoteNotFoundError` (REUSED, 404). Refuse a non-`ACTIVE` pair with `RedemptionPairNotActiveError` (the note's pair must be live to redeem — a documented P0 interpretation; 409).
    3. `BurnPairDualWrite.start({ idempotencyKey, coupledPairId, pairAddress, lFrom: redeemer, sFrom: redeemer, amount, authorize })` — the gate runs PRE-submit (fail-closed); on `ALLOW` the burn is submitted through the seam wallet (paper) and the row goes SUBMITTED with a tx hash. Return the **pending** `RedemptionView` (`{ id: idempotencyKey, status: 'pending', roseNoteId, coupledPairId, redeemer, amount, paymentAsset, txHash, journalEntryId: null }`). **No ledger entry, no optimistic success.**
    4. Idempotency conflict (NFR-9): a reused `idempotencyKey` whose recorded `PAIR_BURN` intent does NOT match the request (note/redeemer/amount) fails closed with `RedemptionIdempotencyConflictError` (409) — never hand the caller a DIFFERENT redeemer's position. A matching reuse returns the existing redemption WITHOUT re-broadcasting (the 5.4 `start` `alreadyStarted` guard).
  - [x] `confirm(event: PairBurnedEvent): Promise<RedemptionView | null>` (the commit-point method, driven by the synthetic confirmed event in paper / by `watchPairEvents` in live): builds the plan, delegates to `BurnPairDualWrite.confirmFromBurnedEvent(event, plan)` → ONE balanced journal entry posted at the commit point (incl. `NOTE_LIABILITY` extinguishment), status → `confirmed`. Idempotent (re-delivery ⇒ no-op, the 5.2 saga). **NEVER throws into the (fire-and-forget) watcher** — a malformed event (non-positive amount, divergence) is caught, logged, and surfaced as `null` (the 5.4 `confirmFromBurnedEvent` already swallows divergence; the plan-build throw is caught here, mirroring 6.2's `confirm`).
  - [x] `getRedemption(id): Promise<RedemptionView | null>` — derive `pending`/`confirmed`/`failed` from the outbox `PAIR_BURN` row; return `null` for a non-`PAIR_BURN` row or a payload missing the burn fields (the shared outbox row-kind guard, mirroring 6.2's `viewFromRow`).
  - [x] Structured INFO/WARN logging at the decision points (authorize refuse, submit, commit) with redeemer/note/idempotencyKey/txHash context (CLAUDE.md §11; mirror the 5.4 burn logging).

- [x] **Task 3 — `@rose/rose-note` public surface + index export (AC: 1, 2)**
  - [x] `prod/packages/rose-note/src/index.ts`: export the redemption surface (`makeRedemptionService`, the `RedemptionService`/`RedemptionView`/`RedeemInput`/`RedemptionServiceDeps`/`RedemptionStatus` types, `buildRedemptionBurnPlan`/`RedemptionAccountTopology`/`InvalidRedemptionAmountError`, and the typed refusal classes `RedemptionPairNotActiveError`/`RedemptionIdempotencyConflictError`). No new package, no new external dep (`@rose/chain` already exports `BurnPairDualWrite`/`BurnLedgerPlan`/`BurnAuthorizationGate`/`PairBurnedEvent`; `@rose/reconcile` is the existing test-only devDep).

- [x] **Task 4 — `@rose/api` redemption write endpoints + error-registry extension (AC: 1, 2)**
  - [x] `prod/packages/api/src/schemas.ts`: add `RedeemRequestSchema` (`{ redeemer: EVM_ADDRESS, amount: POSITIVE_INTEGER_STRING (smallest-units), paymentAsset: string, idempotencyKey: string }`), `RedemptionStatusSchema` (`['pending','confirmed','failed']`), `RedemptionSchema` (`{ id, roseNoteId, coupledPairId, redeemer, amount: INTEGER_STRING, paymentAsset, status, txHash?, journalEntryId? }`), `RedemptionIdParamSchema`. REUSE the existing `EVM_ADDRESS`/`POSITIVE_INTEGER_STRING`/`INTEGER_STRING` helpers (money as STRING, NFR-2). Export from `index.ts`.
  - [x] `prod/packages/api/src/routes/redemptions.ts`: `POST /rose-notes/:id/redemptions` (`:id` = roseNoteId UUID-validated; body `RedeemRequestSchema`; calls `deps.redemptions.redeem(...)`; service-absent ⇒ typed `ApiError(503, 'REDEMPTION_SERVICE_UNAVAILABLE', …)`) and `GET /redemptions/:id` (`deps.redemptions.getRedemption(id)` → 200 / structured 404). Mirror `routes/subscriptions.ts`. Register the route module in `app.ts` (after the subscription route).
  - [x] `prod/packages/api/src/app.ts`: add `redemptions?: RedemptionService` to `ApiDeps` (the injected port; type imported from `@rose/rose-note`). NO package.json/tsconfig change (`@rose/api → @rose/rose-note` edge already exists from 6.2).
  - [x] `prod/packages/api/src/errors.ts`: extend `ERROR_REGISTRY` with `RedemptionPairNotActiveError` ⇒ **409** and `RedemptionIdempotencyConflictError` ⇒ **409**. Keep the existing entries (`BurnAuthorizationError` 422 + effect-split, `RoseNoteNotFoundError` 404, `UnsupportedPaymentAssetError` 422 are already present). Add `errors.test.ts` cases for the new mappings.

- [x] **Task 5 — Tests, test-first on the invariants (AC: 1, 2) — LOCAL / PAPER only**
  - [x] `prod/packages/rose-note/src/redemption-plan.test.ts` (pure unit): `buildRedemptionBurnPlan` yields a plan whose token-quantity holder legs are ASSET-classified and supply contras are non-ASSET, whose value leg DEBITs `NOTE_LIABILITY` and CREDITs the cash account for the EXACT redemption amount (balanced per asset — the INVERSE of the subscription plan), and that satisfies the 5.4 disjointness guard. Non-positive / float amount ⇒ `InvalidRedemptionAmountError`. All `bigint` (no float).
  - [x] `prod/packages/rose-note/src/redeem.test.ts` (the END-TO-END loop, LOCAL Postgres + mock chain + synthetic event — the headline proof): using the `@rose/ledger` harness (`createPool`/`createDb`/`hardReset`/`migrateUp`, `TRUNCATE … CASCADE`) and a mock EIP-1193 transport (mirror `prod/packages/chain/src/burn/*.test.ts` + `rose-note/src/subscribe.test.ts`) and a SYNTHETIC confirmed `PairBurnedEvent`:
    - seed the four entities (migration 0001) + the required accounts (the 5.4 burn topology: ASSET token holders, non-ASSET supply contras, VCC `BACKING_FLOAT`/`NOTE_LIABILITY` cash accounts) + a delta-neutral coupled pair (`createCoupledPair`) embedded in a Rose Note (`createRoseNote`) + a **seeded minted position** (a directly-posted balanced mint entry via `recordJournalEntry`, so the holder ASSET balance exists to retire);
    - **redeem** ⇒ `redeem` returns `status:'pending'` with a tx hash and NO new journal entry yet; then `confirm(syntheticPairBurned)` posts EXACTLY ONE balanced journal entry linked to the pair, touching `NOTE_LIABILITY` (assert the postings: holder CREDIT, supply DEBIT, `NOTE_LIABILITY` DEBIT extinguished, cash CREDIT), status → `confirmed`; `buildGroupView` reflects the position and the ledger circulating ROSE quantity equals the synthetic post-burn on-chain `totalSupply` (NFR-9 supply ↔ ledger, no divergence);
    - **authorization DENY/REFUSE gate** ⇒ `BurnAuthorizationError` pre-submit, nothing burned/recorded (NFR-4, fail-closed: no outbox row, no entry);
    - **idempotency** ⇒ a repeated `idempotencyKey` returns the existing redemption, does NOT re-burn (assert `capture.broadcasts === 1`, one outbox row); a reused key with a DIFFERENT request ⇒ `RedemptionIdempotencyConflictError`;
    - **guards** ⇒ absent note ⇒ `RoseNoteNotFoundError`; non-ACTIVE pair ⇒ `RedemptionPairNotActiveError`; unsupported asset ⇒ `UnsupportedPaymentAssetError`;
    - **row-kind guard** ⇒ `getRedemption('<a PAIR_MINT key>')` returns `null` (a subscription row is NOT a redemption);
    - **confirm never throws** ⇒ `confirm(burnedEvent(0n))` returns `null`, posts nothing;
    - **no optimistic success** ⇒ assert the redemption journal entry exists ONLY after `confirm`, never after `redeem`.
  - [x] `prod/packages/api/src/redemptions.test.ts` (Fastify `inject`, the HTTP contract): inject a FAKE `RedemptionService` into `buildApp` to prove the boundary without the chain — `POST /rose-notes/:id/redemptions` returns the pending `RedemptionSchema` (money as strings, NFR-2); `GET /redemptions/:id` returns pending then confirmed; a `BurnAuthorizationError` DENY ⇒ **403** / REFUSE ⇒ **422**; a `RedemptionPairNotActiveError`/`RedemptionIdempotencyConflictError` ⇒ **409**; a malformed body ⇒ **400** (Zod); a missing `deps.redemptions` ⇒ **503** `REDEMPTION_SERVICE_UNAVAILABLE`; the OpenAPI paths are derived from the Zod schemas (amount typed `string`). Extend `errors.test.ts` with the new registry mappings.
  - [x] Baseline to preserve: **Vitest 519** (+ the new rose-note + api tests), **forge 171** unchanged (NO Solidity — paper burn via the existing ABI seam), **migrations 7** unchanged (NO new migration — the redemption reuses rose_notes / coupled_pairs / accounts / journal_entries / postings / outbox_events; redemption status is derived from the outbox `PAIR_BURN` row).

- [x] **Task 6 — Boundary, docs, gates**
  - [x] Dependency graph: NO new edge (the redemption lives inside the existing `@rose/rose-note` package, which already depends on `@rose/chain`/`@rose/ledger`/`@rose/authorization`/`@rose/shared` + the `@rose/reconcile` test-only devDep; `@rose/api → @rose/rose-note` already exists). NO cycle. NO `/throwaway` import. `pnpm check:regime` green.
  - [x] Record the ops-deferred items in `deferred-work.md` (story-6.3 section): the REAL Sepolia `burnPair` broadcast + live `PairBurned` cadence (5.4 seam); a persisted `redemptions` table (surfaces, 6.5/6.6); API authn/authz (6.1 carry-over); the on-chain over-redemption / insufficient-balance revert (Epic 4). NO secret, NO placeholder, NO `.env`.
  - [x] Full gate green: `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format:check` · `pnpm check:regime` · `pnpm check:migrations` (7 reversible, unchanged) · `forge test` (171/171, no Solidity touched). Update `sprint-status.yaml` (6-3 transitions) + File List + Change Log. Touch NO other story.

## Dev Notes

### Architecture-mandated decisions (follow exactly)

- **The redemption composition layer is `@rose/rose-note`; the data flow is `api → rose-note → chain → ledger → reconcile`.** This story adds the redemption mirror of the 6.2 subscription to the EXISTING `@rose/rose-note` package + the `@rose/api` write boundary onto it; the chain/ledger/reconcile/authorization seams already exist (Epics 3–5). [Source: architecture.md line 365; §Project Structure line 319; §Requirements-to-Structure line 357]
- **The on-chain tx is the commit point (NFR-3); paired burn is the redemption mechanism (5.4).** The redemption drives the 5.4 `BurnPairDualWrite`: `start` authorizes (pre-submit, fail-closed) → records the `PAIR_BURN` intent (PENDING) → submits (SUBMITTED, tx hash) — **no ledger entry**; `confirmFromBurnedEvent` is the COMMIT POINT that posts the ONE balanced journal entry from the CONFIRMED on-chain quantity (holder leg CREDITED, supply contra DEBITED — the INVERSE of mint). [Source: chain/src/burn/burn-pair.ts; epics.md Story 6.3]
- **Authorization BEFORE any write, fail-closed (FR-7, NFR-4).** The injected `BurnAuthorizationGate` is the SAME default-deny decision `postTransfer` consults; a non-`ALLOW` decision vetoes the dual-write before the irreversible burn (`BurnAuthorizationError`), so no on-chain retirement is stranded with no recordable ledger entry. **Redemption does NOT consult FR-19 eligibility** — eligibility is the recipient-token-RECEIPT gate (subscription); a redemption RETIRES the holder's tokens and pays cash back, so the chokepoint authorization is the applicable gate. [Source: burn-pair.ts AUTHORIZATION ORDERING; post-transfer.ts; architecture.md line 144]
- **Money is integer smallest-units `bigint` end-to-end; over the wire it is integer STRINGS (NFR-2).** The redemption `amount` is a `bigint` in the orchestration and the ledger; the API request/response carry it as an INTEGER string. NO `number`/`parseFloat`/`toFixed`; NO `bigint` in the JSON. [Source: schemas.ts; CLAUDE.md NFR-2; 6.2 SubscribeRequestSchema]
- **`NOTE_LIABILITY` is the issued-note obligation EXTINGUISHED at the VCC.** The commit-point entry's VALUE leg DEBITs `NOTE_LIABILITY` (extinguishing the credit-normal obligation as the note is bought back) and CREDITs a VCC ASSET cash account (the cash paid out to the redeemer) — the exact INVERSE of the 6.2 subscription value leg (which DEBITed cash, CREDITed `NOTE_LIABILITY`). The token-quantity holder legs are ASSET-classified so ledger circulating quantity reconciles to on-chain `totalSupply` (5.5 divergence ⇒ none when consistent, NFR-9 — supply ↔ ledger). [Source: ledger ENTITY_ALLOWED_ACCOUNT_TYPES; reconcile ACCOUNT_NAV_CLASSIFICATION; burn-pair-ledger.test.ts topology; subscription-plan.ts (the mirror)]
- **Refuse-if-absent on network secrets; paper/local only.** No `.env`, no key, no RPC, no placeholder. The burn is exercised through the mock EIP-1193 transport / injected seam wallet and a synthetic confirmed `PairBurned`, exactly as 5.4/6.2 proved their flows LOCALLY. The real broadcast is ops-deferred. [Source: deferred-work.md story-5.4/6.2; CYCLE-BRIEF network perimeter]
- **Injected ports — the package opens no connection.** `makeRedemptionService(deps)` takes the `RoseDb`, the `BurnPairDualWrite`, the `pairAddress`, the `authorize` gate, the topology, and the payment asset as INJECTED deps; `@rose/api`'s `buildApp` takes the `RedemptionService` as an optional injected port (`ApiDeps.redemptions?`). Everything is exercised in-process. [Source: api/src/app.ts ApiDeps.subscriptions precedent; rose-note/src/subscribe.ts]
- **Naming.** Files `kebab-case.ts`; types `PascalCase`; funcs/vars `camelCase`; consts `UPPER_SNAKE_CASE`. Factory verbs `makeRedemptionService`/`buildRedemptionBurnPlan` (parallel `makeSubscriptionService`/`buildSubscriptionMintPlan`). [Source: architecture.md naming patterns; 6.2 surface]

### P0 interpretations (documented, not invented scope)

- **Redemption state is derived from the outbox `PAIR_BURN` row — no new table.** The outbox `PAIR_BURN` row already models pending (SUBMITTED) → confirmed (CONFIRMED) with `idempotency_key`, `tx_hash`, and `journal_entry_id`; the redeemer address is in the payload (`lFrom`/`sFrom`) and the note↔pair link is the existing `rose_notes`/`journal_entries.coupled_pair_id`. So `migrations` stays at 7 (unchanged). A richer persisted `redemptions` model is a surfaces concern (6.5/6.6), deferred. [Source: outbox-events schema; burn-pair.ts BurnPairIntent; subscribe.ts viewFromRow precedent]
- **The note's pair must be `ACTIVE` to redeem.** Redeeming against a non-live (PENDING/CLOSED/…) pair is refused with `RedemptionPairNotActiveError` (409). The note + delta-neutral pair pre-exist; redemption RETIRES the holder's position — it does NOT close the note row or re-open the issuance contract. [Source: coupled-pairs lifecycle; subscribe.ts SubscriptionPairNotActiveError mirror]
- **Redemption does NOT consult FR-19 eligibility.** FR-19 gates token RECEIPT (subscription); a redemption retires the holder's tokens, so the ONCHAINID-claim allowlist is not consulted — only the capital-flow chokepoint authorization (default-deny) applies. This is the deliberate asymmetry with 6.2. [Source: epics.md Story 6.3 ACs (no eligibility clause, unlike 6.2 AC-2); architecture.md line 144]
- **No on-ledger insufficient-balance precondition.** Over-redeeming more than the holder owns is rejected on-chain by the `burnPair` revert (Epic 4); the paper burn stands in for it. The ledger double-entry trigger enforces per-asset balance, not non-negativity, so the in-scope guard is the chain's — adding a ledger precondition would duplicate the chain guard and is deferred. [Source: epics.md Story 6.3 "books and chain staying consistent"; deferred-work.md story-6.3]
- **Status code for the absent injected service is 503 (refuse-if-absent), not 500.** When `buildApp` is composed without `redemptions`, the write path returns a typed 503 — the same posture as the 6.2 `SUBSCRIPTION_SERVICE_UNAVAILABLE`. [Source: routes/subscriptions.ts requireService precedent]

### Reuse — do NOT reinvent

- **`@rose/chain`** — `BurnPairDualWrite` (`start` pre-submit authorize → intent → submit; `confirmFromBurnedEvent` = commit point, never throws into the watcher), `OutboxSaga`, `BurnLedgerPlan`/`BurnLegAccounts`/`BurnValuePlan`, `BurnAuthorizationGate`/`BurnAuthorizationDecision`, `BurnAuthorizationError`, `PairBurnedEvent`/`PairBurnedArgs`, `createRoseChainClients`. The redemption COMPOSES these; it adds no new burn primitive. [Source: prod/packages/chain/src/burn/burn-pair.ts; index.ts]
- **`@rose/authorization`** — the `postTransfer`/default-deny decision bound into the `BurnAuthorizationGate` thunk (reuse `makeProviderAuthorizeGate` from 6.2 — its `MintAuthorizationGate` return type is structurally the same `() => { effect, reason }` as `BurnAuthorizationGate`). [Source: rose-note/src/authorize-gate.ts; post-transfer.ts]
- **`@rose/ledger`** — `getRoseNote`/`getCoupledPair` (read the note→pair), `createAccount`/`createCoupledPair`/`createRoseNote`/`recordJournalEntry` (test seeding incl. the seeded minted position), the outbox repo (`findByTxHash`/`findByIdempotencyKey`, `recordIntent`/`recordSubmission`), the `RoseDb`/`OutboxEventRow`, the DB harness. [Source: ledger/src/repositories/*; db.ts]
- **`@rose/reconcile`** — `buildGroupView(db, { chainSupplies? })` proves the position is reflected and the ledger↔chain quantity reconciles after the burn (NFR-9 — supply ↔ ledger). [Source: reconcile/src/group-view.ts]
- **`@rose/api`** — `buildApp`/`ApiDeps` (add `redemptions?`), `mapErrorToResponse`/`ApiError`/`NotFoundError`/`ERROR_REGISTRY` (extend), the Zod schemas + `EVM_ADDRESS`/`POSITIVE_INTEGER_STRING`/`INTEGER_STRING` helpers, the `routes/subscriptions.ts` route style, the `subscriptions.test.ts`/`errors.test.ts` harness. [Source: prod/packages/api/src/*]
- **`@rose/rose-note` (6.2)** — `makeSubscriptionService`/`buildSubscriptionMintPlan`/`SubscriptionAccountTopology`/`viewFromRow`/idempotency-conflict pattern are the DIRECT mirror; reuse `RoseNoteNotFoundError`/`UnsupportedPaymentAssetError`/`makeProviderAuthorizeGate` as-is. [Source: prod/packages/rose-note/src/{subscribe,subscription-plan,authorize-gate}.ts]

### Files being created / modified (read before editing — preserve existing behavior)

- NEW `prod/packages/rose-note/src/redemption-plan.ts` + `src/redemption-plan.test.ts`.
- NEW `prod/packages/rose-note/src/redeem.ts` + `src/redeem.test.ts`.
- MODIFY `prod/packages/rose-note/src/index.ts` (export the redemption surface).
- NEW `prod/packages/api/src/routes/redemptions.ts` + `prod/packages/api/src/redemptions.test.ts`.
- MODIFY `prod/packages/api/src/app.ts` (ADD `redemptions?: RedemptionService` to `ApiDeps`; register `redemptionRoutes`), `src/schemas.ts` (ADD `RedeemRequestSchema`/`RedemptionSchema`/`RedemptionStatusSchema`/`RedemptionIdParamSchema`), `src/index.ts` (export them), `src/errors.ts` (extend `ERROR_REGISTRY`: `RedemptionPairNotActiveError`→409, `RedemptionIdempotencyConflictError`→409), `src/errors.test.ts` (new mappings).
- MODIFY `_bmad-output/implementation-artifacts/deferred-work.md` — story-6.3 ops section.
- MODIFY `_bmad-output/implementation-artifacts/sprint-status.yaml` — 6-3 transitions; bump `last_updated`. Touch NO other story.
- NO change to `@rose/chain`/`@rose/authorization`/`@rose/ledger`/`@rose/reconcile` SOURCE, the migrations/schema (NO new migration), package.json/tsconfig (no new dep/edge — chain burn + api→rose-note already wired), `pnpm-lock.yaml`, or `prod/contracts` (no Solidity ⇒ forge stays 171).

### Testing standards summary

- **Vitest** (`vitest run`), tests co-located `*.test.ts`; package tsconfig must NOT exclude `*.test.ts`. Test-first on the invariants (NFR-6): authorize-before-write (NFR-4), NO optimistic success (entry only at commit), balanced entry incl. `NOTE_LIABILITY` extinguishment (AC-1), idempotency / NFR-9, ledger↔chain quantity reconciliation in the group view (supply ↔ ledger), confirm-never-throws, row-kind guard.
- **LOCAL / PAPER only — no Sepolia, no network port, no key.** DB hits the local docker Postgres (5544), `fileParallelism:false`. The on-chain burn uses a mock EIP-1193 transport; the confirmation is a SYNTHETIC `PairBurnedEvent`. The HTTP layer is exercised via `app.inject`. NO `.env`, NO secret.
- Baseline to preserve: **Vitest 519**, **forge 171**, **migrations 7** (no new migration; no Solidity).

### Project Structure Notes

- The redemption lives inside the EXISTING `@rose/rose-note` package — no new package, no new edge, no `pnpm-lock.yaml` change. `@rose/api` already depends on `@rose/rose-note` (6.2). No cycle (rose-note never imports api). Regime boundary: PROD only; no `/throwaway` import. `pnpm check:regime` backstops this.

### Anti-patterns to avoid (disaster prevention — carried from 5.x/6.1/6.2 reviews)

- Do NOT post the ledger entry at `redeem`/submit time — the commit point is the confirmed `PairBurned` ONLY (no optimistic success; NFR-3). The entry exists ONLY after `confirm`.
- Do NOT consult authorization AFTER the burn — it is a fail-closed gate BEFORE any on-chain write (refusing after the chain burns strands a real retirement with no recordable entry, NFR-9).
- Do NOT serialize the `amount` as a JS `number`/float or let a `bigint` escape into the JSON — integer smallest-units `bigint` internally, INTEGER string over the wire (NFR-2).
- Do NOT collapse the authorization refusal into a generic error — DENY→403 / REFUSE→422 with the named reason (UX-DR5).
- Do NOT make the token-quantity supply contra an ASSET account (it would net the holder's circulating quantity and falsely diverge from on-chain supply) — supply contra is non-ASSET; holder is ASSET (mirror the 5.4 burn-effect topology).
- Do NOT invert the value leg wrongly — redemption EXTINGUISHES the note: DEBIT `NOTE_LIABILITY`, CREDIT cash (the INVERSE of subscription). Getting this backwards would re-book the liability instead of retiring it.
- Do NOT add a migration / new table — the redemption reuses existing state and derives status from the outbox `PAIR_BURN` row.
- Do NOT give `@rose/api` a direct `@rose/chain`/`viem` edge — the chain edge lives inside `@rose/rose-note`.
- Do NOT create any `.env`/secret/placeholder RPC/address/key — paper/local via mock transport + synthetic event; real broadcast is ops-deferred.
- Do NOT implement strategy (6.4) or any UI surface (6.5/6.6) — including the rendered Review→Confirm panel; 6.3 delivers the backend flow + the pending/confirmed lifecycle the surface consumes.
- Do NOT consult FR-19 eligibility on redemption — that is the subscription's recipient gate; redemption applies only the capital-flow chokepoint authorization.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-6.3 (lines 740-755); Epic 6 overview (line 698); FR-11 (line 52, 165)]
- [Source: _bmad-output/planning-artifacts/architecture.md — §Data Flow line 365 (`api → rose-note → chain → ledger → reconcile`); §Project Structure line 319 (`rose-note/`); eligibility line 144; money boundary line 345]
- [Source: prod/packages/chain/src/burn/burn-pair.ts — `BurnPairDualWrite`/`BurnLedgerPlan`/`BurnAuthorizationGate`/`makeBurnPairLedgerEffect`/`PairBurnedEvent`/`BurnAuthorizationError`/`BurnQuantityDivergenceError`; index.ts]
- [Source: prod/packages/chain/src/burn/burn-pair-ledger.test.ts — the burn ledger topology (holder ASSET CREDIT, supply non-ASSET DEBIT, value movement)]
- [Source: prod/packages/rose-note/src/{subscribe,subscription-plan,authorize-gate}.ts — the 6.2 subscription this story MIRRORS against the burn]
- [Source: prod/packages/api/src/{app,schemas,errors,routes/subscriptions}.ts + subscriptions.test.ts/errors.test.ts — the boundary + the symmetric endpoints/registry/test harness]
- [Source: prod/packages/reconcile/src/group-view.ts — `buildGroupView` (NFR-9 supply ↔ ledger reflection)]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md — story-5.4 (real burn broadcast), story-6.2 (the subscription mirror's ops deferrals)]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- The full redeem loop is proven LOCALLY: the paired burn broadcasts through a mock EIP-1193 transport (the 5.4/6.2 `mockWriteProvider` pattern — real viem sign/encode, NO network) so `BurnPairDualWrite.start` returns the deterministic `SENT_HASH`, and the commit point is driven by a SYNTHETIC `PairBurnedEvent` carrying that hash. Local docker Postgres (port 5544) for the ledger; Fastify `app.inject` for the HTTP contract. NO Sepolia, NO listen port, NO key, NO `.env`.
- The redeem e2e seeds a pre-existing minted position (INITIAL = 20 000 on each leg) via a directly-posted balanced mint entry (`recordJournalEntry`), then redeems AMOUNT = 10 000. The seed entry carries NO tx hash; the burn entry is tx-hash-stamped — so the redemption entry is isolated by `WHERE tx_hash = SENT_HASH`. After the burn: holder ASSET net = INITIAL − AMOUNT, supply contra net = −(INITIAL − AMOUNT), `NOTE_LIABILITY` (EUR) extinguished from −INITIAL to −(INITIAL − AMOUNT), cash net = INITIAL − AMOUNT. `buildGroupView` reconciles ledger circulating == the synthetic post-burn `totalSupply` (NFR-9, `anyDivergence: false`).
- Account topology mirrors the 6.2 subscription exactly (token-quantity HOLDERS ASSET-classified — `COIN_ISSUER BACKING_FLOAT` for ROSE_L/ROSE_S; SUPPLY contras non-ASSET — `VCC NOTE_LIABILITY`/`VCC CLIENT_COLLATERAL`; VALUE leg `VCC BACKING_FLOAT` (EUR) + `VCC NOTE_LIABILITY` (EUR)), so a mint→burn round-trips and reconciles.
- `redeem.ts` reuses `RoseNoteNotFoundError`/`UnsupportedPaymentAssetError` from `subscribe.ts` (no duplication) and resolves the note id for the `RedemptionView` via `roseNotes.coupledPairId` (1:1 embedding). `@rose/api` gains NO new dep/edge — the redemption lives in the existing `@rose/rose-note` package and `@rose/api → @rose/rose-note` was wired in 6.2.

### Completion Notes List

- **AC-1 (redeem → paired burn → balanced entry incl. `NOTE_LIABILITY` extinguishment; supply ↔ ledger):** `@rose/rose-note` `makeRedemptionService` composes the existing seams into the FR-11 redemption loop — read the pre-existing note→pair, check capital-flow authorization (default-deny, pre-write), drive the 5.4 `BurnPairDualWrite`. At the on-chain commit point ONE balanced journal entry is posted, linked to the coupled pair, capturing the four token-quantity postings RETIRED (holder CREDIT, supply DEBIT — the inverse of mint, from the confirmed on-chain `amount`, D3/NFR-9) + the VALUE leg (`NOTE_LIABILITY` DEBIT extinguished, cash CREDIT paid out). `buildRedemptionBurnPlan` derives the plan (holder=ASSET, supply=non-ASSET, value extinguishes `NOTE_LIABILITY`). Proven against local Postgres (`redeem.test.ts`): exactly one tx-hash-stamped burn entry, 6 burn postings, the EUR `NOTE_LIABILITY` extinguished by the redemption amount, the on-chain tx stamped on the entry; `buildGroupView` reflects the position and ledger circulating == synthetic post-burn on-chain supply (NFR-9, no divergence).
- **AC-2 (pending until commit; no optimistic success):** `redeem` returns `status: 'pending'` with the submitted tx hash and NO new journal entry — the burn entry is posted ONLY at `confirm` (asserted: no tx-hash-stamped entry after redeem, exactly one after confirm). `getRedemption` reads pending → confirmed (the position closes) from the outbox `PAIR_BURN` row. The rendered Review→Confirm UI panel is the 6.5/6.6 surface concern (backend flow + lifecycle delivered here).
- **Authorization (chokepoint, fail-closed pre-write, NFR-4):** the injected `BurnAuthorizationGate` (the SAME default-deny `postTransfer` decision) runs PRE-submit; a non-`ALLOW` decision throws `BurnAuthorizationError` before any on-chain burn — nothing written (no outbox row, no entry). **Deliberate asymmetry with 6.2:** redemption does NOT consult FR-19 eligibility (that gates token RECEIPT; a burn retires the holder's tokens), proven by a test redeeming from a non-allowlisted address.
- **API boundary:** `POST /rose-notes/:id/redemptions` (Zod-validated body, `amount` as a positive smallest-units STRING NFR-2, returns the pending `RedemptionSchema`) + `GET /redemptions/:id` branch onto the 6.1 typed boundary via the injected `RedemptionService` port (`ApiDeps.redemptions?`). Refusals surface through the 6.1 `mapErrorToResponse` (extended registry): authorization DENY → **403** / REFUSE → **422** (the existing effect split, now exercised for `BurnAuthorizationError`), lifecycle/idempotency conflict → **409** (`RedemptionPairNotActiveError`/`RedemptionIdempotencyConflictError`), not-found → **404** (`RoseNoteNotFoundError`), unsupported asset → **422**, malformed body → **400** (Zod), service-absent → **503** `REDEMPTION_SERVICE_UNAVAILABLE` (refuse-if-absent). The OpenAPI document is derived from the new Zod schemas (the redemption `amount` is typed `string`). Proven via `app.inject` with a fake service (`redemptions.test.ts`).
- **Idempotency / NFR-9:** a retried `idempotencyKey` returns the existing redemption and does NOT re-broadcast (one outbox row, one burn — asserted via `capture.broadcasts === 1`); a reused key with a DIFFERENT request fails closed with `RedemptionIdempotencyConflictError` → 409 (no silent stranger-position). `confirm` NEVER throws into the (fire-and-forget) watcher — a malformed event (non-positive on-chain amount) returns `null` and posts nothing.
- **No new migration / no Solidity:** redemption state is derived from the existing outbox `PAIR_BURN` row + `rose_notes`/`journal_entries`; migrations stay at 7, forge stays 171. NO new package, NO new dep/edge (the redemption lives in the existing `@rose/rose-note`, which already depends on `@rose/chain`'s burn surface).
- **Gate:** Vitest **519 → 553** (+34: rose-note redemption-plan/redeem + api redemptions + errors), `pnpm typecheck`/`lint`/`format:check`/`check:regime` green, `pnpm check:migrations` 7 reversible (unchanged), `forge test` 171/171 (no Solidity touched). TESTS REMAIN LOCAL/PAPER — local Postgres + mock EIP-1193 + synthetic `PairBurned`; NO Sepolia, NO key, NO `.env`, NO placeholder.
- **Interfaces for 6.4→6.6:** `@rose/rose-note` `makeRedemptionService`/`RedemptionService`/`RedemptionView`/`RedeemInput` (the surfaces 6.5/6.6 consume the pending/confirmed lifecycle and drive the position-closing redemption); `buildRedemptionBurnPlan`/`RedemptionAccountTopology` (the caller-supplied topology pattern); the `@rose/api` `RedeemRequestSchema`/`RedemptionSchema` + `ApiDeps.redemptions` injected port + the extended error registry (the surfaces consume the OpenAPI-typed JSON).

### File List

**New — `@rose/rose-note`:**

- `prod/packages/rose-note/src/redemption-plan.ts` (`buildRedemptionBurnPlan`, `RedemptionAccountTopology`, `InvalidRedemptionAmountError`)
- `prod/packages/rose-note/src/redeem.ts` (`makeRedemptionService`, `RedemptionService`/`RedemptionView`/`RedeemInput`/`RedemptionServiceDeps`/`RedemptionStatus`, `RedemptionPairNotActiveError`, `RedemptionIdempotencyConflictError`)
- `prod/packages/rose-note/src/redemption-plan.test.ts` (pure unit)
- `prod/packages/rose-note/src/redeem.test.ts` (e2e — local Postgres + mock EIP-1193 + synthetic `PairBurned`; seeded minted position + group-view reflection + NFR-9)

**New — `@rose/api`:**

- `prod/packages/api/src/routes/redemptions.ts` (`POST /rose-notes/:id/redemptions`, `GET /redemptions/:id`)
- `prod/packages/api/src/redemptions.test.ts` (Fastify `inject` HTTP contract with a fake service)

**Modified — `@rose/rose-note`:**

- `prod/packages/rose-note/src/index.ts` (export the redemption surface)

**Modified — `@rose/api`:**

- `prod/packages/api/src/app.ts` (ADD `redemptions?: RedemptionService` to `ApiDeps`; register `redemptionRoutes`)
- `prod/packages/api/src/schemas.ts` (ADD `RedeemRequestSchema`, `RedemptionSchema`, `RedemptionStatusSchema`, `RedemptionIdParamSchema`)
- `prod/packages/api/src/index.ts` (export the new schemas)
- `prod/packages/api/src/errors.ts` (extend `ERROR_REGISTRY`: `RedemptionPairNotActiveError`/`RedemptionIdempotencyConflictError`→409, `InvalidRedemptionAmountError`→422)
- `prod/packages/api/src/errors.test.ts` (new registry-mapping cases incl. the `BurnAuthorizationError` effect split)

**Modified — artifacts:**

- `_bmad-output/implementation-artifacts/deferred-work.md` (story-6.3 ops-deferred section)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (6-3 transitions)

## Change Log

| Date       | Version | Description                                 | Author |
| ---------- | ------- | ------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev | Amelia |
| 2026-06-16 | 0.2     | Implemented the live (paper/local) Rose Note redemption as the INVERSE mirror of the 6.2 subscription in the existing `@rose/rose-note` package (`makeRedemptionService`: default-deny capital-flow authorization pre-write → 5.4 paired-burn dual-write → on-chain commit point posts ONE balanced journal entry RETIRING the quantity + EXTINGUISHING `NOTE_LIABILITY`, idempotent NFR-9, no optimistic success, confirm-never-throws) + `@rose/api` write endpoints (`POST /rose-notes/:id/redemptions`, `GET /redemptions/:id`) via an injected `RedemptionService` port, money as strings (NFR-2), extended structured-error registry. Proven END-TO-END LOCALLY (local Postgres + seeded minted position + mock EIP-1193 + synthetic `PairBurned`; group-view reflection + ledger↔chain supply reconciliation). NO Sepolia, NO port, NO secret. Vitest 519→553, forge 171 unchanged, migrations 7 unchanged; full gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial lenses: Blind Hunter [diff-only], Edge-Case Hunter [live Postgres probing], Acceptance Auditor [AC/spec]). Acceptance: full PASS on AC-1/AC-2 (UI Review→Confirm panel correctly deferred to 6.5/6.6). 1 finding STRENGTHENED with a live-Postgres regression test: a divergent `confirm` (on-chain amount != recorded intent) surfaces a still-PENDING view and posts NOTHING (the 5.4 anomaly + reconcile-5.6 hand-off) — behaviour was correct, now locked. Documented design decisions: redemption does NOT consult FR-19 eligibility (token-receipt gate, not a burn — proven by a non-allowlisted-redeemer test); no on-ledger insufficient-balance precondition (the on-chain `burnPair` revert is authoritative, deferred); any `PAIR_BURN` row reads as a redemption (P0's only burn path, the 6.2 posture); caller-supplied topology classification unguarded (the `PairLedgerPlan` trust boundary, deferred). Vitest 553→554, forge 171 unchanged, migrations 7 unchanged; full gate green; status → done | Amelia |

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (1 finding strengthened with a regression test; no unresolved High/Med correctness defect; the redemption is a tight, well-bounded INVERSE mirror of the reviewed 6.2 subscription)

Three adversarial lenses ran against the Story-6.3 diff. The **Acceptance Auditor** (diff + story spec + epics/architecture) returned a full PASS: AC-1 (a holder redeems → the 5.4 paired burn is driven → ONE balanced journal entry RETIRING the token quantity holder-CREDIT/supply-DEBIT from the confirmed on-chain amount, D3/NFR-9, and EXTINGUISHING `NOTE_LIABILITY` is posted at the on-chain commit point; chokepoint authorization + segregation respected via the pre-write default-deny gate + `createAccount` routing rules; the position is reflected in `buildGroupView` with ledger circulating == the synthetic post-burn on-chain supply, NFR-9 supply ↔ ledger), and AC-2 (pending until the on-chain commit point with no optimistic success; the position closes on confirm — the rendered Review→Confirm UI panel is correctly the 6.5/6.6 surfaces' concern). The **Blind Hunter** (diff only) and the **Edge-Case Hunter** (live local Postgres, real SQL probing) jointly confirmed the orchestration correctly reuses the 6.2 hardenings (the same `viewFromRow` row-kind guard — now keyed on `PAIR_BURN` + `lFrom`/`amount`; the idempotency-conflict fail-close; the confirm-never-throws try/catch around the plan build; the `BurnAuthorizationError` DENY→403/REFUSE→422 split already in the 6.1/6.2 mapper) and surfaced one edge worth locking:

1. **(Low, strengthened) Divergent confirm surfaces as still-pending, posts nothing.** A confirmed `PairBurned` whose on-chain amount diverges from the recorded intent is caught inside the 5.4 `confirmFromBurnedEvent` (anomaly outcome, row stays SUBMITTED). The redemption `confirm` ignores the outcome and re-reads the row, so it returns a still-`pending` view (never `confirmed`) and posts NO burn entry — the correct reconcile-5.6 hand-off. PROVEN against live Postgres with a regression test (`confirm(burnedEvent(AMOUNT + 1n))` ⇒ pending view, zero tx-hash-stamped entries). No code change needed; behaviour was correct, now locked.

Deliberate design decisions, documented (not defects):

- **Redemption does NOT consult FR-19 eligibility** — eligibility gates token RECEIPT (the 6.2 subscription); a redemption RETIRES the holder's tokens and pays cash back, so only the capital-flow chokepoint authorization applies. Proven by a test that redeems from a non-allowlisted address. This is the intended asymmetry with 6.2 (no eligibility seam injected into the redemption service).
- **No on-ledger insufficient-balance precondition** — over-redeeming is rejected by the on-chain `burnPair` revert (Epic 4, ops-deferred); the ledger double-entry trigger enforces per-(asset,scale) balance, not non-negativity. Adding a ledger precondition would duplicate the chain guard; recorded in `deferred-work.md` story-6.3.
- **Any `PAIR_BURN` outbox row reads as a redemption** — in P0 the only burn path is redemption (the same posture the 6.2 review accepted for `PAIR_MINT` == subscription); the row-kind + payload guard prevents a malformed view, and a richer persisted `redemptions` model is the 6.5/6.6 surfaces' concern (deferred).
- **Caller-supplied topology classification is unguarded** — the established 5.3/5.4 `PairLedgerPlan` caller-supplied-facts trust boundary (a mis-wired composition root would break NFR-9 reconciliation while still posting a balanced entry); persisting a validated canonical leg→account mapping is the recorded Epic-6/5.x deferral.

After the +1 regression test: Vitest **519 → 554** (+35: redemption-plan 3, redeem 15, redemptions 12, errors +5), `pnpm typecheck`/`lint`/`format:check`/`check:regime` green, `pnpm check:migrations` 7 reversible (no new migration), `forge test` 171/171 (no Solidity touched). No residual High/Med correctness risk. TESTS REMAIN LOCAL/PAPER — local docker Postgres + mock EIP-1193 transport + synthetic confirmed `PairBurned`; NO real Sepolia, NO network port, NO key, NO `.env`, NO placeholder; the real `burnPair` broadcast + live `PairBurned` cadence + the on-chain over-redemption revert are recorded as ops-deferred.

## Review Findings

- [x] [Review][Strengthen] Lock the divergent-confirm behaviour (on-chain amount != intent ⇒ still-pending view, nothing posted, reconcile-5.6 hand-off) with a live-Postgres regression test — added [prod/packages/rose-note/src/redeem.test.ts] (Edge-Case Hunter, Low)
- [x] [Review][Document] Redemption does not consult FR-19 eligibility (token-receipt gate, not a burn) — proven by a non-allowlisted-redeemer test + documented in the story P0 interpretations (Acceptance Auditor)
- [x] [Review][Defer] No on-ledger insufficient-balance precondition — the on-chain `burnPair` revert is the authoritative guard (Epic 4) [deferred-work.md story-6.3] (Edge-Case Hunter, Low)
- [x] [Review][Defer] Caller-supplied topology ASSET/non-ASSET classification is unvalidated — the established `PairLedgerPlan` trust boundary; canonical persisted leg→account mapping is the Epic-6/5.x deferral [deferred-work.md story-6.2/6.3] (Edge-Case Hunter, Low)
