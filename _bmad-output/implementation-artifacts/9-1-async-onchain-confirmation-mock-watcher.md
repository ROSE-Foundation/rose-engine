---
baseline_commit: edc4563f5f4ed1fd0eee17f75ad75ba75a07476e
---

# Story 9.1: Asynchronous on-chain confirmation (mock watcher with latency + failure)

Status: done

## Story

As a build engineer,
I want a mock confirmation transport that delays the `pending → confirmed` commit point by a realistic, configurable latency and can inject failures,
So that the demo exercises the REAL outbox/saga commit-point, retry, and compensation — not an instant in-process auto-confirm (FR-28, NFR-9).

## Acceptance Criteria

**Given** `ENGINE_MODE=faithful` and a submitted open/close (or subscribe/redeem)
**When** the mock watcher confirms after a configurable delay
**Then** the flow stays `pending` until the delayed commit point, then flips to `confirmed` at the on-chain tx commit (no optimistic success) — the same saga path Epic 5 proves, only time-shifted
**And** the per-flow status reads `pending` during the window and `confirmed` after, observably

**Given** a failure is injected (configurable failure rate or an explicit "fail next" control)
**When** the mock watcher reports the tx failed
**Then** the outbox/saga **compensates** (no half-applied state — no orphaned position, no unbalanced ledger), the flow ends `failed`, and the UI shows an explicit, honest error state — never a silent success

**Given** the latency/failure controls
**When** they are absent or out of range
**Then** they are **refused fail-closed** (a parked trust input is never silently defaulted, NFR-4) — except the documented `faithful` defaults

## Tasks / Subtasks

- [x] Faithful confirmation **settings store** (`prod/packages/api/src/faithful/confirmation-settings.ts`) — in-memory, mutable, fail-closed validated; mirrors `simulation-settings.ts`. Fields: `latencyMs`, `failureRate`, `failNext`; documented `faithful` defaults; bounds; monotonic `version`; programmatic `set`/`reset`/`consumeFailNext`. (AC3)
- [x] Faithful confirmation **transport + scheduler seam** (`prod/packages/api/src/faithful/confirmation-transport.ts`) — a `Scheduler` port (`realScheduler` setTimeout-based + `makeManualScheduler` for deterministic tests) and `FaithfulConfirmationTransport`: schedules the matching confirmed commit point after `latencyMs`; on injected failure drives the EXISTING saga compensation (`saga.fail` → `saga.compensate`) by tx hash. (AC1, AC2)
- [x] Faithful **write-service composition** (`prod/packages/api/src/faithful/faithful-mode.ts`) — `makeFaithfulModeServices` (subscriptions/redemptions/strategy) + `makeFaithfulPositionService` (positions): reuse the SAME library inner services (`makeSubscriptionService`/`makeRedemptionService`/`makeStrategyExecutor`/`makePositionService`) and wrap each freshly-submitted write so the confirmed event is scheduled (or compensated) through the transport instead of the instant paper auto-confirm. (AC1, AC2)
- [x] Compose `ENGINE_MODE=faithful` in `serve.ts` — `isFaithfulModeRequested`, seed via `seedPaperDemo`, real scheduler, shared settings store, faithful write services over the transport; price oracle + simulation settings unchanged; `paper` and read-only paths untouched. (AC1)
- [x] Tests (test-first): deterministic pending→confirmed via manual scheduler; failure→compensation (COMPENSATED, no orphaned position, no unbalanced ledger) asserted via DB; settings fail-closed validation; `paper` unchanged regression. (AC1–AC3)
- [x] Gate green: typecheck / lint / test / format / regime / migrations / forge.

## Dev Notes

### Scope (this story only)

ONLY the async confirmation transport + its faithful composition + its (programmatic) settings. NOT: KYC/authorization (9.2), session identity (9.3), counterparty mock (9.4), the operator UI (9.5), the banner/deploy (9.6). Where those are not present yet, `faithful` simply behaves like `paper` for them (paper ALLOW authorization, the FR-19 allowlist eligibility, the seeded single identity). [Source: epics.md §Story 9.1; addendum §J FR-28]

### Architecture constraints

- PROD regime, TypeScript, ESM/NodeNext, strict. `/prod` never imports `/throwaway`. No contract change (no re-audit); testnet/paper only, NO real capital (§11.3 unchanged). [Source: architecture.md line 1056]
- The mock is a **substitutable adapter behind the existing port** (NFR-8): the outbox/saga commit point (Epic 5). The transport REUSES the existing saga compensation — it invents no new compensation. [Source: addendum §J FR-28; architecture.md line 1056]
- The on-chain tx is the COMMIT POINT (NFR-9): the matching balanced journal entry / position write is posted ONLY at confirmation, never at submit. The faithful transport is the DELAYED, failure-injectable version of the paper instant auto-confirm — the SAME `confirmFrom…Event` path, time-shifted. [Source: `prod/packages/rose-note/src/paper/paper-mode.ts`; `prod/packages/chain/src/outbox/outbox-saga.ts`]
- Money exact (NFR-2): the latency/failure knobs are plain config `number`s, NOT money — no money math is added here. The ledger effects continue to use the proven 5.3/5.4 bigint paths unchanged.

### Implementation guidance

- **Delayed commit point.** Each faithful wrapper calls the inner `make*Service`, takes the returned PENDING view (status `pending`, `txHash` present), reconstructs the SAME confirmed event the paper wrapper synthesizes (from the returned view, or — for strategy resets — from the SUBMITTED outbox row, mirroring `paper-mode.ts`), and hands the transport a job `{ txHash, confirm }`. The transport schedules `confirm()` after `latencyMs`. The wrapper returns the PENDING view unchanged (no optimistic success) — a follow-up `get…` reads `pending` until the scheduled commit point, then `confirmed`. [Source: `paper-mode.ts`; `paper-position-service.ts`]
- **Failure → compensation.** When the transport decides a failure (explicit `failNext` one-shot OR `random() < failureRate`), instead of `confirm()` it looks up the SUBMITTED outbox row by `txHash` (`findByTxHash`) and drives the existing saga `fail` (SUBMITTED → FAILED) then `compensate` (FAILED → COMPENSATED). No ledger effect is ever applied (the commit point never runs), so there is no orphaned position and no unbalanced ledger — whole-or-nothing by construction. The flow's status maps COMPENSATED → `failed` (the existing `statusOf` in subscribe/redeem/strategy/position services). [Source: `outbox-saga.ts` `fail`/`compensate`; `outbox-events.ts` `LEGAL_TRANSITIONS` SUBMITTED→FAILED→COMPENSATED]
- **Scheduler seam.** `Scheduler.schedule(delayMs, task)`. Production binding is `setTimeout`; tests inject a `ManualScheduler` that records tasks and runs them on demand so the delayed commit point is driven deterministically (no real waiting). Scheduled tasks are fire-and-forget; their bodies catch + warn (never throw into the timer).
- **Settings / defaults / fail-closed.** Model the knobs as a small in-memory store mirroring `simulation-settings.ts`: documented `faithful` defaults (`latencyMs` 2000, `failureRate` 0, `failNext` false), inclusive bounds, monotonic `version`, validating `set` (out-of-range/non-finite ⇒ throw `FaithfulConfirmationSettingsError`, never silently clamped or defaulted — NFR-4). Story 9.5 will expose an operator control over this store; this story provides the validated store + a programmatic setter only.
- **Composition.** `serve.ts` gains an `ENGINE_MODE=faithful` branch parallel to `paper`: seed with the SAME `seedPaperDemo`, build ONE settings store + ONE transport (real scheduler), compose the faithful write services + faithful position service over it, keep the price oracle (Lever 1 replay) + simulation settings + read surfaces as in paper. `paper` and read-only branches are byte-for-byte unchanged.

### P0 interpretations (documented)

- **P0-1 — `faithful` authorization/eligibility/identity behave like `paper` for now.** 9.2/9.3 are out of scope, so faithful reuses the paper ALLOW authorize gate + the FR-19 allowlist eligibility + the seeded identity. This is the explicit "where those aren't present yet, faithful behaves like paper" instruction, not scope creep.
- **P0-2 — `latencyMs` minimum is 0.** A 0 ms latency is a valid (degenerate) config — the commit point still fires on a later scheduler turn, preserving the "no optimistic success at submit" contract. The documented default is a realistic 2000 ms.
- **P0-3 — failure decision is taken at schedule time** (once per flow), consuming `failNext` as a one-shot. This matches the AC "fail next" semantics and keeps the decision deterministic per flow.

### Testing standards

- Vitest, co-located `*.test.ts`. DB-integration tests share ONE database, run serially; `createPool`/`createDb`, `hardReset` + `migrateUp` in `beforeAll`, `pool.end()` in `afterAll`. [Source: CYCLE-BRIEF Tests]
- Drive the scheduler deterministically with a manual scheduler — no real `setTimeout` waiting.
- Assert compensation via DB: outbox row COMPENSATED, NO journal entry for the flow's pair beyond the seed, NO position created/flipped.

### References

- `prod/packages/rose-note/src/paper/paper-mode.ts` — the instant auto-confirm this story time-shifts.
- `prod/packages/api/src/paper-position-service.ts` — the instant position auto-confirm.
- `prod/packages/chain/src/outbox/outbox-saga.ts` — `confirm`/`confirmFromEvent` (commit point), `fail`/`compensate` (compensation).
- `prod/packages/api/src/simulation-settings.ts` — the fail-closed in-memory settings store pattern.
- `prod/packages/api/src/serve.ts` — the `ENGINE_MODE=paper` composition branch.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log

- Verified outbox `LEGAL_TRANSITIONS`: SUBMITTED→FAILED→COMPENSATED is legal — the transport's `saga.fail` then `saga.compensate` compensation path is sound.
- Confirmed the commit-point effect is applied ONLY in `confirm`/`confirmFromEvent`; on the failure path it is never invoked, so compensation is whole-or-nothing with no extra guard needed.

### Completion Notes

- Added a substitutable faithful confirmation transport (delay + failure-injection) over the existing Epic-5 saga; `ENGINE_MODE=faithful` composes the same inner write services as paper but time-shifts the commit point and can compensate.
- `ENGINE_MODE=paper` and read-only paths are unchanged (regression-tested: paper still confirms instantly with no scheduler).

### File List

- `prod/packages/api/src/faithful/confirmation-settings.ts` (new)
- `prod/packages/api/src/faithful/confirmation-transport.ts` (new)
- `prod/packages/api/src/faithful/faithful-mode.ts` (new)
- `prod/packages/api/src/faithful/confirmation-settings.test.ts` (new)
- `prod/packages/api/src/faithful/faithful-mode.test.ts` (new)
- `prod/packages/api/src/serve.ts` (modified — `isFaithfulModeRequested` + the `ENGINE_MODE=faithful` branch + top doc comment)

(No `index.ts` change: the faithful seam is infrastructure composed in `serve.ts`, exactly like the paper composition — it is not part of the public `@rose/api` surface.)

## Senior Developer Review (AI)

Reviewer: Amelia (adversarial code review — correctness / edge cases / acceptance).

### Correctness

- The commit point is REUSED, not re-implemented: each faithful wrapper reconstructs the SAME confirmed event the paper wrapper synthesizes and drives the SAME `confirmFrom…Event` path — only time-shifted via the scheduler. The failure path reuses `OutboxSaga.fail` + `.compensate` (no new compensation invented). Verified the outbox `LEGAL_TRANSITIONS` permit SUBMITTED→FAILED→COMPENSATED.
- Whole-or-nothing holds by construction: the ledger effect runs ONLY inside `confirm`; on the failure path `confirm` never runs, so no journal entry posts and no position is created/flipped. Asserted via DB in three flows (subscribe-fail, open-fail, close-fail).
- No optimistic success: wrappers return the PENDING view unchanged; `scheduler.pending === 1` after submit and a GET reads `pending` until the scheduler is driven.
- Money exactness (NFR-2) untouched: the latency/failure knobs are plain config `number`s; all amounts flow as `bigint` through the unchanged 5.3/5.4 paths.

### Edge cases considered

- `latencyMs = 0` is a valid degenerate config (P0-2) — the commit point still defers to a later scheduler turn, preserving "no optimistic success at submit".
- `failNext` is a one-shot consumed at schedule time (short-circuit before the `failureRate` dice), affecting exactly one flow; `consumeFailNext` does not bump `version`.
- Compensation is idempotent: `compensate` no-ops unless the row is still SUBMITTED (a re-delivered/late failure cannot double-compensate or clobber a CONFIRMED row).
- `paper` and `faithful` are mutually exclusive (paper checked first); a `SolvencyGuardrailError` on close is thrown pre-submit and propagates untouched (never reaches the transport).

### Acceptance

- AC1 (delayed commit point, pending→confirmed, observable) — MET (subscribe + position open/close deterministic-scheduler tests).
- AC2 (failure → saga compensation, ends `failed`, no half-applied state) — MET (subscribe-fail, open-fail, close-fail; outbox COMPENSATED + DB assertions; failureRate=1 path).
- AC3 (latency/failure fail-closed, except documented defaults) — MET (settings store validation tests).

### Action items

- None blocking. Story 9.5 will expose the operator control over the programmatic settings store + transport built here (the store/transport are already the single source of truth, ready to wire).

## Change Log

- 2026-06-20: Story drafted (ready-for-dev), implemented, and adversarially reviewed (done) — faithful async-confirmation transport + composition + fail-closed settings + tests. Full gate green.
</content>
</invoke>
