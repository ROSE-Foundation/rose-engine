---
baseline_commit: 8beba739bd3b32f1dcedb36912718ad136904a58
---

# Story 8.6: Solvency guardrail for independent single-side close (gated on §8 Q8)

Status: done

## Story

As a risk owner / steward,
I want an independent single-side close to be fail-closed until the counterparty/inventory model is chosen and shown solvency-preserving,
So that the D1-topology close path can never break solvency or force a wrongful whole-package burn before the §8 Q8 decision lands (FR-25 remainder, §11.4 guardrail).

> **⚠️ Blocking decision (pre-build):** the counterparty / inventory model (matched-book re-assignment vs house/inventory — §8 Q8 / §11.4) must be chosen and shown solvency-preserving **before** the full re-assignment/house behaviour is built. This story ships the **P0-safe guardrail**; the full model remains board-gated (§11.4) and out of P0 build.

## Acceptance Criteria

**AC-1**

**Given** a position whose opposite leg is held by **another** user (the D1 topology)
**When** the holder attempts an **independent single-side close** and the counterparty/inventory model is not yet resolved
**Then** the path is **fail-closed** under the §11.4 solvency guardrail with an explicit, rule-named refusal (UX-DR5) — it does **not** force a whole-package burn of the other holder's leg, and the on-chain package is burned only when **both** sides are released

**AC-2**

**Given** the guardrail is active
**When** the rest of Epic 8 is exercised
**Then** the standard whole-package open/close (Story 8.3), pricing, P&L, terminal, and reconciliation all function — confirming the rest of Option C **does not depend** on the deferred §8 Q8 decision

## Tasks / Subtasks

- [x] **Detect the D1 topology in the close path** (AC-1)
  - [x] Add `findOpposingHolder(executor, coupledPairId, side, owner)` to `position-service.ts` — query the `positions` table for an **OPEN** position on the **same pair** with the **opposite side** owned by a **different owner** (`ne(owner)`); return the opposing `{ id, owner }` or `null`.
  - [x] Opposite-side map `{ LONG → SHORT, SHORT → LONG }`; only OPEN opposing legs count (a CLOSED opposite is not a live counterparty leg); the closer's own opposite-side leg never trips the guardrail (`owner != closer`).
- [x] **Fail-closed refusal at the close-submission seam** (AC-1)
  - [x] Add typed `SolvencyGuardrailError` (rule-named: `§11.4-solvency-guardrail-independent-single-side-close`) carrying `positionId`, `coupledPairId`, `side`, `counterpartyOwner`, `counterpartyPositionId`, `rule` — UX-DR5 explicit, rule-named refusal.
  - [x] In `closePosition`, after the OPEN-lifecycle guard and **before** `deps.burn.start`, call `findOpposingHolder`; if a different user holds the opposite leg, `throw new SolvencyGuardrailError(...)` — **no burn submitted**, the other holder's leg is never touched, the closer's position stays OPEN.
  - [x] Export `SolvencyGuardrailError` from `@rose/positions` (`index.ts` re-exports `position-service.js`).
- [x] **Surface the named refusal at the API boundary** (AC-1, UX-DR5)
  - [x] Register `SolvencyGuardrailError → 409 SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` in `@rose/api` `errors.ts` (name-keyed registry; carries the rule-named message for UX-DR5). No new close endpoint is built (board-gated; out of P0).
- [x] **Tests — TEST-FIRST** (AC-1, AC-2)
  - [x] AC-1: D1 topology (Alice LONG + Bob SHORT on the same pair) — `closePosition` of Alice's leg throws `SolvencyGuardrailError`; **no burn broadcast**; both positions stay OPEN; the refusal is typed + rule-named.
  - [x] AC-1: the closer's own opposite-side leg (same owner holds both sides) does **NOT** trip the guardrail.
  - [x] AC-1: a CLOSED opposite leg does **NOT** trip the guardrail (not a live counterparty leg).
  - [x] AC-2: same-user whole-package close (8.3) is **NOT** blocked — drives the paired burn and confirms `OPEN → CLOSED`.
  - [x] API: `SolvencyGuardrailError → 409` with the stable code (errors.test.ts).
- [x] **Gate green** — typecheck, lint, test, format(+check), check:regime, check:migrations, forge test.

## Dev Notes

### Scope (what this story builds — and explicitly does NOT)

This story ships **only** the P0-safe **fail-closed guardrail** for the independent single-side close in the **D1 topology** (the opposite leg held by **another** user). It does **NOT** build the full **matched-book re-assignment** or **house/inventory** counterparty model — that is **board-gated (§11.4 / §8 Q8)** and **out of P0**. [Source: epics.md §"Story 8.6"; epics.md "Blocking pre-build decision"; architecture.md §Data/Business "Open sub-decision (§8 Q8 / §11.4)" line 186; architecture.md "Deferred … Position counterparty / inventory model (§8 Q8 / §11.4) — BLOCKING solvency decision".]

8.3 implemented ONLY the standard **whole-package / same-user** open & close (`lTo == sTo == owner` for the mint; `lFrom == sFrom == owner` for the burn) and **explicitly deferred** the independent single-side close to this story (`position-service.ts` header "OUT OF SCOPE"; epics.md §8.3 "Out of scope for this story"). This story adds the guardrail in front of that close path — it does not modify the 8.3 whole-package behaviour.

### Documented P0 interpretation of the deferred §8 Q8 decision

The §8 Q8 / §11.4 counterparty/inventory model (matched-book re-assignment vs house/inventory) is a **board-gated, pre-build product/risk decision that is NOT resolved**. P0 interpretation adopted here (documented, not invented scope):

- **Detection of the D1 topology (off-chain signature):** a position's opposite-side leg is "held by another user" iff there exists an **OPEN** position on the **same `coupled_pair_id`** with the **opposite `side`** owned by a **different `owner`**. The closer's own opposite-side leg (same owner) is **not** a counterparty leg; a CLOSED opposite leg is **not** a live counterparty leg. [Source: epics.md §8.6 AC-1 "opposite leg held by another user"; architecture.md line 186 "D1 topology — the opposite leg held by another user".]
- **Guardrail behaviour (fail-closed):** the close-submission seam (`position-service.ts` `closePosition`) **refuses** with a typed, rule-named `SolvencyGuardrailError` **before** any burn is submitted. Because no `burnPair` is ever broadcast for the refused close, the on-chain package is **not** burned — the on-chain package burns **only when BOTH sides are released**, and the other holder's leg is **never** force-burned. [Source: architecture.md line 186 "must not force a whole-package burn of the other holder's leg … package burns only when both sides released … gated by the §11.4 solvency guardrail".]
- **Not built (board-gated, post-decision):** re-assignment of the other holder's leg, a house/inventory counterparty, or any path that would release one side independently. Those land **after** the §8 Q8 decision is chosen and shown solvency-preserving.

### Architecture & implementation constraints

- **Reuse, no new on-chain code:** the deployed coupling contracts are **unchanged / not re-audited**; the atomic-coupling invariant and the `postTransfer` chokepoint are reused, not modified. The guardrail is a **pre-submission off-chain refusal** — it authors no new mint/burn/ledger primitive. [Source: epics.md §Epic 8 "Reuse, no new on-chain code"; architecture.md line 178 "Non-negotiable guardrail".]
- **Fail-closed by construction (NFR-4):** the default on this gated path is **refuse**, surfaced as an explicit, named refusal — never a silent success, never an optimistic close. Mirrors the established `IneligibleSubscriberError` (eligibility) and the `TransferRefusedError` default-deny patterns. [Source: architecture.md "Authorization is fail-closed (NFR-4)" line 269; `prod/packages/rose-note/src/eligibility.ts` (IneligibleSubscriberError / UX-DR5).]
- **UX-DR5 (explicit rule-named refusal):** the typed error names the §11.4 guardrail rule; the API boundary maps it to a **stable machine `code`** (`SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED`) in the `{ error: { code, message } }` envelope so a surface can name the refusing rule. [Source: architecture.md "Error handling standard" line 195; `prod/packages/api/src/errors.ts` (name-keyed registry, UX-DR5 note); `prod/packages/web/src/lib/api-client.ts` `ApiClientError` (UX-DR5).]
- **Seam placement:** the close path lives in `position-service.ts` `closePosition` (8.3). There is **no** `@rose/api` close endpoint yet (8.4 wired GET /positions only; an authoring close route is 8.3/8.4 territory and not in this story's scope). The guardrail therefore lives at the `closePosition` service seam (where the burn is submitted), with the error registered at the API boundary so it surfaces named **if/when** a close route is added. Building a close route here would be scope creep.
- **Money exact (NFR-2):** the guardrail reads only `positions` identity/side/lifecycle columns and submits nothing — no arithmetic; the existing exact-integer money path (8.2/8.3) is untouched.
- **Detection is a read on `deps.db` (not the confirm executor):** the refusal happens at submission time on the service DB handle, mirroring the existing pre-submit checks (`getPosition`, `getCoupledPair`) in `closePosition`.

### Prior-story learnings (Epic 8)

- 8.1 `@rose/price-oracle`: read-only oracle port + `markToMarket`; never writes postings — unaffected. [Source: 8-1 story.]
- 8.2 `@rose/positions` schema/repo: `positions` table NOT NULL FK to `coupled_pairs`, `side` enum `LONG|SHORT`, `lifecycle` enum `OPEN|CLOSED`, leverage pinned 1x; `owner` stored checksummed (open flow uses `getAddress`). The guardrail's owner equality is an exact string compare on the consistently-checksummed stored value. [Source: `prod/packages/positions/src/schema/positions.ts`, `repositories/positions.ts`.]
- 8.3 `position-service.ts`: open → paired mint → commit; close → paired burn → commit; commit point is the on-chain tx (no optimistic success). `findOpenPosition` already keys on (pair, owner, OPEN). The guardrail slots in as a pre-`burn.start` refusal in `closePosition`. [Source: `prod/packages/positions/src/position-service.ts`.]
- 8.4 API: `GET /positions` (+ live marks). Error mapping is the name-keyed `ERROR_REGISTRY` in `errors.ts`; refusals carry their message for UX-DR5. [Source: `prod/packages/api/src/errors.ts`, `routes/positions.ts`.]
- 8.5 reconcile: per-pair/per-side residual-backing — unaffected; AC-2 confirms it still passes. [Source: `prod/packages/positions/src/reconcile.ts`.]

### Testing standards

- Vitest, co-located `*.test.ts`; DB integration tests share ONE Postgres (host port 5544) and run serially; `TRUNCATE … CASCADE` per test; `hardReset` + `migrateUp` in `beforeAll`. Test-first on the invariant (NFR-6). [Source: CYCLE-BRIEF "Tests"; `position-service.test.ts` harness.]
- D1-topology setup uses the repo `createPosition` to seed Alice LONG + Bob SHORT against one ACTIVE pair (the established api-test idiom; avoids the mock-transport same-hash collision of two real mint flows), then drives the **real** `service.closePosition` to assert the refusal + zero burn broadcasts.

### References

- epics.md: §Epic 8 overview (line 917), "Blocking pre-build decision", §Story 8.6 (lines 1027–1043), §Story 8.3 "Out of scope".
- architecture.md: line 186 (Open sub-decision §8 Q8 / §11.4), line 178 (Non-negotiable guardrail), line 195 (Error handling standard), line 269 (fail-closed NFR-4), "Deferred … §8 Q8 BLOCKING solvency decision".
- Patterns: `rose-note/src/eligibility.ts` (typed UX-DR5 refusal), `api/src/errors.ts` (name-keyed registry), `web/src/lib/api-client.ts` (`ApiClientError` code).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log

- TEST-FIRST: added the AC-1 D1-topology refusal + AC-2 not-blocked tests (red) before the guardrail, then implemented `findOpposingHolder` + `SolvencyGuardrailError` + the pre-`burn.start` refusal (green).
- Verified the refused close submits **no** burn (mock `burnCapture.broadcasts === 0`) and leaves both positions OPEN.
- Full gate run from repo root (see Completion Notes).

### Completion Notes

- Guardrail is a pre-submission off-chain refusal in `closePosition`; no on-chain primitive authored, no contract change, no migration.
- Detection: OPEN opposite-side position on the same pair owned by a different user ⇒ `SolvencyGuardrailError` (UX-DR5, rule-named). Same-owner opposite leg and CLOSED opposite leg do not trip it.
- API boundary maps the error to `409 SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` (no new close route built — board-gated/out of P0).
- AC-2 confirmed: whole-package same-user open/close, pricing, P&L, terminal, reconciliation all unaffected (full suite green).

### File List

- `prod/packages/positions/src/position-service.ts` — `SolvencyGuardrailError`, `findOpposingHolder`, the pre-`burn.start` guardrail in `closePosition`.
- `prod/packages/positions/src/position-service.test.ts` — AC-1 / AC-2 guardrail tests.
- `prod/packages/api/src/errors.ts` — registry entry `SolvencyGuardrailError → 409`.
- `prod/packages/api/src/errors.test.ts` — mapping test.
- `_bmad-output/implementation-artifacts/8-6-...md` — this story.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status transitions.

## Change Log

- 2026-06-19: Story created (create-story) — status ready-for-dev.
- 2026-06-19: Implemented the §11.4 solvency guardrail (fail-closed D1 single-side close) test-first; status review.
- 2026-06-19: Senior Developer Review (AI) appended; status done.

## Senior Developer Review (AI)

**Reviewer:** Amelia (AI senior dev) · **Model:** claude-opus-4-8[1m] · **Date:** 2026-06-19 · **Outcome:** Approved (gate green)

### Scope & approach

Adversarial review across three lenses (Correctness / Edge-cases on live Postgres :5544 / Acceptance), focused on the single new behaviour: the §11.4 solvency guardrail fail-closing the D1 independent single-side close. Confirmed NO scope creep — the full matched-book re-assignment / house-inventory model is **not** built (board-gated, §8 Q8, out of P0); no on-chain change; no migration.

### Correctness

- **Truly fail-closed before any burn:** the guardrail is evaluated in `closePosition` AFTER the OPEN-lifecycle guard and BEFORE `deps.burn.start` — so a refused close submits **no** `burnPair`. Tests assert `burnCapture.broadcasts === 0` and `outbox_events === 0` for the refused path: the on-chain package is never burned and the other holder's leg is never force-burned. ✔
- **No single-leg burn slip-through:** the only burn-submission seam is `closePosition`; `confirmClose` runs only in response to an actually-submitted `PairBurned`, which the refused path never produces. No bypass path exists. ✔
- **Typed + rule-named (UX-DR5):** `SolvencyGuardrailError` carries `rule = '§11.4-solvency-guardrail-independent-single-side-close'`, `counterpartyOwner`, `counterpartyPositionId`, and a message naming §11.4 and the both-sides rule; the API boundary maps it to `409 SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED`. ✔
- **Money/precision (NFR-2):** the guardrail reads only identity/side/lifecycle columns and submits nothing — no arithmetic touched. ✔

### Edge-cases (probed against live Postgres :5544 via the integration tests)

- D1 topology (Alice LONG + Bob SHORT, same pair) → refused, both legs stay OPEN. ✔
- Symmetry (closer holds SHORT, other holds LONG) → refused. ✔
- Closer holds BOTH sides (same owner) → NOT tripped (owner-equality excludes own opposite leg). ✔
- CLOSED opposite leg → NOT tripped (only OPEN opposing legs are live counterparties). ✔
- No opposite holder (whole-package) → NOT tripped, paired burn submitted, `OPEN→CLOSED`. ✔

### Acceptance

- **AC-1:** met — D1 single-side close is fail-closed with a typed, rule-named UX-DR5 refusal; no whole-package/single-leg burn; package burns only when both sides release.
- **AC-2:** met — full suite green (916 tests): whole-package open/close (8.3), pricing/P&L (8.1/8.4), terminal, and reconciliation (8.5) all pass with the guardrail active — the rest of Option C does not depend on the deferred §8 Q8 decision.

### Action items / observations

1. **(Low, documented — no change)** Owner equality is an exact string compare. The open path always stores EIP-55-checksummed owners, so this is consistent. A position seeded out-of-band with non-checksummed casing could produce a *false-positive* refusal of a same-user close — which is fail-closed-SAFE (refuses, never wrongly burns). Acceptable; if a Members table lands post-P0, normalise owners at that boundary.
2. **(Info)** No `@rose/api` close route exists yet (board-gated); the registry mapping is forward-wired so the named refusal surfaces correctly the moment a close route is added — intentionally NOT building that route here.

### Final gate (re-run, all green)

typecheck ✔ · lint ✔ · test 916/916 (106 files) ✔ · format + format:check ✔ · check:regime ✔ · check:migrations (up→down→up, 9 migrations) ✔ · forge 171/171 ✔
</content>
</invoke>
