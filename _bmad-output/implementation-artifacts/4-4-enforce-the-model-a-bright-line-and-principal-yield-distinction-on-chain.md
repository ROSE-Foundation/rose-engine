---
baseline_commit: NO_VCS
---

# Story 4.4: Enforce the Model-A bright line and principal/yield distinction on-chain

Status: done

## Story

As an internal operator,
I want the contract to distinguish principal from yield and block principal from leaving the client position,
so that the Model-A segregation is enforced where the token moves (FR-19): a fungible token alone cannot express principal vs yield, so the custom contract maintains segregated principal sub-positions on-chain.

## Acceptance Criteria

**AC-1 — A transfer that would move client-collateral *principal* out of the client position is rejected on-chain**
**Given** segregated principal sub-positions in the custom contract
**When** an on-chain transfer would move client-collateral *principal* out of the client position
**Then** it is rejected on-chain (UJ-3, Model-A bright line)

**AC-2 — A yield movement on the same collateral is permitted; Foundry fuzz/invariant tests cover principal-rejected and yield-allowed**
**Given** a yield movement on the same collateral (the surplus above the segregated principal)
**When** the on-chain transfer is made
**Then** it is permitted, and Foundry fuzz/invariant tests cover the principal-rejected and yield-allowed cases

## Tasks / Subtasks

- [x] **Task 1 — Extend `CoupledLeg` with a segregated principal sub-position (AC: 1, 2)**
  - [x] `prod/contracts/src/token/CoupledLeg.sol` — add state `mapping(address => uint256) private _principal;` — the segregated principal sub-position of each holder. **Invariant to uphold by construction:** `_principal[holder] <= balanceOf(holder)` in EVERY reachable state. Add view `function principalOf(address holder) external view returns (uint256)` returning `_principal[holder]`.
  - [x] Add events `event PrincipalDesignated(address indexed holder, uint256 amount, uint256 totalPrincipal);` and `event PrincipalReducedOnBurn(address indexed holder, uint256 amount, uint256 totalPrincipal);`.
  - [x] Add **owner-gated** `function designatePrincipal(address holder, uint256 amount) external onlyOwner` — carves out `amount` more of `holder`'s CURRENT balance as segregated principal: `uint256 newPrincipal = _principal[holder] + amount; require(newPrincipal <= balanceOf(holder), "CoupledLeg: principal exceeds balance"); _principal[holder] = newPrincipal; emit PrincipalDesignated(holder, amount, newPrincipal);`. Owner of a leg is the `CoupledPair` (4.3), so this is reachable only through the pair (Task 3) — keeping the legs sealed (the pair is the sole privileged driver, consistent with mint/burn).
  - [x] Keep `_update` `virtual override` (do NOT seal — future stories may extend the same chokepoint).

- [x] **Task 2 — Layer the Model-A bright line onto `CoupledLeg._update` (AC: 1, 2)**
  - [x] In `CoupledLeg._update(address from, address to, uint256 value)`: KEEP the existing 4.3 coupling guard (single-leg mint/burn requires `pairingInProgress()`) BEFORE `super._update`, and KEEP `super._update(from, to, value)` (4.2 eligibility chokepoint → OZ ERC20) running. Then ADD the Model-A logic AFTER `super._update`, alongside the coupling guard, on the SAME chokepoint:
    - **Bright line (transfer branch, `from != 0 && to != 0`):** after `super._update` the sender's post-transfer balance is `balanceOf(from)`. Require it still covers the segregated principal: `require(balanceOf(from) >= _principal[from], "CoupledLeg: principal cannot leave position");`. This blocks any transfer that would dip into principal — only the YIELD surplus (`balanceOf(from) - _principal[from]`) is movable. (Checking AFTER `super._update` reuses OZ's own insufficient-balance check and avoids an unchecked subtraction underflow.)
    - **Burn clamp (burn branch, `from != 0 && to == 0`):** an authorized paired burn (redemption) retires the coupled package INCLUDING principal. After `super._update`, clamp principal down so the invariant holds: `if (_principal[from] > balanceOf(from)) { uint256 reduced = _principal[from] - balanceOf(from); _principal[from] = balanceOf(from); emit PrincipalReducedOnBurn(from, reduced, balanceOf(from)); }`. Burn is the ONLY path that reduces principal (no owner "release/reclassify" backdoor in 4.4 — that is reset/settlement, Epic 5-7).
    - **Mint branch (`from == 0`):** no principal change — newly minted tokens land as MOVABLE (yield) until/unless the issuer explicitly `designatePrincipal`s them. Recipients of a transfer likewise receive movable tokens (their own `_principal` is untouched).
  - [x] Update the `CoupledLeg` NatSpec to document the Model-A bright line layered on the 4.2 eligibility + 4.3 coupling chokepoint, and the principal-monotonic-except-burn property.

- [x] **Task 3 — Forward principal designation through `CoupledPair` (AC: 1, 2)**
  - [x] `prod/contracts/src/token/CoupledPair.sol` — the pair is the sole owner of both legs, so add **owner-gated forwarders** so the principal primitive is reachable while the legs stay sealed: `function designateLPrincipal(address holder, uint256 amount) external onlyOwner { _lToken.designatePrincipal(holder, amount); }` and `function designateSPrincipal(address holder, uint256 amount) external onlyOwner { _sToken.designatePrincipal(holder, amount); }`. The leg's `PrincipalDesignated` event flows up. Do NOT change `mintPair`/`burnPair` semantics (coupling + atomicity from 4.3 stay intact); designation is a SEPARATE issuer step.
  - [x] Do NOT add principal methods to `ICoupledPair` (that interface is the 4.3 coupling surface — keep it focused). The forwarders are concrete `CoupledPair` functions. (Wiring WHO designates principal and WHEN — subscription/reset — is Epic 5-7; 4.4 ships the reachable primitive only.)

- [x] **Task 4 — Foundry unit/fuzz tests: bright line rejects principal egress, yield moves freely (AC: 1, 2)**
  - [x] `prod/contracts/test/token/CoupledLegPrincipal.t.sol` — `is ClaimFixtures`. In `setUp`, stand up the full identity stack exactly as `CoupledPair.t.sol#setUp` (ClaimTopicsRegistry, TrustedIssuersRegistry, IdentityRegistry + agent, ClaimIssuer with `CLAIM_SIGNER_PK`, add KYC topic, trust issuer), `_registerVerified(alice)`/`_registerVerified(bob)`, deploy a `CoupledPair` owned by `address(this)`, grab `lToken`/`sToken`.
  - [x] **AC-1 principal egress rejected:** `test_Transfer_RevertWhen_WouldMovePrincipal` — `mintPair(alice, bob, 1_000e18)`, `designateLPrincipal(alice, 700e18)`, then `vm.prank(alice); lToken.transfer(bob, 400e18)` reverts `"CoupledLeg: principal cannot leave position"` (would leave 600 < 700 principal); assert balances/principal UNCHANGED.
  - [x] **AC-2 yield allowed:** `test_Transfer_YieldSurplus_Succeeds` — same setup, `lToken.transfer(bob, 300e18)` (exactly the 300 yield surplus) succeeds; `balanceOf(alice)==700`, `principalOf(alice)==700`, `balanceOf(bob)==300` (movable, principalOf(bob)==0).
  - [x] **Boundary:** `test_Transfer_ExactYield_Succeeds_OneMoreReverts` — transfer of EXACTLY surplus succeeds; a follow-up transfer of `1` reverts (principal now == balance, zero yield).
  - [x] **Full principal locks all:** `test_Transfer_RevertWhen_FullyPrincipal` — designate principal == full balance ⇒ any positive transfer out reverts; a zero-amount transfer is a no-op that succeeds.
  - [x] **Designation guards:** `test_DesignatePrincipal_RevertWhen_ExceedsBalance` (`designateLPrincipal(alice, balance+1)` reverts `"CoupledLeg: principal exceeds balance"`); `test_DesignatePrincipal_RevertWhen_NotOwner` (`vm.prank(stranger); pair.designateLPrincipal(...)` reverts `Ownable.OwnableUnauthorizedAccount`); `test_DesignateLeg_RevertWhen_CalledDirectlyByEOA` (`vm.prank(stranger); lToken.designatePrincipal(...)` reverts Ownable — legs sealed).
  - [x] **Burn retires principal (redemption):** `test_BurnPair_ReducesPrincipal_Clamped` — designate alice's L principal == 1_000, `burnPair(alice, bob, 400)` succeeds (authorized retirement, NOT blocked by the bright line) ⇒ `balanceOf(alice)==600`, `principalOf(alice)==600` (clamped), supplies equal. Full burn ⇒ principal 0.
  - [x] **Recipient unaffected / mint is yield:** `test_Mint_LandsAsMovableYield` — after `mintPair` (no designation), `principalOf(alice)==0` and the full balance transfers out freely.
  - [x] **4.3 coupling + 4.2 eligibility still hold:** `test_PrincipalLockedTransfer_StillEligibilityGated` — a principal-covered transfer to an UNVERIFIED recipient reverts on eligibility (4.2) not the bright line (prove ordering doesn't mask 4.2); `test_DesignatePrincipal_DoesNotAffectCoupling` — designation never changes `lToken.totalSupply()`/`sToken.totalSupply()` equality.
  - [x] **Fuzz:** `testFuzz_YieldTransferableUpToSurplus(uint256 mintAmt, uint256 principalAmt, uint256 xfer)` — bound `mintAmt` in `[1, 1e27]`, `principalAmt` in `[0, mintAmt]`, designate it; for `xfer <= mintAmt - principalAmt` the transfer succeeds and `balanceOf(alice) >= principalOf(alice)`; for `xfer > surplus` (separate bounded case) it reverts. Assert `principalOf(alice) <= balanceOf(alice)` after.
  - [x] Naming: `test_*` unit, `test_RevertWhen_*`/`vm.expectRevert` negatives, `testFuzz_*` fuzz.

- [x] **Task 5 — Foundry INVARIANT test: principal can never leave a position (AC: 2, mandatory)**
  - [x] `prod/contracts/test/token/CoupledLegPrincipalInvariant.t.sol` — a handler + invariants. Handler `PrincipalHandler` owns the `CoupledPair` and exposes to the fuzzer: `mintPair(amount)`, `burnPair(amount)` (bounded by min balance), `designateLPrincipal(amount)` / `designateSPrincipal(amount)` (bounded by current free surplus so it never reverts spuriously), `transferL(amount)` / `transferS(amount)` (alice↔bob, bounded by balance — the fuzzer WILL attempt principal-violating amounts; a revert just rolls that call back). Optionally a ghost `attemptPrincipalEgress` that `try`s an over-surplus transfer and latches a flag iff it ever SUCCEEDS.
  - [x] `setUp` builds the identity stack, registers actors, deploys the pair, transfers pair ownership to the handler, `targetContract(handler)`.
  - [x] `invariant_PrincipalNeverExceedsBalance()` — for each actor and each leg, `leg.principalOf(actor) <= leg.balanceOf(actor)` (the structural proof that principal never left, since transfers reduce balance and the bright line forbids dropping below principal).
  - [x] `invariant_PrincipalEgressNeverSucceeds()` — assert the ghost flag stays false (a transfer that would move principal can never land).
  - [x] Rely on forge default invariant runs (do NOT lower existing rigor; only add a `[invariant]` block if absent AND needed).

- [x] **Task 6 — Format + gate (AC: 1, 2)**
  - [x] `forge fmt prod/contracts/src/token prod/contracts/test/token` (root prettier does NOT cover `.sol`). `forge build` then `forge test` — green, strictly ADDING to the forge baseline (98 → 98+new, incl. ≥1 new invariant), ZERO regressions in the 4.1/4.2/4.3 suites. TS gates untouched (Vitest stays 263). `forge fmt --check` clean on the new tree.
  - [x] Full gate: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm check:regime`, `pnpm check:migrations`, `pnpm format:check`, `forge test`, `forge fmt --check`.

## Dev Notes

### Scope discipline (what 4.4 IS and IS NOT)

- **IN scope:** the **on-chain segregation PRIMITIVE** that a plain fungible token cannot express — a per-holder **segregated principal sub-position** (`_principal[holder]`) maintained by the custom contract, plus the **Model-A bright line** enforced on the SAME `CoupledLeg._update` chokepoint: a transfer that would move **client-collateral principal** out of the position is **rejected**, while a **yield** movement (the surplus above principal) is **permitted**. Foundry unit + fuzz tests (principal-rejected, yield-allowed) and a Foundry **invariant** (`principalOf <= balanceOf` always; principal egress can never succeed). [Source: epics.md#Story 4.4; architecture.md#On-Chain Architecture "Model-A bright line with principal/yield distinction (segregated principal sub-positions a plain fungible token cannot express)"; FR-19]
- **OUT of scope (do NOT pull forward):** rule-spec → on-chain compliance **codegen** + dual-plane conformance vectors (**Story 4.5** — 4.4 enforces Model-A structurally in the contract, not via generated config); ERC-3643 **agent powers** (forced transfer, recovery, freeze, pause) + Sepolia `forge script` **deployment** (**Story 4.6**); the **reset / P&L crystallization / settlement** mechanics where yield becomes withdrawable vs principal at D1a (**Epics 5-7**). 4.4 lays the PRIMITIVE; it does NOT implement a "release/crystallize principal" owner path (that is reset). Keep `CoupledLeg._update` `virtual`. [Source: epics.md#Stories 4.5-4.6, Epic 5; brief D1a; sprint-status.yaml]

### Design decision — segregated principal sub-position on the leg, bright line on the chokepoint

- **D1a alignment (anchor, do not implement):** at reset the P&L is crystallized and the **yield is withdrawable** while **principal is not** freely removable. 4.4 establishes the on-chain PRIMITIVE that makes this expressible — principal is segregated and locked against transfer; yield (surplus) moves. The reset/settlement mechanic that crystallizes and releases is Epics 5-7. Stay on the primitive here. [Source: brief D1a "at reset, P&L crystallised & withdrawable"; architecture.md#On-Chain Architecture]
- **Why on the leg, layered after `super._update`:** 4.3 left `CoupledLeg._update` `virtual` precisely so 4.4 can layer Model-A on it. The coupling guard runs BEFORE `super._update` (it must veto a single-leg mint/burn before any mutation); the bright line runs AFTER `super._update` because it compares the holder's POST-transfer balance against the segregated principal — and running after reuses OZ's insufficient-balance check (no unchecked underflow). Both compose on one chokepoint: eligibility (4.2) → coupling (4.3) → Model-A (4.4). [Source: prod/contracts/src/token/CoupledLeg.sol:37-42; 4-3 story Dev Notes "Keep `_update` virtual so 4.4 can layer Model-A"]
- **Principal is movable-out only via authorized burn (no transfer egress, no reclassify backdoor):** the ONLY way `_principal[holder]` decreases is the owner-gated paired **burn** (redemption retires the coupled package incl. principal), clamped so `_principal <= balance` always. There is deliberately NO owner "release principal to movable" function in 4.4 — that would be a backdoor around the bright line and belongs to reset (Epics 5-7). This makes the invariant strong and the bright line airtight. [Source: epics.md#Story 4.4 AC-1; FR-8 "CLIENT_COLLATERAL principal leaving the client account is rejected (Model-A)"]
- **Mint lands as movable (yield) by default:** newly minted tokens are NOT principal until the issuer explicitly `designatePrincipal`s them. This keeps `mintPair` (4.3) semantics untouched and models yield accrual (extra mint to a client that is freely movable) vs principal (explicitly segregated collateral). [Source: FR-8 "yield on CLIENT_COLLATERAL → treasury is allowed (principal excluded)"]

### Reuse — do NOT reinvent (load-bearing)

- **`CoupledLeg is RoseToken` (4.2/4.3) is the base — extend its `_update`, do NOT re-override `transfer`/`_mint`/`_burn`.** Keep the 4.3 coupling guard and `super._update` (4.2 eligibility) exactly; ADD the Model-A branches after `super._update`. [Source: prod/contracts/src/token/CoupledLeg.sol:37-42; RoseToken.sol:68-78]
- **`CoupledPair` is the sole privileged driver of the legs (owner-as-coupler, 4.3).** Reach `designatePrincipal` ONLY through owner-gated `CoupledPair` forwarders (`designateLPrincipal`/`designateSPrincipal`), mirroring how `mintPair`/`burnPair` are the sole supply path — legs stay sealed from EOAs. Do NOT change `mintPair`/`burnPair` or the `_pairing` flag. [Source: prod/contracts/src/token/CoupledPair.sol:23-77]
- **Reuse the test harness:** mirror `CoupledPair.t.sol#setUp` (full identity stack + `_registerVerified`) and `CoupledPairInvariant.t.sol` (handler + `targetContract` pattern, `_bound`/`_min` helpers, ghost-flag latch). [Source: prod/contracts/test/token/CoupledPair.t.sol:42-75; prod/contracts/test/token/CoupledPairInvariant.t.sol:23-157]
- **`@rose/rule-spec` is NOT modified** (Epic 3 done). 4.4 expresses Model-A structurally in Solidity; the rule-spec→on-chain config derivation is Story 4.5. [Source: 4-3 story Single-source alignment; epics.md#Story 4.5]

### Interaction with prior deferrals (4.2/4.3)

- **Burn sender-exemption (4.2):** burn (`to == 0`) is exempt from `isVerified(from)`, so `burnPair` can retire a revoked holder's coupled package; the 4.4 burn clamp piggybacks on that same authorized burn path to reduce principal. A revoked holder's principal is therefore NOT stranded — it is retired with the package. [Source: RoseToken.sol:54-77; 4-3 story Burn exemption interaction]
- **Claims-per-topic OOG (4.1/4.2/4.3 deferral):** the bright-line check is a pure storage read/compare (`_principal[from]`, `balanceOf(from)`) and adds NO new `isVerified` loop on the hot path, so it does not widen the existing OOG surface. [Source: deferred-work.md story-4.3 deferrals]

### Architecture constraints

- **Stack (D2):** custom ERC-3643-compatible suite on **OpenZeppelin Contracts 5.6.1**; **Foundry** with **fuzz + invariant** testing to prove compliance rules (here: Model-A principal/yield). Target Sepolia (deploy deferred to 4.6). [Source: architecture.md#On-Chain Architecture]
- **Foundry config pinned:** `foundry.toml` → `solc = "0.8.28"`, `evm_version = "cancun"`, `optimizer = true`, `optimizer_runs = 200`. New Solidity MUST compile under `0.8.28`; `pragma solidity ^0.8.28;`, SPDX `MIT`. [Source: prod/contracts/foundry.toml]
- **OZ remapping wired:** `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`, `forge-std/=lib/forge-std/src/`. Do NOT vendor OZ. [Source: prod/contracts/remappings.txt]
- **Numeric representation (NFR-2):** token + principal amounts are **18-decimal `uint256`** smallest-unit integers; no float. Principal sub-position is a `uint256` mapping value. [Source: architecture.md#Data Architecture]
- **Regime boundary:** PROD contracts under `prod/contracts/`. Never reference `/throwaway`. Solidity is outside the pnpm workspace, so TS gates are unaffected by Solidity additions. [Source: pnpm-workspace.yaml; architecture.md#Project Structure]
- **D3 — chain is source of truth:** the segregated principal sub-position lives on-chain; the ledger reconciles toward it (Epic 5). 4.4 just establishes the on-chain state + enforcement. [Source: architecture.md; brief D3]

### Single-source alignment

- 4.4 enforces the **Model-A bright line** plane of the rule-spec ("principal cannot leave the client position; yield can") on-chain by construction (segregated principal sub-position + chokepoint guard). The rule-spec → on-chain **codegen** that would emit any Model-A config is **Story 4.5**; 4.4 expresses it structurally, not via generated config. The off-chain analogue (`flow_permissions` rejecting `CLIENT_COLLATERAL` principal egress, allowing yield) shipped in Story 3.4. [Source: architecture.md#Off-Chain↔On-Chain Rule Equivalence; FR-8; epics.md#Story 3.4 / 4.5]

### Project Structure Notes

- Edited: `prod/contracts/src/token/CoupledLeg.sol` (principal state + `_update` Model-A branches + `principalOf`/`designatePrincipal`), `prod/contracts/src/token/CoupledPair.sol` (designation forwarders). New tests: `prod/contracts/test/token/CoupledLegPrincipal.t.sol`, `prod/contracts/test/token/CoupledLegPrincipalInvariant.t.sol`. Parallels the 4.3 `src/token` + `test/token` layout. [Source: architecture.md#Complete Project Directory Structure; 4-3 story Project Structure Notes]
- Run `forge fmt prod/contracts/src/token prod/contracts/test/token` before finishing; root `prettier` globs are ts/tsx/mjs/json/md/yml/yaml only. The root `bmad-pipeline-report.md` IS prettier-checked — keep appended markdown prettier-clean. [Source: package.json format globs; 4-3 story]

### Testing standards

- **Solidity tests** in `prod/contracts/test/**/*.t.sol`, run by `forge test` (incl. fuzz AND **invariant** — NFR-6 test-first on invariants). Naming: `test_*` unit, `testFuzz_*` fuzz, `invariant_*` invariant, `vm.expectRevert` for negatives, `vm.prank`/`vm.startPrank` for caller identity. The invariant test needs a handler exposing the state-mutating surface + `targetContract`. [Source: architecture.md#On-Chain Architecture "fuzzing and invariant testing"; prod/contracts/test/token/CoupledPairInvariant.t.sol]
- **Write the load-bearing negative path:** *principal can never leave a position via transfer* — prove the bright line reverts a principal-dipping transfer, the surplus (yield) moves, the boundary (exact surplus succeeds / +1 reverts) holds, and the invariant (`principalOf <= balanceOf` always; egress never lands) proves it across any reachable sequence. [Source: epics.md#Story 4.4 AC; FR-19]
- **Baseline before this story: forge 98/98, Vitest 263/263.** This story adds Solidity only; TS gates must stay 263 green and unchanged, forge must grow (98 → 98+new) with zero regressions across 4.1/4.2/4.3. [Source: 4-3 story Dev Agent Record (forge 98); bmad-pipeline-report.md]

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 / Story 4.4]
- [Source: _bmad-output/planning-artifacts/architecture.md#On-Chain Architecture]
- [Source: _bmad-output/implementation-artifacts/4-3-enforce-pair-coupling-on-chain-atomic-paired-mint-burn-single-leg-impossible.md]
- [Source: prod/contracts/src/token/CoupledLeg.sol; src/token/CoupledPair.sol; src/token/RoseToken.sol]
- [Source: prod/contracts/test/token/CoupledPair.t.sol; test/token/CoupledPairInvariant.t.sol]
- [Source: prod/contracts/foundry.toml; prod/contracts/remappings.txt]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md (4.1/4.2/4.3 deferrals)]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `forge build` compiled cleanly under solc 0.8.28. `forge fmt --check` exit 0 across the contracts tree; the only `forge lint` notes are PRE-EXISTING advisories (named-struct-fields / unwrapped-modifier-logic on `Identity.sol`) unrelated to this story.
- `forge test`: 119/119 (98 pre-existing + 21 new). New = 18 unit/fuzz in `CoupledLegPrincipal.t.sol` + 3 invariants in `CoupledLegPrincipalInvariant.t.sol`. Invariants ran forge defaults (256 runs × 500 calls each) with 0 reverts: `invariant_PrincipalNeverExceedsBalance`, `invariant_PrincipalEgressNeverSucceeds`, `invariant_LegSuppliesAlwaysEqual`.

### Completion Notes List

- Delivered the on-chain Model-A segregation PRIMITIVE on `CoupledLeg`: a per-holder `mapping(address => uint256) _principal` (segregated principal sub-position a plain fungible token cannot express), exposed via `principalOf(holder)`, designated via owner-gated `designatePrincipal` reachable only through `CoupledPair`'s `designateLPrincipal`/`designateSPrincipal` forwarders (legs stay sealed from EOAs).
- **AC-1 (principal egress rejected):** met — the Model-A bright line is layered on the SAME `CoupledLeg._update` chokepoint AFTER `super._update` (4.2 eligibility) and alongside the BEFORE-`super` 4.3 coupling guard. On a transfer, `require(balanceOf(from) >= _principal[from], "CoupledLeg: principal cannot leave position")` blocks any move that would dip into principal. Proven by `test_Transfer_RevertWhen_WouldMovePrincipal`, `test_Transfer_RevertWhen_FullyPrincipal`, the boundary `test_Transfer_ExactYield_Succeeds_OneMoreReverts`, and the fuzz `testFuzz_PrincipalEgressAlwaysReverts`.
- **AC-2 (yield permitted; fuzz/invariant cover both):** met — only the yield surplus (`balance - principal`) is movable: `test_Transfer_YieldSurplus_Succeeds`, `test_Mint_LandsAsMovableYield`, `test_YieldFromExtraMint_IsMovable`, `testFuzz_YieldTransferableUpToSurplus`. The mandatory invariants prove `principalOf <= balanceOf` for every actor/leg under any reachable sequence (`invariant_PrincipalNeverExceedsBalance`) and that a principal-dipping transfer can NEVER land (`invariant_PrincipalEgressNeverSucceeds`).
- **Burn = the only principal-reducing path (redemption), clamped:** an authorized paired `burnPair` retires the coupled package incl. principal; `_update` clamps `_principal[from]` down to the remaining balance (`PrincipalReducedOnBurn`). No owner "release/reclassify principal to movable" backdoor exists in 4.4 — that is reset/P&L crystallization (D1a), deferred to Epics 5-7. Verified by `test_BurnPair_ReducesPrincipal_Clamped`, `test_BurnPair_FullBurn_ZeroesPrincipal`, `test_BurnPair_PartialBurn_PrincipalStillCovered_Unchanged`.
- **No regressions to 4.1/4.2/4.3:** the bright line is a no-op when no principal is designated (`_principal == 0`), so all prior suites stay green; coupling stays intact (`invariant_LegSuppliesAlwaysEqual`, `test_DesignatePrincipal_DoesNotAffectCoupling`); 4.2 eligibility still gates principal-covered transfers (`test_PrincipalLockedTransfer_StillEligibilityGated`). `mintPair`/`burnPair`/`_pairing` and `ICoupledPair` were NOT changed.
- **Scope held:** no rule-spec→on-chain codegen / dual-plane vectors (4.5), no agent powers or Sepolia deploy (4.6), no reset/settlement mechanics (Epics 5-7). `@rose/rule-spec` untouched. `CoupledLeg._update` left `virtual`.
- **Gates:** Vitest 263/263 (unchanged — Solidity-only story), forge 121/121 (after the 2 code-review regression tests + handler strengthening), typecheck/lint/check:regime/check:migrations/format:check all green, `forge fmt --check` clean.

### File List

**Modified — Solidity contracts (`prod/contracts/src/token/`):**

- `CoupledLeg.sol` (segregated `_principal` mapping, `principalOf`, owner-gated `designatePrincipal`, Model-A bright-line + burn-clamp branches in `_update`, events `PrincipalDesignated`/`PrincipalReducedOnBurn`, NatSpec)
- `CoupledPair.sol` (owner-gated forwarders `designateLPrincipal`/`designateSPrincipal`)

**New — Foundry tests (`prod/contracts/test/token/`):**

- `CoupledLegPrincipal.t.sol` (20 unit + fuzz, incl. 2 code-review regressions)
- `CoupledLegPrincipalInvariant.t.sol` (handler + 3 invariants; handler strengthened in review to drive multi-holder-per-leg principal + S-leg egress)

**Modified:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: ready-for-dev → in-progress → review → done)
- `_bmad-output/implementation-artifacts/deferred-work.md` (story-4.4 deferrals)

## Change Log

| Date       | Version | Description                              | Author |
| ---------- | ------- | ---------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev | Amelia |
| 2026-06-16 | 0.2     | Implemented Model-A segregated principal sub-position + bright line on `CoupledLeg._update`; `CoupledPair` designation forwarders; Foundry unit/fuzz (18) + invariant (3) → forge 119; gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers); +2 regression tests (self-transfer fully-principal, recipient-with-principal stacking) + strengthened invariant handler (multi-holder-per-leg + S-leg egress probe) + event-param clarity rename → forge 121; 3 deferred, 3 dismissed; gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] Misleading event param `totalPrincipal` reads like a protocol-wide aggregate [CoupledLeg.sol:42-44] — renamed to `holderPrincipal` (it is the holder's per-address principal total) + clarified NatSpec.
- [x] [Review][Patch] Invariant assertions trivially true — handler only locked principal on alice-L / bob-S, so `principalOf(bob)` on L and `principalOf(alice)` on S were always 0 (2 of 4 assertions 0≤0); multi-holder-per-leg principal never driven [CoupledLegPrincipalInvariant.t.sol] — added `designateLPrincipalBob` + `designateSPrincipalAlice` so all four assertions are non-trivial.
- [x] [Review][Patch] Principal-egress probe was L-leg/alice only; S-leg egress not invariant-covered [CoupledLegPrincipalInvariant.t.sol] — added `attemptPrincipalEgressS` (bob on S) latching the same `principalEgressSucceeded` flag.
- [x] [Review][Patch] Self-transfer (`from == to`) with a fully-designated principal was untested [CoupledLegPrincipal.t.sol] — added `test_SelfTransfer_FullyPrincipal_NoPrincipalLeaves` (balance unchanged ⇒ bright line passes, no principal leaves).
- [x] [Review][Patch] Recipient already at `principal == balance` receiving more tokens (yield stacking on locked principal) was untested [CoupledLegPrincipal.t.sol] — added `test_Recipient_WithFullPrincipal_ReceivesMore_OnlyNewSurplusMovable` (only the new surplus moves; pre-existing principal stays locked).
- [x] [Review][Defer] Burn retires principal with no leg-level protection beyond owner+coupling gating [CoupledLeg.sol:84-101] — by-design: burn is `onlyOwner` (the pair) AND coupling-gated (`pairingInProgress`), so a holder cannot trigger it; redemption intentionally retires the coupled package incl. principal. Authoritative recovery/forced-burn semantics belong to Story 4.6 / reset (Epics 5-7). Deferred.
- [x] [Review][Defer] Additive `designatePrincipal` with no un-designate/release path ⇒ owner over-designation can permanently lock a holder's transferability until a pair-driven burn [CoupledLeg.sol:60-68] — owner-trusted (issuer), recoverable via burn-and-remint at reset; a "release/reclassify/crystallize principal" path is reset/settlement (Epics 5-7) and mirrors the existing `Ownable` single-key deferrals (4.2/4.3). Deferred.
- [x] [Review][Defer] Stranded-principal recovery for a revoked holder requires burning the counterparty leg (no single-leg principal release) [CoupledPair.sol burnPair] — by-design for 4.4; single-leg recovery / forced transfer is Story 4.6. Deferred.
- [Review][Dismiss] `designatePrincipal` has no zero-address/zero-amount guard (no-op `PrincipalDesignated` event possible) — owner-trusted, non-exploitable (require makes it a no-op for empty balances); cosmetic only.
- [Review][Dismiss] `designatePrincipal` overflow reverts with arithmetic panic `0x11` rather than the `"principal exceeds balance"` string — owner-only fat-finger requiring a ~2²⁵⁶ amount; not adversarially reachable.

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (5 patches applied — 1 clarity, 4 test-strengthening; no unresolved High/Med correctness issues)

Three parallel adversarial layers ran against the diff. **Blind Hunter** (no context, diff only) confirmed the two headline invariants HOLD — `_principal <= balanceOf` at the chokepoint and principal cannot leave via transfer — and that the bright line is reentrancy-robust (absolute post-transfer balance check, no external call in the added code, eligibility `isVerified` is a `view` STATICCALL); its material findings were the by-design burn-retires-principal path and the owner-trusted additive-designation lock-up (both deferred to 4.6 / Epics 5-7). **Edge-Case Hunter** found the contract logic sound and surfaced test-coverage gaps — chiefly that the mandatory invariant had two trivially-true assertions and a single-leg egress probe; these were patched (multi-holder-per-leg designation + S-leg egress probe + self-transfer & recipient-stacking regressions). **Acceptance Auditor** returned **PASS on AC-1 and AC-2** with NO scope creep: the segregation primitive + Model-A bright line are enforced on the shared `_update` chokepoint (eligibility 4.2 → coupling 4.3 → Model-A 4.4), the mandatory Foundry invariant exists and proves principal can never leave (`invariant_PrincipalNeverExceedsBalance`, `invariant_PrincipalEgressNeverSucceeds`), and 4.5 (codegen/dual-plane), 4.6 (agent powers/deploy) and reset/settlement (Epics 5-7) were NOT pulled forward; `@rose/rule-spec` untouched. After patches: forge 121/121 (3 invariants × 128 000 calls, 0 reverts), Vitest 263/263, full gate green, `forge fmt --check` clean.
</content>
