---
baseline_commit: NO_VCS
---

# Story 4.2: Enforce eligibility on transfers in the custom ERC-3643-compatible token

Status: done

## Story

As a transfer-agent,
I want a custom ERC-3643-compatible token whose transfers require a valid eligibility claim,
so that tokens can only be held/transferred by identity-verified, eligible holders (FR-19).

## Acceptance Criteria

**AC-1 — A transfer to a recipient with no valid ONCHAINID claim is rejected on-chain**
**Given** the deployed custom token referencing the `IdentityRegistry` (Story 4.1)
**When** a token transfer (or `transferFrom`, or `mint`) targets a recipient who is not `isVerified` (unregistered, no required claim, untrusted issuer, or revoked claim)
**Then** the transfer is rejected on-chain (the call reverts; no balance changes)

**AC-2 — A compliant transfer between an eligible sender and eligible recipient succeeds; Foundry tests (incl. fuzz) cover allowed and rejected paths**
**Given** an `isVerified` sender and an `isVerified` recipient
**When** a compliant transfer is made
**Then** it succeeds and balances update
**And** Foundry tests — including at least one fuzz test — cover BOTH the allowed path and the rejected path, and `forge test` is green

## Tasks / Subtasks

- [x] **Task 1 — Token interface (`IRoseToken`) (AC: 1, 2)**
  - [x] `prod/contracts/src/token/interface/IRoseToken.sol` — `interface IRoseToken is IERC20` (import OZ `token/ERC20/IERC20.sol`). Adds the eligibility-enforcement surface: `function identityRegistry() external view returns (IIdentityRegistry);`, `function setIdentityRegistry(IIdentityRegistry newRegistry) external;`, `function mint(address to, uint256 amount) external;`, `function burn(address from, uint256 amount) external;`. Declare `event IdentityRegistrySet(IIdentityRegistry indexed previous, IIdentityRegistry indexed current);`. SPDX `MIT`, `pragma solidity ^0.8.28;`. Import `IIdentityRegistry` from `../../identity/interface/IIdentityRegistry.sol`.

- [x] **Task 2 — `RoseToken` implementation: eligibility-gated `_update` hook (AC: 1, 2)**
  - [x] `prod/contracts/src/token/RoseToken.sol` — `contract RoseToken is ERC20, Ownable, IRoseToken`. Import OZ `token/ERC20/ERC20.sol` and `access/Ownable.sol`; import `IRoseToken` and `IIdentityRegistry`.
  - [x] Constructor `(string name_, string symbol_, IIdentityRegistry registry_, address initialOwner)` → `ERC20(name_, symbol_) Ownable(initialOwner)`; `require(address(registry_) != address(0), "RoseToken: zero registry")`; store registry; emit `IdentityRegistrySet(IIdentityRegistry(address(0)), registry_)`.
  - [x] State: `IIdentityRegistry private _identityRegistry;` with `identityRegistry()` getter (overrides interface).
  - [x] **Core hook — override `_update(address from, address to, uint256 value)` `internal virtual override`:** enforce eligibility on every NON-ZERO party, then `super._update(from, to, value)`:
    - `if (from != address(0)) require(_identityRegistry.isVerified(from), "RoseToken: sender not eligible");`
    - `if (to != address(0)) require(_identityRegistry.isVerified(to), "RoseToken: recipient not eligible");`
    - This single rule covers ALL paths: transfer (both checked), `transferFrom` (both checked — `transferFrom` routes through `_update`), and `mint` (only recipient checked, since `from == address(0)`). Burn (`to == address(0)`) is EXEMPT from the sender check (canonical ERC-3643; owner-gated supply reduction must stay usable against a revoked holder — see code-review patch). Keep `_update` `virtual` so Stories 4.3/4.4 can extend coupling / Model-A on top.
  - [x] `mint(address to, uint256 amount) external onlyOwner` → `_mint(to, amount)` (recipient eligibility enforced by the `_update` hook). `burn(address from, uint256 amount) external onlyOwner` → `_burn(from, amount)`.
  - [x] `setIdentityRegistry(IIdentityRegistry newRegistry) external onlyOwner` → `require(address(newRegistry) != address(0), "RoseToken: zero registry")`; emit `IdentityRegistrySet(old, newRegistry)`; update state. (Mirrors T-REX `setIdentityRegistry`; owner-gated here, transfer-agent generalization is Story 4.6.)
  - [x] SPDX `MIT`, `pragma solidity ^0.8.28;`. Do NOT add `decimals()` override (OZ default 18 already matches the 18-decimal token convention — architecture Data Architecture).

- [x] **Task 3 — Foundry tests: allowed + rejected paths, incl. fuzz (AC: 1, 2)**
  - [x] `prod/contracts/test/token/RoseToken.t.sol` — `is ClaimFixtures` (reuse `test/identity/ClaimFixtures.sol`). In `setUp`, stand up the FULL identity stack exactly as `IdentityRegistry.t.sol` does (`ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `IdentityRegistry`, `ClaimIssuer` with `CLAIM_SIGNER_PK`, add KYC topic, trust issuer), deploy `RoseToken`, register + verify two holder wallets (`alice`, `bob`) via a helper that mirrors `_newVerifiedIdentity` + `registerIdentity` (agent-gated). NOTE: a holder WALLET (the address that holds/transfers tokens) must itself be registered in the `IdentityRegistry` — register `alice`/`bob` wallets, each bound to its own `Identity` carrying a valid KYC claim.
  - [x] **Rejected paths (AC-1):** `test_Transfer_RevertWhen_RecipientNotVerified` (recipient unregistered ⇒ `vm.expectRevert("RoseToken: recipient not eligible")`); `test_Mint_RevertWhen_RecipientNotVerified`; `test_TransferFrom_RevertWhen_RecipientNotVerified`; `test_Transfer_RevertWhen_SenderNoLongerVerified` (mint to alice while verified, revoke alice's claim, then alice→bob transfer reverts `"RoseToken: sender not eligible"` — proves the hook re-checks live eligibility, not acquisition-time).
  - [x] **Allowed paths (AC-2):** `test_Mint_Succeeds_ToVerifiedRecipient` (balance updates); `test_Transfer_Succeeds_BetweenVerified`; `test_TransferFrom_Succeeds_BetweenVerified` (with `approve`).
  - [x] **Gating:** `test_Mint_RevertWhen_NotOwner`; `test_SetIdentityRegistry_OnlyOwner` + `test_SetIdentityRegistry_RevertWhen_Zero`.
  - [x] **Fuzz (AC-2, mandatory):** `testFuzz_Transfer_RevertsForUnverifiedRecipient(address to)` — `vm.assume(to != alice && to != bob && to != address(0))`, mint to alice, expect any alice→`to` transfer to revert (unregistered recipient ⇒ fail-closed). And `testFuzz_Transfer_Succeeds_AmountWithinBalance(uint256 amount)` — bound amount to alice's balance, assert alice→bob succeeds and balances reconcile.
  - [x] Naming: `test_*` unit, `testFuzz_*` fuzz, `vm.expectRevert` for negative paths (NFR-6, architecture Testing standards).

- [x] **Task 4 — Format + gate (AC: 2)**
  - [x] `forge fmt prod/contracts/src/token prod/contracts/test/token` (root prettier does NOT cover `.sol`). Run `forge build` then `forge test` — must be green and strictly ADD to the forge baseline (60 → 60+new). TS gates untouched (Vitest stays 263).

## Dev Notes

### Scope discipline (what 4.2 IS and IS NOT)

- **IN scope:** the custom ERC-3643-compatible **token** (one fungible token on OZ 5.6.1 `ERC20`) whose `_update` hook calls `IIdentityRegistry.isVerified` to enforce **eligibility** on every non-zero transfer party (sender AND recipient), plus mint/transferFrom/burn routed through the same hook; owner-gated `mint`/`burn`/`setIdentityRegistry`; Foundry unit + fuzz tests for allowed and rejected paths. [Source: epics.md#Story 4.2; architecture.md#On-Chain Architecture]
- **OUT of scope (do NOT pull forward):** pair-coupling / atomic paired mint-burn / single-leg-impossible (**Story 4.3**), the Model-A bright line and principal/yield segregated sub-positions (**Story 4.4**), rule-spec → on-chain compliance config **codegen** + dual-plane conformance vectors (**Story 4.5** — 4.2 references the registry directly, no codegen), and ERC-3643 agent powers (forced transfer, recovery, freeze, pause) + Sepolia `forge script` **deployment** (**Story 4.6**). Keep `_update` `virtual` so 4.3/4.4 extend it; do NOT implement coupling/Model-A logic here. [Source: epics.md#Stories 4.3–4.6; sprint-status.yaml]
- **From the 4.1 review carry-over note:** the "≥1 required topic" hardening lands in **4.5** (topic seeding from the rule-spec); do NOT add an on-chain "require ≥1 topic" guard here. The per-identity claims-per-topic OOG concern (deferred-work) is a **holder-self-griefing-only** blast radius and `isVerified` is already TOTAL (try/catch) — no token-side mitigation is required for 4.2; if you add anything, keep it to a test documenting that an unverified/hostile recipient simply fails closed (revert), never bypasses. [Source: deferred-work.md#story-4.1; 4-1 story Senior Developer Review]

### Reuse — do NOT reinvent (load-bearing)

- **`IIdentityRegistry.isVerified(address)` already exists and is the eligibility predicate.** It is fail-closed and TOTAL (never reverts — every external call is wrapped in try/catch in `IdentityRegistry._hasValidClaimForTopic`). Call it inline from `_update`; do NOT duplicate claim/issuer logic in the token. [Source: prod/contracts/src/identity/IdentityRegistry.sol:89-159; prod/contracts/src/identity/interface/IIdentityRegistry.sol:46]
- **OZ 5.6.1 `ERC20`** centralizes ALL balance mutations in `_update(from, to, value)` — `transfer`, `transferFrom`, `_mint`, and `_burn` all route through it (mint = `from==address(0)`, burn = `to==address(0)`). Overriding `_update` is the canonical, single-chokepoint way to gate every movement; do NOT override `transfer`/`transferFrom`/`_mint`/`_burn` individually. [Source: prod/contracts/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol:176-234]
- **Reuse `Ownable(initialOwner)` from OZ** (already used by `IdentityRegistry`/`ClaimTopicsRegistry`). Do NOT hand-roll ownership. The transfer-agent role formalization (`AgentRole`-style) is **Story 4.6**; for 4.2 `onlyOwner` on `mint`/`burn`/`setIdentityRegistry` is sufficient and in-scope. [Source: prod/contracts/src/identity/AgentRole.sol; prod/contracts/lib/openzeppelin-contracts/contracts/access/Ownable.sol]
- **Reuse the test harness:** `prod/contracts/test/identity/ClaimFixtures.sol` provides `CLAIM_SIGNER_PK`, `_claimSignerAddr()`, `_keyHash(addr)`, `_signClaim(pk, identityAddr, topic, data)`. `IdentityRegistry.t.sol#setUp` (lines 40-56) and `_newVerifiedIdentity` (lines 60-64) show EXACTLY how to register + verify a holder — mirror that to set up `alice`/`bob` in the token test. [Source: prod/contracts/test/identity/ClaimFixtures.sol; prod/contracts/test/identity/IdentityRegistry.t.sol]

### Design decision — check BOTH parties, live, every movement

- The hook checks `isVerified` on BOTH the sender (`from`) and the recipient (`to`) on a real **transfer/transferFrom**, and on the recipient of a **mint**. This is **stricter than stock Tokeny T-REX** on the transfer sender: a holder whose claim is revoked AFTER acquiring tokens can no longer send them (eligibility re-evaluated live at transfer time, not frozen at acquisition) — the maximally **fail-closed** reading required by the brief and NFR-4. **Burn (`to == address(0)`) is EXEMPT from the sender check** (canonical ERC-3643): the owner-gated supply-reduction primitive must stay usable against a revoked/de-listed holder, else such balances would be both untransferable AND unburnable (stranded). The zero-address counterpart of mint/burn is naturally skipped (you cannot and must not verify `address(0)`). [Source: epics.md#Story 4.2 AC; architecture.md#Authentication & Security "fail-closed both planes (NFR-4)"; rule-spec `defaultEffect: 'DENY'`; code-review finding (burn-stranding)]
- A holder **wallet** (the address holding tokens) must itself be registered in the `IdentityRegistry` and carry a valid claim — registration binds a wallet to an `Identity` contract; `isVerified(wallet)` resolves the wallet's bound identity's claims. In tests, register the wallet addresses (`alice`/`bob`), not the `Identity` contract addresses, as the token holders. [Source: prod/contracts/src/identity/IdentityRegistry.sol:39-46,89-107]

### Architecture constraints

- **Stack (D2):** custom ERC-3643-compatible suite on **OpenZeppelin Contracts 5.6.1**, referencing Tokeny T-REX / ERC-3643 patterns; **Foundry** toolchain; target Sepolia (deploy deferred to 4.6). [Source: architecture.md#On-Chain Architecture; architecture.md#Selected Approach]
- **Foundry config pinned:** `foundry.toml` → `solc = "0.8.28"`, `evm_version = "cancun"`, optimizer 200. New Solidity MUST compile under `0.8.28`; `pragma solidity ^0.8.28;`. [Source: prod/contracts/foundry.toml]
- **OZ remapping wired:** `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`, `forge-std/=lib/forge-std/src/`. Import OZ `token/ERC20/ERC20.sol`, `token/ERC20/IERC20.sol`, `access/Ownable.sol` — do NOT vendor. [Source: prod/contracts/remappings.txt]
- **Regime boundary:** PROD contracts under `prod/contracts/`. Never reference `/throwaway`. Solidity is outside the pnpm workspace and `tsc -b`, so no TS package wiring needed; `pnpm check:regime` and the TS gates are unaffected by Solidity additions. [Source: pnpm-workspace.yaml; architecture.md#Project Structure]
- **Numeric representation (NFR-2):** token amounts are **18-decimal `uint256`** smallest-unit integers; no float anywhere. The token carries no off-chain money math. `decimals()` stays at OZ default 18. [Source: architecture.md#Data Architecture]
- **Default-deny / fail-closed (NFR-4) mirrored on-chain:** an unverified sender or recipient ⇒ the transfer REVERTS. No code path may move tokens to/from an address that is not `isVerified` (except the zero-address mint/burn counterpart). [Source: architecture.md#Authentication & Security]

### Single-source alignment

- 4.2 enforces the **eligibility** plane of the rule-spec (`eligibility.requireAllowlist`, `requiredClaimTopics`) by consuming the on-chain `IdentityRegistry`/`isVerified` already aligned to it in 4.1. Do NOT edit `@rose/rule-spec` (Epic 3 done). The rule-spec → on-chain **codegen** that would emit the registry wiring / topic config is **Story 4.5**; 4.2 wires the token to the registry by constructor reference. [Source: prod/packages/rule-spec/src/spec/rule-spec.v1.ts; epics.md#Story 4.5; 4-1 story Dev Notes]

### Prior-art / patterns to mirror (so you don't reinvent T-REX)

- **ERC-3643 `Token`** enforces compliance in its transfer path by consulting the `IdentityRegistry.isVerified(_to)` and a compliance module. The OZ-5 idiom is to fold that check into the single `_update` override (T-REX predates OZ-5's `_update` unification and overrode `transfer`/`mint` separately — the OZ-5 `_update` chokepoint is cleaner and is what 4.3/4.4 will extend). [Source: architecture.md#On-Chain Architecture ERC-3643 reference]
- Revert with short, stable `require` strings (`"RoseToken: recipient not eligible"`, `"RoseToken: sender not eligible"`, `"RoseToken: zero registry"`) — consistent with the `"IdentityRegistry: ..."`/`"AgentRole: ..."` style already in the suite, so tests can `vm.expectRevert(bytes("..."))`. [Source: prod/contracts/src/identity/IdentityRegistry.sol; AgentRole.sol]

### Project Structure Notes

- New tree: `prod/contracts/src/token/RoseToken.sol` + `prod/contracts/src/token/interface/IRoseToken.sol` (impl + interface), tests under `prod/contracts/test/token/RoseToken.t.sol`. This matches architecture's `contracts/src` ("custom ERC-3643-compatible token, compliance modules, ONCHAINID integ") and `contracts/test` ("*.t.sol — unit + fuzz + invariant"), and parallels the 4.1 `src/identity` + `test/identity` layout. [Source: architecture.md#Complete Project Directory Structure; 4-1 story Project Structure Notes]
- Run `forge fmt prod/contracts/src/token prod/contracts/test/token` before finishing; root `prettier` globs are ts/tsx/mjs/json/md/yml/yaml only — Solidity formatting is owned by `forge fmt`. The root `bmad-pipeline-report.md` IS prettier-checked — keep appended markdown prettier-clean. [Source: package.json format globs; 4-1 story]

### Testing standards

- **Solidity tests** in `prod/contracts/test/**/*.t.sol`, run by `forge test` (incl. fuzz — NFR-6 test-first on invariants). Naming: `test_*` unit, `testFuzz_*` fuzz, `test_RevertWhen_*` / `vm.expectRevert` for negative paths. Use `vm.prank`/`vm.startPrank` for caller identity, `vm.sign`/`vm.addr` for real ECDSA claim signatures (via `ClaimFixtures`). [Source: architecture.md#On-Chain Architecture; prod/contracts/test/identity]
- **Write the load-bearing negative path first:** *no token can land on, or leave, an address that is not `isVerified`* — prove every rejected branch (unregistered recipient, revoked sender, mint to unverified) reverts, plus a fuzz over random unregistered recipients. The allowed path (verified↔verified) is the positive control. [Source: epics.md#Story 4.2 AC-2; NFR-4]
- **Baseline before this story: forge 60/60, Vitest 263/263.** This story adds Solidity only; TS gates must stay 263 green and unchanged, forge must grow (60 → 60+new) with zero regressions. [Source: 4-1 story Testing standards; bmad-pipeline-report.md]

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 / Story 4.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#On-Chain Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security]
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Architecture]
- [Source: _bmad-output/implementation-artifacts/4-1-stand-up-onchainid-identity-and-eligibility-infrastructure.md]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md#story-4.1]
- [Source: prod/contracts/src/identity/IdentityRegistry.sol; interface/IIdentityRegistry.sol]
- [Source: prod/contracts/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol]
- [Source: prod/contracts/foundry.toml; prod/contracts/remappings.txt]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `forge build` compiled cleanly on first try; the only `forge fmt`/`forge lint` notes emitted are PRE-EXISTING advisories on `src/identity/Identity.sol` (named-struct-fields) untouched by this story. `forge fmt --check src/token test/token` is clean.
- `forge test`: 76/76 (60 pre-existing identity/counter + 16 new RoseToken). Both fuzz tests ran 256 runs green.
- The live-revocation test (`test_Transfer_RevertWhen_SenderNoLongerVerified`) recomputes the deterministic claim signature (`_signClaim` over the same identity/topic/data with `CLAIM_SIGNER_PK`) and revokes by signature; revocation is keyed by `keccak256(sig)`, so the recomputed bytes match the claim added at registration.

### Completion Notes List

- Delivered the base custom ERC-3643-compatible token `RoseToken` (OZ 5.6.1 `ERC20` + `Ownable`) with a single eligibility chokepoint in the `_update` override: every NON-ZERO party to any balance movement must be `IIdentityRegistry.isVerified`, else the call reverts (fail-closed, NFR-4). The zero-address side of mint/burn is naturally skipped.
- **AC-1 (reject transfer to a non-eligible recipient):** met — `test_Transfer_RevertWhen_RecipientNotVerified`, `test_Mint_RevertWhen_RecipientNotVerified`, `test_TransferFrom_RevertWhen_RecipientNotVerified`, plus `testFuzz_Transfer_RevertsForUnverifiedRecipient` (256 random unregistered recipients all rejected). Also `test_Transfer_RevertWhen_SenderNoLongerVerified` proves eligibility is re-checked LIVE (a revoked sender can no longer move tokens).
- **AC-2 (compliant transfer succeeds; fuzz covers both paths):** met — `test_Mint_Succeeds_ToVerifiedRecipient`, `test_Transfer_Succeeds_BetweenVerified`, `test_TransferFrom_Succeeds_BetweenVerified`, plus `testFuzz_Transfer_Succeeds_AmountWithinBalance` (256 amounts within balance reconcile). `forge test` green.
- **Reuse, not reinvention:** consumes the existing fail-closed/TOTAL `IIdentityRegistry.isVerified` (4.1) inline; overrides only `_update` (the OZ-5 single chokepoint) rather than each transfer/mint/burn; reuses `ClaimFixtures` and the `IdentityRegistry.t.sol` harness pattern for the test setup. `@rose/rule-spec` NOT modified.
- **Scope held:** no pair coupling (4.3), no Model-A principal/yield (4.4), no rule-spec codegen / dual-plane vectors (4.5), no agent powers or Sepolia deploy script (4.6). `_update` left `virtual` so 4.3/4.4 can layer coupling/Model-A on the same chokepoint. Owner-gating on `mint`/`burn`/`setIdentityRegistry` is a deliberate 4.2 minimum; the transfer-agent role generalization is 4.6.
- **Gates:** Vitest 263/263 (unchanged — Solidity-only story), forge 77/77 (60 → +17 after the code-review regression test), typecheck/lint/check:regime/check:migrations/format:check all green, `forge fmt --check` clean on the new tree.
- **Code-review patch (1):** exempted the owner-gated `burn` (`to == address(0)`) from the `isVerified(from)` check so the issuer can reduce the supply of a revoked/de-listed holder (canonical ERC-3643) — otherwise such balances were both untransferable AND unburnable (stranded). Real transfers still check BOTH parties; mint still checks the recipient. Added regression `test_Burn_Succeeds_AfterHolderRevoked` (and it asserts transfer still reverts for the revoked holder). Side benefit: the burn path no longer loops a holder's (uncapped) claims, shrinking the OOG blast radius back to holder-self-griefing-only.

### File List

**New — Solidity contracts (`prod/contracts/src/token/`):**

- `interface/IRoseToken.sol`
- `RoseToken.sol`

**New — Foundry tests (`prod/contracts/test/token/`):**

- `RoseToken.t.sol`

**Modified:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: ready-for-dev → in-progress → review)

## Change Log

| Date       | Version | Description                                                                                                                 | Author |
| ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev                                                                                 | Amelia |
| 2026-06-16 | 0.2     | Implemented RoseToken (eligibility-gated `_update`) + interface + Foundry tests (16 new, incl. 2 fuzz → forge 76); gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers); 1 patch (burn-stranding fix → +1 regression test, forge 77), 4 deferred, 2 dismissed; gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] Burn of a revoked/de-listed holder was blocked — owner could neither transfer nor burn it (stranded) [prod/contracts/src/token/RoseToken.sol:58] — FIXED: exempted burn (`to == 0`) from the sender-eligibility check (canonical ERC-3643); real transfers still check both parties. Regression: `test_Burn_Succeeds_AfterHolderRevoked`. Raised by Blind Hunter (Med/High) + Edge-Case Hunter (Med).
- [x] [Review][Defer] No forced-transfer / recovery and no pause / per-address freeze [RoseToken.sol] — deferred to **Story 4.6** (gated transfer-agent powers: forced transfer, recovery, freeze, pause). Explicitly out of 4.2 scope.
- [x] [Review][Defer] `setIdentityRegistry` has no holder-continuity check — an owner swap to a registry that does not recognize current holders freezes their balances [RoseToken.sol:37] — deferred. Owner-trusted, recoverable (swap back), and mirrors stock ERC-3643 `setIdentityRegistry`. A migration/continuity guard is an ops/4.6 hardening.
- [x] [Review][Defer] `Ownable` single-key admin: `renounceOwnership` would brick mint/burn/registry-update; single-step `transferOwnership` footgun; no minter/agent role separation or multisig [RoseToken.sol] — deferred to **Story 4.6** / ops (transfer-agent role + multisig). Consistent with the rest of the suite's `Ownable` usage.
- [x] [Review][Defer] Wiring `isVerified` into the transfer hot path keeps the 4.1 unbounded-claims-per-topic OOG concern relevant (holder self-griefing) [RoseToken.sol:58; IdentityRegistry.sol:101] — deferred per 4.1 deferred-work; the burn-exemption patch already removed the burn-path facet (issuer burn no longer loops holder claims), so the blast radius is back to holder-self-only. Revisit a claim-scan cap with 4.6 recovery design.
- [Review][Dismiss] Reentrancy via the `isVerified` external call in `_update` — false positive: `isVerified` is `view` (STATICCALL) and the registry's downstream calls are try/catch-wrapped and cannot mutate token state (confirmed by Edge-Case Hunter).
- [Review][Dismiss] Zero-value transfer to an unverified recipient reverts (ERC-20 zero-transfer deviation) — by-design fail-closed (NFR-4): an ineligible address may not be a transfer party at any value. Verified→verified zero-value succeeds (covered by `testFuzz_Transfer_Succeeds_AmountWithinBalance`, which samples 0).

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (1 patch applied; no unresolved High/Med)

Three parallel adversarial layers ran against the diff: **Blind Hunter** (correctness, diff-only), **Edge-Case Hunter** (branch/boundary, repo read access), **Acceptance Auditor** (vs spec/epic/architecture/rule-spec). The Acceptance Auditor returned **PASS on AC-1 and AC-2** with no scope creep and confirmed `@rose/rule-spec` was left unmodified. Both adversarial layers independently flagged the same material issue — the both-sides eligibility check also gated owner-driven `burn`, so a revoked holder's balance was stranded (untransferable AND unburnable) — which was patched here (burn exempted from the sender check, canonical ERC-3643) with a regression test. Remaining findings (forced-transfer/recovery, pause/freeze, registry-swap continuity, owner-key management, claim-scan OOG) are owner-trusted/recoverable or explicitly belong to Story 4.6; deferred and recorded in deferred-work.md.
