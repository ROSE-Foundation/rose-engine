---
baseline_commit: d6eef4b6bdf3f4a8e3935ad357cfc2b1daacae6e
---

# Story 9.3: Session identity + multi-user

Status: done

## Story

As a Subscriber/operator,
I want a session/login with a user switcher instead of one baked-in address,
So that distinct participants act in the demo, each with their own eligibility and positions (FR-30, FR-14).

## Acceptance Criteria

**Given** `faithful` mode
**When** a participant signs in (mock session) and selects an identity
**Then** the app acts as THAT identity (its EVM address drives positions/eligibility) — replacing the baked-in `VITE_SUBSCRIBER_ADDRESS`; the current identity is always visible

**Given** two distinct signed-in identities
**When** each lists positions / acts
**Then** each sees **only their own** positions and eligibility (no leakage), and an operator identity can see the operator surfaces

**Given** no session
**When** a gated action is attempted
**Then** it is refused with an explicit "sign in first" state (fail-closed), never acting as a default user

## Tasks / Subtasks

- [x] **Mock session/identity context** (`prod/packages/web/src/lib/session.tsx`) — a React context/provider holding the current `Identity` (EVM `address` + display `label` + `role` `subscriber | operator`), persisted to `localStorage`; `signIn` / `signOut` / `switchIdentity`; the selectable demo set (Alice = `0xaaaa…` LONG, Bob = `0xcccc…` SHORT, Olivia = operator) + a custom EIP-55-format address (fresh participant). Clearly labelled a MOCK session in a header comment (real session/ONCHAINID auth deferred). (AC1–AC3)
- [x] **Always-visible identity chip + switcher** (`prod/packages/web/src/components/identity-switcher.tsx`) — a header chip "Signed in as {label} ({0xaaaa…})" with a menu to switch demo identities, sign in a custom address, or sign out; a "Sign in" affordance when signed out. (AC1)
- [x] **Fail-closed gate** (`prod/packages/web/src/components/sign-in-required.tsx`) — an explicit "sign in first" panel rendered in place of the gated surfaces (Exchange, Subscriber) and the operator-only Simulation when no/insufficient identity; renders inline sign-in buttons. NEVER acts as a default address. (AC3)
- [x] **Wire `owner`/`subscriberAddress` to the session** (`prod/packages/web/src/app.tsx`) — replace `resolveSubscriberAddress()` (`VITE_SUBSCRIBER_ADDRESS`) with the session identity's address everywhere: Exchange terminal `owner`, Subscriber `subscriberAddress`, the 9.2 KYC onboarding control. Role-gate the nav (Simulation = operator-only) + the in-terminal operator tools (reconciliation panel + KYC control). (AC1, AC2)
- [x] **Role-gate the operator tools** (`prod/packages/web/src/surfaces/exchange-trading/exchange-trading.tsx`) — a `showOperatorTools` prop (default `true`, backward-compatible) gates the reconciliation panel + KYC onboarding control to operator identities. (AC2)
- [x] **Re-anchor the 9.2 KYC control comment** (`kyc-onboarding.tsx`) — operates on the SESSION identity address (not `VITE_SUBSCRIBER_ADDRESS`). (AC1)
- [x] Tests (test-first): context sign-in/out/switch + persistence; chip renders label/address; signing in A then switching to B changes the `owner` the terminal queries; operator sees the operator nav/tools, a subscriber does not; no session ⇒ "sign in first" and no write-endpoint call with a default address. (AC1–AC3)
- [x] Gate green: typecheck / lint / test / format / regime / migrations / forge.

## Dev Notes

### Scope
WEB-only session/identity layer + wiring + role-gating + the no-session fail-closed state. The per-owner
backend (`GET /positions?owner=`, the per-address KYC/onboarding state of Story 9.2) is ALREADY
multi-user — **no backend change is required** and none was made. Out of scope (later stories): the mock
counterparty (9.4), operator event-injection (9.5), the faithful banner/deploy (9.6).

### Architecture constraints & decisions
- **Mock session, clearly labelled.** Real session/ONCHAINID auth is deferred (addendum §J FR-30; the
  `app.tsx` comment already pointed at deferred-work story-6.6). The context header comment says so
  explicitly. No secret, no real auth — `localStorage` only. [Source: addendum.md §J FR-30]
- **Backend canonicalises the owner.** `prod/packages/api/src/routes/positions.ts` `canonicalOwner()`
  EIP-55-checksums the `owner` query param via viem `getAddress`, so the web may send the lowercase
  demo addresses and reads still match the checksummed stored owner — **isolation is server-enforced
  per address; the web only needs to pass the right address.** [Source: positions.ts:25–35]
- **P0 interpretation — EIP-55 validation is FORMAT-ONLY on the web.** A custom address is validated as
  `/^0x[0-9a-fA-F]{40}$/`; full EIP-55 checksum verification needs keccak256 (the web bundle has no
  crypto dep and the brief says reuse — no new design system / dep). The backend's `getAddress`
  canonicalises + checksum-validates on every call, so a bad checksum is caught server-side. Documented
  as deferred.
- **P0 interpretation — operator tools wiring.** The brief lists the KYC onboarding control among the
  operator surfaces AND says the session address drives it. Resolved: the reconciliation panel + KYC
  control are operator-role-gated (`showOperatorTools`), and the KYC control operates on the *current
  (operator) identity address*. A richer "operator onboards a chosen subscriber" UI is left to the 9.5
  operator panel. The subscriber's eligibility remains **server-enforced** at subscribe/open time (the
  call carries the identity address; the backend's per-address gate decides — no UI ALLOW stub), so
  "each sees only their own eligibility" holds with no leakage because the owner differs per identity.
- **No paper/read-only regression.** `showOperatorTools` defaults to `true`, so existing
  `ExchangeTradingView` tests (which assert the reconciliation panel) are unchanged. The read-only
  dashboards (Treasury, Coupled Coins, Home, Delta Engine) stay open without a session; only the WRITE
  surfaces (Exchange, Subscriber) and the operator Simulation are gated.

### Prior-story learnings
- Story 9.2 added the `KycOnboardingControl` driven by `VITE_SUBSCRIBER_ADDRESS`; this story re-points
  it at the session identity (the comment in 9.2 explicitly anticipated "a clean per-user session is
  Story 9.3"). [Source: kyc-onboarding.tsx:5]
- Web component tests use a per-file `// @vitest-environment jsdom` pragma + `import '../../test/setup.js'`,
  a fresh `QueryClient` (`retry:false`), an `ApiClientProvider` with a `Partial<ApiClient>` mock, and
  `@testing-library/react` + `user-event`. [Source: exchange-trading.test.tsx, kyc-onboarding.test.tsx]

### Implementation guidance
- Context value: `{ identity, identities, signIn, signOut, switchIdentity, isOperator }`. `switchIdentity`
  resolves a known demo identity by address; `signIn` accepts any `Identity` (incl. a custom one).
- Persistence: lazy `useState` initializer reads `localStorage['rose.session.identity']`; an effect
  writes/clears it. SSR-safe (`typeof window` guard). jsdom supplies `localStorage` in tests.
- The chip shows `shortAddress(address)` = `0xaaaa…aaaa` (first 6 + last 4).

### Testing standards
Vitest + Testing Library, co-located `*.test.tsx`, jsdom pragma, fixture-backed `Partial<ApiClient>`.
Assert: the `owner` the terminal sends to `getPositions` follows the active identity; the nav/tools
role gate; the fail-closed "sign in first" state makes NO write call with a default address.

### References
- [Source: epics.md §Story 9.3 — BDD ACs]
- [Source: addendum.md §J FR-30]
- [Source: prod/packages/api/src/seed-demo.ts — demo identities 0xaaaa…/0xcccc…]
- [Source: prod/packages/api/src/routes/positions.ts — canonicalOwner / per-owner isolation]

## Dev Agent Record

### Agent Model Used
claude-opus-4-8[1m]

### Debug Log
- Verified the positions route canonicalises the owner (EIP-55) so lowercase demo addresses match.
- Confirmed `showOperatorTools` default `true` keeps all pre-existing `ExchangeTradingView` tests green.

### Completion Notes
- Added a mock session/identity React context (`session.tsx`), an always-visible header chip + switcher,
  and a fail-closed "sign in first" gate. Wired `owner`/`subscriberAddress`/KYC to the session identity
  in `app.tsx`, replacing `VITE_SUBSCRIBER_ADDRESS`. Role-gated Simulation (nav) + the in-terminal
  reconciliation panel/KYC control. No backend change.

### File List
- ADDED  `prod/packages/web/src/lib/session.tsx`
- ADDED  `prod/packages/web/src/lib/session.test.tsx`
- ADDED  `prod/packages/web/src/components/identity-switcher.tsx`
- ADDED  `prod/packages/web/src/components/identity-switcher.test.tsx`
- ADDED  `prod/packages/web/src/components/sign-in-required.tsx`
- ADDED  `prod/packages/web/src/app.test.tsx`
- CHANGED `prod/packages/web/src/app.tsx`
- CHANGED `prod/packages/web/src/surfaces/exchange-trading/exchange-trading.tsx`
- CHANGED `prod/packages/web/src/surfaces/exchange-trading/kyc-onboarding.tsx` (comment only)
- CHANGED `prod/packages/web/src/lib/queries.ts` (stale `VITE_SUBSCRIBER_ADDRESS` doc-comment only)

## Senior Developer Review (AI)

**Reviewer:** Amelia (adversarial pass — correctness / edge cases / acceptance). **Outcome:** APPROVED.

### Correctness
- **No cross-identity leakage.** `usePositions` keys its query by `['positions', owner, refAsset]`, so a
  switch A→B fires a fresh query for B — A's cached positions are never shown under B. Isolation is also
  server-enforced (`positions.ts canonicalOwner` EIP-55). The integration test asserts every recorded
  `getPositions` owner is exactly A or B (never a mixed/default address).
- **Fail-closed default.** `usePositions`/`useOnboardingState` are `enabled` only when `owner.length>0`;
  and the WRITE surfaces aren't even mounted without a session (`SignInRequired` is rendered instead), so
  no write endpoint is ever called with a default address. Asserted (`getPositions`/`openPosition` not
  called when signed out).
- **Custom address cannot self-promote to operator.** A custom fresh participant is always `subscriber`;
  only the built-in Olivia is `operator`. This is a deliberate fail-safe (no client-side privilege grab).
- **Persistence is defensive.** `readPersistedIdentity` validates address-format + role and tolerates
  malformed JSON (→ signed-out). Asserted.

### Edge cases
- Operator-only Simulation is guarded at BOTH the nav (filtered out for non-operators) and the render
  (`isOperator` guard) so a lingering `surface==='simulation'` after a switch to a subscriber fails closed.
- `showOperatorTools` defaults to `true`, preserving all pre-existing `ExchangeTradingView` tests (which
  assert the reconciliation panel) — verified: full suite 1087 green, no regressions.

### Acceptance
- AC1 (act as selected identity, always-visible chip) — met. AC2 (per-identity isolation + operator
  surfaces) — met. AC3 (no session ⇒ "sign in first", never a default user) — met. Evidence in the
  per-AC verdict + `app.test.tsx`.

### Action items
- None blocking. Deferred (documented P0): real session/ONCHAINID auth; full EIP-55 checksum on the web
  (keccak) — backend canonicalises today. A richer "operator onboards a chosen subscriber" KYC UI is left
  to the 9.5 operator panel.

## Change Log
- 2026-06-20: Story drafted, implemented, tested, reviewed (Story 9.3 — session identity + multi-user).
</content>
</invoke>
