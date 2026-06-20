# Sprint Change Proposal — Production-Faithful Demo Mode (mocked externals)

- **Date:** 2026-06-20
- **Author:** Mary (Business Analyst) — Correct Course workflow, Batch mode
- **Status:** DRAFT — awaiting Fabrice's approval
- **Trigger source:** Post-Epic-8 stakeholder direction (Fabrice), raised while exercising the deployed paper-mode app

---

## Section 1 — Issue Summary

**Problem statement.** The deployed POC runs in `ENGINE_MODE=paper`: a useful, safe simulation — but it takes shortcuts that diverge from how the Engine behaves in production. The stakeholder wants the demo to **reflect production-mode operation as closely as possible, using mock adapters where the real external dependency is not wired**, *without ever introducing real capital* (consistent with the PRD's no-accidental-real-money guardrail).

**Issue type:** New requirement emerged from stakeholder (demo fidelity) + light strategic positioning (a near-production demo for board/partners). **Not** a technical failure and **not** a defect in P0.

**Evidence — the paper-mode shortcuts (observed in code this session):**

- **Instant auto-confirmation.** `prod/packages/rose-note/src/paper/paper-mode.ts` synthesizes the confirmed `PairMinted`/`PairBurned` event in-process immediately after submit — production watches real chain events with latency, and can fail/retry/compensate (Epic 5 outbox/saga).
- **Authorization is a paper ALLOW.** `paperAuthorizeAllow` — production uses the FR-7/FR-8 default-deny `postTransfer` chokepoint + ERC-3643/ONCHAINID eligibility (no KYC/AML onboarding is exercised in the demo).
- **Single, baked-in identity.** `VITE_SUBSCRIBER_ADDRESS=0xaaaa…` — one hardcoded owner; no session/login, no multi-user.
- **Mocked price feed.** Sine / directional-change replay oracle (Lever 1) — acceptable as a mock, already provenance/staleness-honest.
- **§8 Q8 counterparty model absent.** The independent single-side close (D1 topology) is fail-closed by the §11.4 guardrail — there is no matched-book/house adapter, so that flow cannot be demonstrated end-to-end.

---

## Section 2 — Epic Impact Assessment

| Check | Finding |
|---|---|
| 2.1 Current epic (Epic 8) completable as planned? | **Yes — untouched.** The change is purely additive; Epic 8 stays `done`. |
| 2.2 Epic-level change | **Add a NEW Epic 9** "Production-Faithful Demo Mode (mocked externals)". No existing epic is modified, removed, or redefined. |
| 2.3 Remaining planned epics impacted? | **None** — the roadmap ended at Epic 8; nothing downstream to disturb. |
| 2.4 Issue invalidates epics / needs new ones? | No invalidation. **One new epic** (Epic 9). |
| 2.5 Resequencing / priority? | Epic 9 runs **after** Epic 8 (sequential). No reordering of existing work. |

---

## Section 3 — Artifact Conflict & Impact Analysis

**3.1 PRD — no conflict; aligned.** The PRD already states "testnet/paper↔real is a gated runtime switch, never a config flip to mainnet/real capital," and frames "live = test funds" honesty. Production-faithful-with-mocks lives *inside* that philosophy. **MVP (P0) is `done` and unaffected** — Epic 9 is a **post-P0 fidelity layer**, an extension, not a scope reduction. *Action-needed:* add a PRD section (proposed **§4.9 Production-Faithful Demo Mode**) + new FRs (FR-28…FR-33).

**3.2 Architecture — mostly composition + mock adapters, little new design.** The seams already exist: substitutable `PriceOracle` (NFR-8), default-deny `Authorization` provider (FR-7/8), the outbox/saga commit-point (Epic 5), ERC-3643 on Sepolia (Epic 4). *Action-needed:* document a new **production-faithful composition** (a distinct `ENGINE_MODE`, e.g. `faithful`) and the mock adapters: an async confirmation transport (latency + failure injection), a default-deny authorization fronted by a mocked KYC/AML onboarding, a session-identity provider, and a **mock counterparty/inventory adapter** (matched-book or house) that satisfies the §11.4 guardrail's contract so the single-side close becomes demonstrable. The real board-gated §8 Q8 model stays deferred.

**3.3 UX — net-new surfaces, reusing components.** Login / user-switcher; a mocked KYC onboarding flow; realistic pending/latency/error states (the Review→Confirm panel already models pending-until-commit); an operator control panel to drive mock events. *Action-needed:* a small UX addendum; reuse existing tokens/components (no new design system).

**3.4 Other artifacts.** Deploy: a new `ENGINE_MODE` value + Railway variable. Testing: E2E for the new async/identity/counterparty flows. Docs: keep the Home "what this POC does" overview current (per the living-description practice). CI/regime guard unaffected.

---

## Section 4 — Path Forward Evaluation

| Option | Verdict | Effort / Risk |
|---|---|---|
| **1. Direct Adjustment** (new stories within existing structure) | **Viable, chosen — as a new Epic 9** | Medium-High / **Low** |
| 2. Potential Rollback | **N/A** — nothing to revert; purely additive | — |
| 3. PRD MVP Review (reduce/redefine) | **Not applicable** — P0 is done & unaffected; this is an extension, not a reduction | — |

**Recommended path: Hybrid — a new Epic 9 (Direct Adjustment at epic granularity) + a light PRD addendum (§4.9, FR-28…) + an architecture composition note.** Rationale: the work is cohesive and substantial enough to warrant its own epic; it is **additive and low-risk** (existing seams, no contract changes/no re-audit, no real capital), and it cleanly preserves P0. Estimated **6 stories**; sequential after Epic 8.

---

## Section 5 — Detailed Change Proposals (edit proposals)

### 5.A — `epics.md`: add to the **Epic List**

```
OLD (end of Epic List):
  ## Epic 8: Secondary-Trading Position Layer …

NEW (append):
  ## Epic 9: Production-Faithful Demo Mode (mocked externals)
  Make the deployed demo reflect PRODUCTION behaviour as closely as possible while
  staying testnet/paper with NO real capital — replacing paper-mode shortcuts with
  mock adapters that honour the real seams: asynchronous on-chain confirmation
  (latency, failure, retry, compensation), default-deny authorization fronted by a
  mocked KYC/AML onboarding (ERC-3643/ONCHAINID-style eligibility), session identity +
  multi-user, a mocked counterparty/inventory adapter unlocking the §11.4 single-side
  close, and an operator control panel to drive prod-like events. Additive; the P0
  architecture, the deployed contracts (no re-audit) and the no-real-money guardrail
  are unchanged.
```

### 5.B — Proposed Epic 9 stories (intents + key ACs; full BDD at create-story)

- **9.1 — Asynchronous on-chain confirmation (mock watcher).** Replace in-process instant auto-confirm with a mock confirmation transport that delays `pending → confirmed` by a realistic, configurable latency and can inject failures → exercising the real outbox/saga retry/compensation and the UI's pending/error states. *(Given a submitted open/close, When the mock watcher confirms after a delay, Then the position flips only at the commit point; When a failure is injected, Then the saga compensates and the UI shows an explicit error — no optimistic success.)*
- **9.2 — Default-deny authorization + mocked KYC/AML onboarding.** Replace paper-ALLOW with the real default-deny `postTransfer` provider, fronted by a mocked onboarding that issues ONCHAINID-style eligibility claims. *(An un-onboarded user is refused with a rule-named reason; an onboarded user passes; revocation re-denies.)*
- **9.3 — Session identity + multi-user.** Replace the baked-in `VITE_SUBSCRIBER_ADDRESS` with a session/login + user-switcher so distinct Subscribers/operators act, each with their own eligibility and positions.
- **9.4 — Mock counterparty/inventory adapter (§8 Q8).** A matched-book / house **mock** satisfying the §11.4 guardrail contract so an independent single-side close (D1 topology) completes via re-assignment instead of being fail-closed — the real board-gated model stays deferred; the mock is clearly labelled.
- **9.5 — Operator control panel for prod-like events.** A surface to inject latency, force a failure, trigger a covenant breach, or introduce a reconciliation divergence — making production-state handling demonstrable on demand.
- **9.6 — Production-faithful composition + honest mode banner + deploy.** A distinct `ENGINE_MODE` (e.g. `faithful`) wiring the mocks above, a clear UI banner stating what is real vs mocked, Railway config, and the Home overview updated to describe the faithful mode. *(Optionally 9.7 — validate the genuine Sepolia testnet path end-to-end as the closest-to-prod composition.)*

### 5.C — `prd.md`: add **§4.9 Production-Faithful Demo Mode** + **FR-28…FR-33** (one FR per story above), under the existing P0/no-real-money philosophy.

### 5.D — `architecture.md`: add a **"Production-Faithful Composition"** note — the new `ENGINE_MODE`, the mock-adapter set, and the explicit statement that the real §8 Q8 counterparty model and any real-capital path remain board-gated/deferred.

### 5.E — `sprint-status.yaml`: add (on approval)

```
  # Epic 9: Production-Faithful Demo Mode (mocked externals)
  epic-9: backlog
  9-1-async-onchain-confirmation-mock-watcher: backlog
  9-2-default-deny-authorization-mocked-kyc-onboarding: backlog
  9-3-session-identity-multi-user: backlog
  9-4-mock-counterparty-inventory-adapter-single-side-close: backlog
  9-5-operator-control-panel-prodlike-events: backlog
  9-6-production-faithful-composition-banner-deploy: backlog
  epic-9-retrospective: optional
```

---

## Section 6 — Implementation Handoff

- **Change scope classification:** **Moderate** — backlog reorganization (a new epic + stories) plus a light PRD/architecture addendum. **Not Major** (no fundamental replan; P0 intact, contracts unchanged), **not Minor** (more than a single direct edit).
- **Routing:**
  - *Architect (light):* finalize the production-faithful composition + mock-adapter contracts (§3.2) — especially the async-confirmation transport and the §8 Q8 mock.
  - *PO / Dev:* land the Epic 9 + story entries in `sprint-status.yaml`; expand each story via `bmad-create-story`.
  - *Dev:* implement story-by-story through the cycle (`bmad-create-story` → `bmad-dev-story` → `bmad-code-review`), or per-seam via `bmad-quick-dev`, committing per story (the established rhythm).
- **Success criteria:** the deployed demo, in the new faithful mode, exhibits asynchronous confirmation with realistic latency + honest failure/compensation, real default-deny authorization gated by a mocked KYC onboarding, multi-user session identity, a working single-side close via the mock counterparty, and an operator panel to drive prod-like states — all with **zero real capital** and **no contract changes**. The mode banner makes "real vs mocked" explicit; the Home overview stays in sync.

---

## Checklist status (Batch run)

- §1 Trigger & context — **Done** (no single trigger story; stakeholder-driven; evidence = the paper-mode shortcuts in code).
- §2 Epic impact — **Done** (add Epic 9; no change to 1–8).
- §3 Artifact conflicts — **Done** (PRD aligned → addendum; architecture → composition note; UX → small addendum; deploy/test/docs → minor).
- §4 Path forward — **Done** (Option 1 as a new epic; Hybrid with light PRD/arch addenda).
- §5 Proposal components — **Done** (this document).
- §6 Final review & handoff — **awaiting approval**; on approval, update `sprint-status.yaml` (§5.E).
