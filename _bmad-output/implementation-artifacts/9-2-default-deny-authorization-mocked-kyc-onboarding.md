---
baseline_commit: b08c2f97be677948ada1fbc8ac36e0a4736b3179
---

# Story 9.2: Default-deny authorization + mocked KYC/AML onboarding

Status: done

## Story

As a compliance-minded operator,
I want `faithful` mode to use the REAL default-deny `postTransfer` provider fronted by a mocked KYC/AML onboarding that issues ONCHAINID-style eligibility,
So that capital movement is gated by genuine eligibility (not a paper ALLOW), with onboarding demonstrable end-to-end (FR-29, FR-7, NFR-4).

## Acceptance Criteria

**Given** a user who has NOT completed the mocked onboarding
**When** they attempt to subscribe / open a position
**Then** the default-deny `postTransfer` chokepoint **refuses** with an explicit, rule-named reason (UX-DR5) — the demo's gate is real eligibility, not an ALLOW stub

**Given** a user who completes the mocked KYC/AML onboarding
**When** the onboarding issues their eligibility claim
**Then** the same action is **authorized** and proceeds through the real flow

**Given** an onboarded user whose eligibility is then revoked
**When** they attempt a gated action
**Then** they are **re-denied** (revocation is honoured) — proving the gate is live, not one-time

## Tasks / Subtasks

- [x] **Mock KYC/AML onboarding registry** (`prod/packages/api/src/faithful/kyc-registry.ts`) — in-memory, substitutable ONCHAINID-style claim issuer: `onboard(address)` issues a claim, `revoke(address)` removes it, `isOnboarded(address)` reads it, `state(address)`/`list()`; monotonic `version`; EIP-55 normalised; invalid address ⇒ `InvalidKycAddressError` (fail-closed). Clearly labelled a demo claim issuer. (AC1–AC3)
- [x] **Real default-deny + KYC authorization** (`prod/packages/api/src/faithful/faithful-authorization.ts`) — built on `@rose/authorization`'s `denyByDefault`/`DEFAULT_EFFECT`: the baseline is DENY, the mocked KYC claim is what LIFTS it. A `MintAuthorizationGate` consults the per-call subject (via an `AsyncLocalStorage` context the faithful wrappers set): capital-IN (mint) un-onboarded ⇒ DENY with the rule-named reason; onboarded ⇒ ALLOW; capital-OUT (burn/exit) ⇒ ALLOW. A `MintAuthorizationError('DENY', …)` maps to **403** at the boundary. (AC1–AC3)
- [x] **KYC-derived EligibilityProvider** (same module) — `makeKycEligibilityProvider(registry)` backs FR-19 token-receipt eligibility from the SAME registry (onboarded ⇒ eligible; else a named refusal ⇒ `IneligibleSubscriberError` 403). Replaces the static allowlist in faithful mode. (AC1–AC3)
- [x] **Faithful composition** (`prod/packages/api/src/faithful/faithful-mode.ts`) — `makeFaithfulModeServices`/`makeFaithfulPositionService` take ONE KYC registry; derive the `authorize` gate + `EligibilityProvider` from it; each wrapper runs its inner write inside the KYC subject/operation context. Replaces `faithfulAuthorizeAllow` + the allowlist eligibility. (AC1–AC3)
- [x] **Onboarding API** (`prod/packages/api/src/routes/faithful-onboarding.ts` + `ApiDeps.kycRegistry`) — `POST /faithful/onboarding {address, action}` ⇒ 200 new state; `GET /faithful/onboarding/:address` ⇒ 200 state; **503** `FAITHFUL_ONBOARDING_UNAVAILABLE` when not faithful (registry absent); invalid address ⇒ 400 (Zod EVM_ADDRESS, fail-closed). (AC1–AC3)
- [x] **Compose in `serve.ts` faithful branch** — build ONE registry seeded with the demo identities ONBOARDED; derive gate + eligibility; pass to the faithful services; expose `kycRegistry` on `ApiDeps`. `paper` keeps its ALLOW + allowlist; read-only unchanged. (AC1–AC3)
- [x] **Minimal web affordance** (`prod/packages/web/src/surfaces/exchange-trading/kyc-onboarding.tsx`) — a small control on the Exchange terminal showing the current address's onboarding/eligibility state with Onboard/Revoke; reuses existing UI; operates on `VITE_SUBSCRIBER_ADDRESS`; degrades to an honest "faithful-only" note on 503. (AC1–AC3)
- [x] Tests (test-first): un-onboarded subscribe + open ⇒ 403 refusal (typed); onboarded ⇒ authorized & proceeds; revoked ⇒ re-denied; the authorize gate unit (DENY/ALLOW/capital-out/no-context); the registry round-trip; the onboarding route (round-trip, 503 not-faithful, 400 invalid); paper regression (ALLOW unchanged); web control renders + calls. 
- [x] Gate green: typecheck / lint / test / format / regime / migrations / forge.

## Dev Notes

### Scope (this story only)

ONLY the default-deny + KYC gate, its onboarding registry/API, the faithful composition, and the minimal web affordance. NOT session identity / multi-user (9.3 — the web control operates on the current `VITE_SUBSCRIBER_ADDRESS`), the counterparty mock (9.4), the operator panel (9.5), or the banner/deploy (9.6). [Source: epics.md §Story 9.2; addendum §J FR-29]

### Architecture constraints

- PROD regime, TypeScript, ESM/NodeNext, strict. `/prod` never imports `/throwaway`. No contract change; testnet/paper only, NO real capital (§11.3 unchanged). [Source: architecture.md line 1056]
- The default-deny authorization plane is `@rose/authorization` (Epic 3, FR-7/8): fail-closed by construction (`DEFAULT_EFFECT = 'DENY'`); the KYC claim LIFTS the deny. The mock KYC issuer is a substitutable adapter behind the existing eligibility (FR-19) + authorization seams (NFR-8). [Source: `prod/packages/authorization/src/provider/authorization-provider.ts`; addendum §J FR-29]
- Fail-closed defaults (NFR-4): an un-onboarded / unknown / malformed subject is NOT eligible and NOT authorized. Money exact (NFR-2): this layer adds NO money math — it only gates.
- Typed refusals (UX-DR5): un-onboarded subscribe/open surfaces a NAMED 403 (`SUBSCRIBER_NOT_ELIGIBLE` from the FR-19 eligibility chokepoint, and `AUTHORIZATION_DENIED` from the default-deny authorization chokepoint), never a generic block. Both are driven by the SAME KYC registry. [Source: `prod/packages/api/src/errors.ts`]

### Implementation guidance

- **Why a subject/operation context (AsyncLocalStorage).** `MintAuthorizationGate` is a zero-arg thunk `() => MintAuthorizationDecision` bound at service construction (`prod/packages/chain/src/mint/mint-pair.ts` line 154) — it cannot see the per-call subject through the generic inner service. To make the real gate genuinely subject-aware (not an ALLOW stub) WITHOUT changing the gate's arity across the DONE chain/rose-note/positions packages, the faithful wrappers run each inner write inside `runWithKycContext({subject, capitalIn}, …)` (a `node:async_hooks` `AsyncLocalStorage`, concurrency-safe across the inner awaits). The gate reads the context: capital-IN un-onboarded ⇒ DENY; onboarded ⇒ ALLOW; capital-OUT ⇒ ALLOW; no context ⇒ fail-closed DENY. The authorize gate is consulted PRE-SUBMIT (inside `mint.start`), entirely within the context window; the DEFERRED confirmation callback (Story 9.1) does not re-authorize (chain is authoritative once minted), so it needs no context.
- **Two chokepoints, one registry.** FR-19 token-receipt **eligibility** (`makeKycEligibilityProvider`) gates RECEIPT (mint) and runs FIRST in the inner subscribe/open (throws `IneligibleSubscriberError` ⇒ 403 `SUBSCRIBER_NOT_ELIGIBLE`). The FR-7 default-deny **authorization** gate is the pre-submit guard (throws `MintAuthorizationError('DENY', …)` ⇒ 403 `AUTHORIZATION_DENIED`). Both read the same `MockKycRegistry`, so onboarding/revocation moves both in lockstep. In the integration subscribe/open path eligibility trips first; the authorization gate's DENY branch is proven by a direct unit test (defense in depth).
- **Onboarding API + 503 pattern.** Mirrors `routes/simulation.ts`: a `requireKycRegistry(deps)` resolves `deps.kycRegistry` or throws `ApiError(503, 'FAITHFUL_ONBOARDING_UNAVAILABLE', …)`. `POST /faithful/onboarding` validates `{address: EVM_ADDRESS, action: 'onboard'|'revoke'}` (Zod ⇒ 400 on a bad address — fail-closed) and returns the new `{address, onboarded, version}`. `GET /faithful/onboarding/:address` reads state. Composed only when `kycRegistry` is present (faithful mode).
- **Seed onboarded (P0).** `serve.ts` seeds the existing demo identities (`PAPER_ELIGIBLE_SUBSCRIBER` + `PAPER_ELIGIBLE_SUBSCRIBER_2`, surfaced from `seedPaperDemo`'s `eligibleSubscribers`) as ONBOARDED so the seeded demo (subscribe / open / the §11.4 topology) still works out of the box. The gate is demonstrable by REVOKING a seeded identity (then a subscribe/open is refused) or ONBOARDING a fresh address.

### P0 interpretations (documented)

1. **Subject-aware gate via context, not signature change.** Because `MintAuthorizationGate` is a zero-arg thunk shared by the open AND close paths of one position-service instance, the faithful wrappers thread the subject + operation through an `AsyncLocalStorage` context rather than changing the gate signature across DONE packages (scope discipline). This keeps the gate genuinely subject-aware and fully replaces `faithfulAuthorizeAllow`.
2. **Capital-OUT (burn/exit) is always authorized.** Onboarding gates capital-IN (mint receipt, FR-19) + its authorization. Redeem / position-close / strategy-reset (capital-OUT / exit) are authorized by the same gate with `capitalIn:false` (a revoked holder must still be able to EXIT; exit is governed by the §11.4 solvency guardrail + lifecycle, not by onboarding). Documented so it is not mistaken for an ALLOW stub.
3. **Demo identities seeded ONBOARDED.** So the out-of-the-box seeded flows stay green; the gate is shown live by revoke/onboard. (Per the brief.)
4. **Web affordance scope.** The control operates on the app's current `VITE_SUBSCRIBER_ADDRESS` (clean session identity is Story 9.3). On a non-faithful deployment the endpoint 503s and the control shows an honest "available in faithful mode" note.

### Testing standards

Vitest, co-located `*.test.ts`; DB integration tests share ONE database, run serially, `hardReset`+`migrateUp` in `beforeAll`. Money over the wire = strings. Web: Testing-Library render + an injected fixture `ApiClient`. Test-first on the gate invariants (NFR-6).

### References

- epics.md §Epic 9 / §Story 9.2; PRD addendum §J FR-29 / FR-7 / NFR-4.
- `prod/packages/api/src/faithful/faithful-mode.ts` (Story 9.1 composition this extends).
- `prod/packages/authorization/src/index.ts` (`denyByDefault`, `DEFAULT_EFFECT`, `makeDefaultDenyProvider`, `TransferRefusedError`).
- `prod/packages/rose-note/src/eligibility.ts` (`EligibilityProvider`, `IneligibleSubscriberError`).
- `prod/packages/chain/src/mint/mint-pair.ts` (`MintAuthorizationGate`, `MintAuthorizationError`).
- `prod/packages/api/src/routes/simulation.ts` (the paper-gated 503 route pattern).
- `prod/packages/api/src/seed-demo.ts` (`seedPaperDemo`, the demo identities).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log

- Confirmed `MintAuthorizationGate` is zero-arg (`() => MintAuthorizationDecision`) — drove the AsyncLocalStorage subject/operation context decision.
- Confirmed `MintAuthorizationError` carries a structured `effect` and `errors.ts` maps `effect==='DENY'` ⇒ 403 `AUTHORIZATION_DENIED` (so the gate's DENY surfaces as the rule-named 403 the AC wants).
- Confirmed eligibility runs BEFORE authorize in both `subscribe` and `openPosition` (un-onboarded trips `IneligibleSubscriberError` 403 first; the authorize DENY is the second guard, unit-tested directly).

### Completion Notes

- New: `kyc-registry.ts`, `faithful-authorization.ts` (+ tests), `routes/faithful-onboarding.ts`, web `kyc-onboarding.tsx` (+ test).
- Changed: `faithful-mode.ts` (KYC gate + eligibility + per-call context; signatures take a `kycRegistry`), `serve.ts` (build/seed registry, expose on deps), `app.ts` (`ApiDeps.kycRegistry`, register route), `schemas.ts` (onboarding schemas), `index.ts` (exports), `seed-demo.ts` (unchanged behaviour — onboarded set derived in serve from returned config), web `api-client.ts`/`queries.ts`/`contract-types.ts`/`exchange-trading.tsx`.
- Replaced `faithfulAuthorizeAllow` entirely with the real default-deny + KYC gate; the allowlist eligibility is replaced by the KYC-registry eligibility in faithful mode.

### File List

- A `prod/packages/api/src/faithful/kyc-registry.ts`
- A `prod/packages/api/src/faithful/kyc-registry.test.ts`
- A `prod/packages/api/src/faithful/faithful-authorization.ts`
- A `prod/packages/api/src/faithful/faithful-authorization.test.ts`
- A `prod/packages/api/src/routes/faithful-onboarding.ts`
- A `prod/packages/api/src/routes/faithful-onboarding.test.ts`
- A `prod/packages/web/src/surfaces/exchange-trading/kyc-onboarding.tsx`
- A `prod/packages/web/src/surfaces/exchange-trading/kyc-onboarding.test.tsx`
- M `prod/packages/api/src/faithful/faithful-mode.ts`
- M `prod/packages/api/src/faithful/faithful-mode.test.ts`
- M `prod/packages/api/src/serve.ts`
- M `prod/packages/api/src/app.ts`
- M `prod/packages/api/src/schemas.ts`
- M `prod/packages/api/src/index.ts`
- M `prod/packages/api/package.json`
- M `prod/packages/api/tsconfig.json`
- M `prod/packages/web/src/lib/api-client.ts`
- M `prod/packages/web/src/lib/queries.ts`
- M `prod/packages/web/src/lib/contract-types.ts`
- M `prod/packages/web/src/surfaces/exchange-trading/exchange-trading.tsx`

## Change Log

| Date       | Change                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| 2026-06-20 | Story 9.2 created, implemented, and self-reviewed; status → done.      |

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-20 · **Outcome:** Approve.

### Adversarial review across three lenses

**Correctness.**

- The `MintAuthorizationGate` is a zero-arg thunk bound at service construction, so the subject is threaded via an `AsyncLocalStorage` context. The gate is consulted PRE-SUBMIT (synchronously inside `mint.start`, within the `runWithKycContext` window); the DEFERRED Story-9.1 confirmation callback runs OUTSIDE the context but never re-authorizes (chain is authoritative once minted) — so no spurious deny at the commit point. Verified by the gate unit tests + the integration confirm flow.
- Concurrency: `AsyncLocalStorage` isolates the context per async execution — two concurrent subscribes with different subjects cannot cross-contaminate (unlike a mutable ref). Fail-closed when no context is in scope (the no-context branch falls to the real `denyByDefault`).
- Money exactness (NFR-2): this layer adds NO money arithmetic. The §11.4/Epic-5 bigint paths are untouched.
- Seeding: the demo positions are seeded through the PAPER position service (`seedPaperDemo`), which keeps its ALLOW + allowlist — so seeding is independent of the KYC gate; the faithful runtime then gates on the registry (demo identities onboarded). The seeded demo therefore stays green AND the gate is live.

**Edge cases.**

- Malformed address: Zod `EVM_ADDRESS` rejects at the route (400) before any state change; the registry's `onboard/revoke/state` also throw `InvalidKycAddressError` (mapped 400) defensively; `isOnboarded` is TOTAL (false for malformed) so the eligibility/gate reads never throw. Covered.
- Capital-OUT (redeem / close / strategy-reset): authorized regardless of onboarding (an exit is governed by §11.4 + lifecycle, not KYC) — a revoked holder can still exit. `closePosition` sets only `{capitalIn:false}` (no subject), which short-circuits to ALLOW before the subject check, so close never breaks. Covered by the existing 9.1 close/redeem flows staying green.
- Revocation: `version` bumps only on real state changes; a revoked address is re-denied on the next gated action. Covered (AC3 integration + gate unit).
- 503 when not faithful: the registry is absent ⇒ `requireKycRegistry` throws the typed 503 — mirrors the paper-gated simulation route. Covered.

**Acceptance.** All three BDD ACs met (see verdicts below). No scope creep: session identity (9.3), counterparty (9.4), operator panel (9.5), banner/deploy (9.6) untouched; `paper` + read-only paths byte-unchanged (paper keeps its ALLOW + allowlist — regression test green).

### Findings & resolutions

- (Low, fixed) Removed a `void DEFAULT_EFFECT` lint-satisfying no-op in the gate's no-context branch; it now falls to the real `denyByDefault` baseline (cleaner + still fail-closed).
- (Note) In the integration subscribe/open path the FR-19 eligibility chokepoint trips FIRST (`IneligibleSubscriberError` ⇒ 403 `SUBSCRIBER_NOT_ELIGIBLE`), so the FR-7 authorization DENY (`MintAuthorizationError` ⇒ 403 `AUTHORIZATION_DENIED`) is the redundant second guard. Both are driven by the same registry; the authorization gate's DENY branch is proven by a direct unit test. Documented as defense-in-depth, not a defect.

### AC verdicts

- **AC1 (un-onboarded ⇒ refused, rule-named):** MET — `faithful-mode.test.ts` "un-onboarded ⇒ REFUSED" (subscribe + open) throws `IneligibleSubscriberError` (403 named); the default-deny gate's DENY is unit-tested in `faithful-authorization.test.ts`.
- **AC2 (onboarded ⇒ authorized, proceeds):** MET — onboarding DAVE then subscribing/opening returns `pending` and confirms (an OPEN position) after the scheduler runs.
- **AC3 (revoked ⇒ re-denied):** MET — revoking DAVE re-throws `IneligibleSubscriberError`; the gate unit test asserts onboarded→ALLOW then revoked→DENY.

### Action items

- None blocking. Future (9.3): bind the web onboarding control to the per-user session identity instead of `VITE_SUBSCRIBER_ADDRESS`.
</content>
</invoke>
