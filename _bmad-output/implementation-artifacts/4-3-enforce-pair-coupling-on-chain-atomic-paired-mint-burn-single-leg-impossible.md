---
baseline_commit: NO_VCS
---

# Story 4.3: Enforce pair coupling on-chain (atomic paired mint/burn, single-leg impossible)

Status: done

## Story

As a transfer-agent,
I want the contract to enforce that the two legs (L-Token / S-Token) are created and retired only as paired units,
so that the "never a single leg" rule (FR-6, FR-19 coupling) holds on-chain: minting or burning a single leg is atomically impossible.

## Acceptance Criteria

**AC-1 — A paired mint or burn moves both legs atomically (both-or-neither) at equal notional**
**Given** the custom contract's coupling logic
**When** a paired mint or burn is requested
**Then** both legs are minted/burned atomically (both-or-neither) at equal notional

**AC-2 — A single-leg operation that would break pair coupling is rejected; a Foundry invariant test proves coupling cannot be broken**
**Given** an attempt to transfer, mint, or burn a single leg that would break pair coupling
**When** the on-chain call is made
**Then** it is rejected, and a Foundry invariant test proves coupling cannot be broken

## Tasks / Subtasks

- [x] **Task 1 — Coupling interface (`ICoupledPair`) (AC: 1, 2)**
  - [x] `prod/contracts/src/token/interface/ICoupledPair.sol` — `interface ICoupledPair`. Coupling primitive surface: `function lToken() external view returns (IRoseToken);`, `function sToken() external view returns (IRoseToken);`, `function pairingInProgress() external view returns (bool);`, `function mintPair(address lTo, address sTo, uint256 amount) external;`, `function burnPair(address lFrom, address sFrom, uint256 amount) external;`. Events `event PairDeployed(address indexed lToken, address indexed sToken);`, `event PairMinted(address indexed lTo, address indexed sTo, uint256 amount);`, `event PairBurned(address indexed lFrom, address indexed sFrom, uint256 amount);`. SPDX `MIT`, `pragma solidity ^0.8.28;`. Import `IRoseToken` from `./IRoseToken.sol`.

- [x] **Task 2 — `CoupledLeg` (single leg, coupling-gated emission) (AC: 1, 2)**
  - [x] `prod/contracts/src/token/CoupledLeg.sol` — `contract CoupledLeg is RoseToken`. Constructor `(string name_, string symbol_, IIdentityRegistry registry_, address coupler_)` → `RoseToken(name_, symbol_, registry_, coupler_)` (the coupler is the `initialOwner`, so only the coupler may call the inherited owner-gated `mint`/`burn`). Store `address public immutable coupler = coupler_` after `require(coupler_ != address(0), "CoupledLeg: zero coupler")`.
  - [x] **Override `_update(address from, address to, uint256 value) internal virtual override`:** layer the coupling rule ON TOP of 4.2 eligibility (call `super._update` LAST so eligibility + the ERC20 mutation still run). A mint (`from == 0`) or burn (`to == 0`) is a single-leg emission and is ONLY valid while its coupler is mid pair-operation: `if (from == address(0) || to == address(0)) require(ICoupledPair(coupler).pairingInProgress(), "CoupledLeg: single-leg mint/burn");`. Plain transfers (`from != 0 && to != 0`) carry NO coupling restriction — legs are directionally/separately held (D1), and a transfer cannot change total supply so it cannot break the coupling invariant. Then `super._update(from, to, value);` (RoseToken eligibility chokepoint → OZ ERC20). Keep `_update` `virtual` so Story 4.4 (Model-A) can extend it.
  - [x] SPDX `MIT`, `pragma solidity ^0.8.28;`. Import `RoseToken`, `IIdentityRegistry`, `ICoupledPair`.

- [x] **Task 3 — `CoupledPair` (the coupling primitive / atomic paired mint-burn) (AC: 1, 2)**
  - [x] `prod/contracts/src/token/CoupledPair.sol` — `contract CoupledPair is Ownable, ICoupledPair`. Constructor `(IIdentityRegistry registry_, string lName, string lSymbol, string sName, string sSymbol, address initialOwner)` → `Ownable(initialOwner)`; `require(address(registry_) != address(0), "CoupledPair: zero registry")`; deploy BOTH legs owned by + couplered to `address(this)`: `lToken = new CoupledLeg(lName, lSymbol, registry_, address(this)); sToken = new CoupledLeg(sName, sSymbol, registry_, address(this));`; emit `PairDeployed`. This resolves the leg↔coupler cycle in one constructor and makes `CoupledPair` the SOLE minter/burner of both legs.
  - [x] State: `CoupledLeg public immutable lToken; CoupledLeg public immutable sToken; bool private _pairing;`. `lToken()/sToken()` getters return `IRoseToken` (interface) — expose the immutables typed as `IRoseToken` via explicit getter functions to satisfy `ICoupledPair` (the public immutables are typed `CoupledLeg`; add `function lToken() external view returns (IRoseToken)` only if the auto-getter type clashes with the interface — otherwise type the immutables as the interface and keep concrete refs internal). `pairingInProgress() external view returns (bool)` returns `_pairing`.
  - [x] `mintPair(address lTo, address sTo, uint256 amount) external onlyOwner`: set `_pairing = true`; `lToken.mint(lTo, amount); sToken.mint(sTo, amount);` set `_pairing = false`; emit `PairMinted(lTo, sTo, amount)`. EQUAL notional (same `amount` both legs). Atomic: if either leg's `_update` reverts (recipient not eligible, or coupling guard), the WHOLE tx reverts → both-or-neither, and `_pairing` is rolled back with it (no stuck flag).
  - [x] `burnPair(address lFrom, address sFrom, uint256 amount) external onlyOwner`: set `_pairing = true`; `lToken.burn(lFrom, amount); sToken.burn(sFrom, amount);` set `_pairing = false`; emit `PairBurned(lFrom, sFrom, amount)`. (Burn is sender-eligibility-EXEMPT in 4.2, so a revoked holder's coupled package can still be retired — supply not stranded.)
  - [x] SPDX `MIT`, `pragma solidity ^0.8.28;`. Import `Ownable`, `CoupledLeg`, `IRoseToken`, `IIdentityRegistry`, `ICoupledPair`.

- [x] **Task 4 — Foundry unit tests: atomic paired mint/burn + single-leg rejection (AC: 1, 2)**
  - [x] `prod/contracts/test/token/CoupledPair.t.sol` — `is ClaimFixtures`. In `setUp`, stand up the full identity stack exactly as `RoseToken.t.sol` does (`ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `IdentityRegistry` + agent, `ClaimIssuer` with `CLAIM_SIGNER_PK`, add KYC topic, trust issuer), register + verify two holder wallets (`alice`, `bob`), deploy `CoupledPair` owned by `address(this)`.
  - [x] **AC-1 paired mint:** `test_MintPair_MintsBothLegsEqualNotional` (mintPair(alice, bob, X) ⇒ `lToken.balanceOf(alice)==X`, `sToken.balanceOf(bob)==X`, both totalSupplies `==X`). `test_MintPair_ToSameHolder` (lTo==sTo==alice both legs credited). `test_BurnPair_BurnsBothLegs` (mint then burnPair reduces both equally). `test_MintPair_RevertWhen_NotOwner` (`Ownable.OwnableUnauthorizedAccount`).
  - [x] **AC-1 atomicity (both-or-neither):** `test_MintPair_RevertWhen_sLegRecipientNotEligible` — mintPair(alice eligible, stranger NOT eligible) reverts `"RoseToken: recipient not eligible"` AND asserts NEITHER leg minted (`lToken.totalSupply()==0 && sToken.totalSupply()==0`) — proves the L-leg mint rolled back with the S-leg failure. Mirror `test_MintPair_RevertWhen_lLegRecipientNotEligible`.
  - [x] **AC-2 single-leg impossible:** `test_LegMint_RevertWhen_CalledDirectlyByEOA` — `vm.prank(stranger); vm.expectRevert(OwnableUnauthorizedAccount); lToken.mint(alice, X)` (only the coupler/owner may mint a leg). `test_LegMint_RevertWhen_OwnerNotPairing` — prove the `_update` coupling guard independently of `Ownable`: deploy a standalone `CoupledLeg` owned by `address(this)` whose coupler is a real `CoupledPair` (whose `_pairing` is false), then `leg.mint(alice, X)` reverts `"CoupledLeg: single-leg mint/burn"` even though the caller IS the owner. Same for a direct `leg.burn`.
  - [x] **Coupling preserved by transfer:** `test_LegTransfer_Succeeds_BetweenVerified_PreservesCoupling` — pair-mint, transfer one leg alice→bob, assert balances move but BOTH totalSupplies (and thus coupling) unchanged.
  - [x] Naming: `test_*` unit, `test_RevertWhen_*` / `vm.expectRevert` for negative paths.

- [x] **Task 5 — Foundry INVARIANT test: coupling cannot be broken (AC: 2, mandatory)**
  - [x] `prod/contracts/test/token/CoupledPairInvariant.t.sol` — a handler + `invariant_*`. Handler `CoupledPairHandler` wraps `mintPair`, `burnPair` (bounded by current min totalSupply), and `transferLeg` (alice↔bob, bounded by balance) over the two PRE-VERIFIED actors; it is set as the `CoupledPair` owner so it can drive paired ops. The invariant test `setUp` builds the identity stack, registers actors, deploys the pair, transfers pair ownership to the handler, `targetContract(handler)`. `invariant_LegSuppliesAlwaysEqual()` asserts `lToken.totalSupply() == sToken.totalSupply()` after every fuzz sequence — proving no reachable sequence of paired ops + leg transfers can desynchronize the legs (i.e. coupling cannot be broken). Optionally also assert the handler's attempted single-leg mints always revert (ghost counter).
  - [x] Configure invariant runs in `foundry.toml` only if a `[invariant]` block is absent AND needed; otherwise rely on forge defaults (do NOT lower existing rigor).

- [x] **Task 6 — Format + gate (AC: 1, 2)**
  - [x] `forge fmt prod/contracts/src/token prod/contracts/test/token` (root prettier does NOT cover `.sol`). `forge build` then `forge test` — green, strictly ADDING to the forge baseline (77 → 77+new, incl. ≥1 invariant). TS gates untouched (Vitest stays 263). `forge fmt --check` clean on the new tree.

## Dev Notes

### Scope discipline (what 4.3 IS and IS NOT)

- **IN scope:** on-chain enforcement that the two legs (L-Token / S-Token) are **minted and burned together, atomically, at equal notional** — a single-leg mint or burn is structurally **impossible** (reverts). Modeled as **two coupled `CoupledLeg` tokens** (each a 4.2-eligibility-gated `RoseToken`) coordinated by a **`CoupledPair`** coupling primitive that is their sole minter/burner. Foundry unit tests (atomic both-or-neither, single-leg rejected) + a Foundry **invariant** test (`L.totalSupply == S.totalSupply` unbreakable). [Source: epics.md#Story 4.3; architecture.md#On-Chain Architecture "atomic paired mint/burn (never a single leg)"]
- **OUT of scope (do NOT pull forward):** the **Model-A bright line** + principal/yield segregated sub-positions (**Story 4.4**); rule-spec → on-chain compliance **codegen** + dual-plane conformance vectors (**Story 4.5** — 4.3 references the registry directly, no codegen); ERC-3643 **agent powers** (forced transfer, recovery, freeze, pause) + Sepolia `forge script` **deployment** (**Story 4.6**); the off-chain ledger mint/burn wiring + reconciliation (**Epic 5**). Keep `CoupledLeg._update` `virtual` so 4.4 can layer Model-A on the same chokepoint; do NOT implement Model-A here. [Source: epics.md#Stories 4.4–4.6, Epic 5; sprint-status.yaml]

### Design decision — coupling = atomic paired EMISSION, transfers are separate (D1)

- **D1 (resolved): L/S are directional/separate in HOLDING, but ISSUANCE stays paired (delta-neutral).** Therefore the correct on-chain coupling semantics are **atomic paired mint/burn** — NOT paired transfers. A plain leg transfer between two eligible holders cannot change either total supply, so it can never break the supply-coupling invariant; legs are independently transferable (subject to 4.2 eligibility). The "note = one leg" view (positions) is a layer ABOVE this in Epic 6, not the mint/burn coupling here. [Source: brief D1 note; PRD §3 "Coupled pair / Leg"; epics.md#Story 2.4 delta-neutral-at-issuance]
- **Coupling invariant:** `lToken.totalSupply() == sToken.totalSupply()` holds in EVERY reachable state. Both legs start at 0 (equal); the only supply-changing paths are `mintPair`/`burnPair`, which move BOTH legs by the SAME `amount`; single-leg mint/burn reverts. Hence the invariant is preserved by construction and proven by the Foundry invariant fuzzer. [Source: epics.md#Story 4.3 AC; FR-6 "schema cannot represent a persistent single-leg pair" — the on-chain analogue]

### Reuse — do NOT reinvent (load-bearing)

- **`RoseToken` (Story 4.2) is the leg base.** Its `_update` is the single eligibility chokepoint and is `virtual` precisely so 4.3 can extend it; its `mint`/`burn` are `onlyOwner`. `CoupledLeg is RoseToken` overrides `_update` (calling `super._update` LAST to keep eligibility) and inherits the owner-gated `mint`/`burn`. Do NOT re-implement eligibility or re-override `transfer`/`_mint`/`_burn`. [Source: prod/contracts/src/token/RoseToken.sol:45-78; 4-2 story Task 2]
- **Owner-as-coupler makes single-leg mint impossible at the entry point.** Deploying both legs with `initialOwner = address(CoupledPair)` means an external EOA cannot call `leg.mint`/`leg.burn` (Ownable reverts); only `CoupledPair` can, and it ONLY does so in pairs. The `_update` `pairingInProgress()` guard is the defense-in-depth that makes coupling unbreakable even if a leg's ownership were ever changed — and gives the invariant test real teeth. [Source: prod/contracts/lib/openzeppelin-contracts/contracts/access/Ownable.sol; RoseToken.sol:45-52]
- **Reuse `Ownable(initialOwner)` from OZ** for `CoupledPair` (issuer/transfer-agent owner gating `mintPair`/`burnPair`), consistent with `RoseToken`/`IdentityRegistry`. The transfer-agent role formalization is **Story 4.6**; `onlyOwner` on the paired ops is the 4.3 minimum. [Source: prod/contracts/src/token/RoseToken.sol; 4-2 story Dev Notes]
- **Reuse the test harness:** mirror `RoseToken.t.sol#setUp` (the full identity stack + `_registerVerified(wallet)` helper) and `ClaimFixtures` (`CLAIM_SIGNER_PK`, `_signClaim`). [Source: prod/contracts/test/token/RoseToken.t.sol:39-71; prod/contracts/test/identity/ClaimFixtures.sol]

### Burn exemption interaction (from 4.2 review)

- 4.2's `_update` EXEMPTS burn (`to == 0`) from the `isVerified(from)` sender check, so `burnPair` can retire a revoked/de-listed holder's coupled package (supply reduction is never stranded). 4.3 adds the coupling guard on top (burn still requires `pairingInProgress()`), so a revoked holder's package is burnable ONLY as a pair via the coupler — single-leg burn of one side remains impossible. [Source: 4-2 story Review Findings (burn-stranding patch); RoseToken.sol:54-77]

### Architecture constraints

- **Stack (D2):** custom ERC-3643-compatible suite on **OpenZeppelin Contracts 5.6.1**; **Foundry** toolchain with **fuzz + invariant** testing to prove compliance rules (coupling). Target Sepolia (deploy deferred to 4.6). [Source: architecture.md#On-Chain Architecture; architecture.md#Selected Approach]
- **Foundry config pinned:** `foundry.toml` → `solc = "0.8.28"`, `evm_version = "cancun"`. New Solidity MUST compile under `0.8.28`; `pragma solidity ^0.8.28;`. [Source: prod/contracts/foundry.toml]
- **OZ remapping wired:** `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`, `forge-std/=lib/forge-std/src/`. Import OZ `access/Ownable.sol`; do NOT vendor. [Source: prod/contracts/remappings.txt]
- **Numeric representation (NFR-2):** token amounts are **18-decimal `uint256`** smallest-unit integers; no float. Equal notional = identical `uint256 amount` on both legs. [Source: architecture.md#Data Architecture]
- **Regime boundary:** PROD contracts under `prod/contracts/`. Never reference `/throwaway`. Solidity is outside the pnpm workspace, so TS gates are unaffected by Solidity additions. [Source: pnpm-workspace.yaml; architecture.md#Project Structure]

### Single-source alignment

- 4.3 enforces the **pair-coupling** plane of the rule-spec ("never a single leg") on-chain by construction (coupled tokens + paired mint/burn). The rule-spec → on-chain **codegen** that would emit any coupling config is **Story 4.5**; 4.3 expresses coupling structurally in the contracts, not via generated config. Do NOT edit `@rose/rule-spec` (Epic 3 done). [Source: architecture.md#Off-Chain↔On-Chain Rule Equivalence; epics.md#Story 4.5]

### Project Structure Notes

- New tree: `prod/contracts/src/token/CoupledLeg.sol`, `prod/contracts/src/token/CoupledPair.sol`, `prod/contracts/src/token/interface/ICoupledPair.sol`; tests `prod/contracts/test/token/CoupledPair.t.sol` + `prod/contracts/test/token/CoupledPairInvariant.t.sol`. Parallels the 4.2 `src/token` + `test/token` layout. [Source: architecture.md#Complete Project Directory Structure; 4-2 story Project Structure Notes]
- Run `forge fmt prod/contracts/src/token prod/contracts/test/token` before finishing; root `prettier` globs are ts/tsx/mjs/json/md/yml/yaml only. The root `bmad-pipeline-report.md` IS prettier-checked — keep appended markdown prettier-clean. [Source: package.json format globs; 4-2 story]

### Testing standards

- **Solidity tests** in `prod/contracts/test/**/*.t.sol`, run by `forge test` (incl. fuzz AND **invariant** — NFR-6 test-first on invariants). Naming: `test_*` unit, `testFuzz_*` fuzz, `invariant_*` invariant, `vm.expectRevert` for negative paths. Use `vm.prank`/`vm.startPrank` for caller identity. The invariant test needs a handler exposing the state-mutating surface to the fuzzer + `targetContract`. [Source: architecture.md#On-Chain Architecture "fuzzing and invariant testing"; prod/contracts/test/token/RoseToken.t.sol]
- **Write the load-bearing negative path:** *no single leg can ever be minted or burned alone* — prove every single-leg branch reverts (EOA direct mint = Ownable; owner-but-not-pairing = coupling guard), and that a failed paired mint rolls BOTH legs back (atomicity). The invariant (`equal supplies`) is the positive structural proof. [Source: epics.md#Story 4.3 AC-2; FR-6]
- **Baseline before this story: forge 77/77, Vitest 263/263.** This story adds Solidity only; TS gates must stay 263 green and unchanged, forge must grow (77 → 77+new) with zero regressions. [Source: 4-2 story Testing standards; bmad-pipeline-report.md]

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 / Story 4.3]
- [Source: _bmad-output/planning-artifacts/architecture.md#On-Chain Architecture]
- [Source: _bmad-output/implementation-artifacts/4-2-enforce-eligibility-on-transfers-in-the-custom-erc-3643-compatible-token.md]
- [Source: prod/contracts/src/token/RoseToken.sol; src/token/interface/IRoseToken.sol]
- [Source: prod/contracts/src/identity/interface/IIdentityRegistry.sol]
- [Source: prod/contracts/foundry.toml; prod/contracts/remappings.txt]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `forge build` compiled cleanly. The only `forge fmt`/`forge lint` notes are PRE-EXISTING advisories (named-struct-fields on `Identity.sol`, screaming-snake-case immutables / unchecked-transfer warnings already present across the identity + 4.2 suite). `forge fmt --check` is clean across the contracts tree (exit 0). The new `coupler`/`_lToken`/`_sToken` immutables use camelCase consistent with the existing suite's public immutables (`IdentityRegistry.claimTopicsRegistry`).
- `forge test`: 95/95 (77 pre-existing + 18 new across `CoupledPair.t.sol` (16) and `CoupledPairInvariant.t.sol` (2 invariants)). Both invariants ran 256 runs × 500 calls = 128 000 calls each, 0 reverts: `invariant_LegSuppliesAlwaysEqual` and `invariant_SingleLegMintNeverSucceeds`.

### Completion Notes List

- Delivered on-chain pair coupling as **two coupled `CoupledLeg` tokens** (each a 4.2-eligibility-gated `RoseToken`) coordinated by a **`CoupledPair`** primitive that owns and is the SOLE minter/burner of both legs. `mintPair`/`burnPair` move BOTH legs by the same `uint256 amount` in one transaction → atomic, equal-notional. The leg↔coupler cycle is resolved by `CoupledPair` deploying both legs in its constructor with `initialOwner == coupler == address(this)`.
- **AC-1 (atomic paired mint/burn at equal notional):** met — `test_MintPair_MintsBothLegsEqualNotional`, `test_MintPair_ToSameHolder`, `test_BurnPair_BurnsBothLegs`, plus the both-or-neither atomicity proofs `test_MintPair_RevertWhen_sLegRecipientNotEligible` / `_lLegRecipientNotEligible` (an ineligible recipient on EITHER leg reverts the whole tx and asserts NEITHER leg minted), and `testFuzz_MintPair_KeepsLegsEqual`.
- **AC-2 (single-leg impossible; invariant proves coupling unbreakable):** met — single-leg mint/burn is blocked on TWO independent layers: (a) the legs' inherited owner-gated `mint`/`burn` are owned by the pair, so an EOA reverts with `OwnableUnauthorizedAccount` (`test_LegMint/Burn_RevertWhen_CalledDirectlyByEOA`); (b) the `CoupledLeg._update` coupling guard requires `pairingInProgress()`, so even the owner cannot single-leg mint/burn outside the paired flow (`test_LegMint/Burn_RevertWhen_OwnerNotPairing`, proven on a standalone leg owned by the test). The Foundry invariant `invariant_LegSuppliesAlwaysEqual` proves `lToken.totalSupply() == sToken.totalSupply()` after any reachable sequence of paired mints/burns + leg transfers, and `invariant_SingleLegMintNeverSucceeds` confirms a direct single-leg mint never lands.
- **D1 honored:** legs are independently transferable (directional/separate holding), but a transfer cannot change either total supply, so it cannot break the coupling invariant — `test_LegTransfer_Succeeds_BetweenVerified_PreservesCoupling` shows balances move while supplies (coupling) stay equal; `test_LegTransfer_RevertWhen_RecipientNotVerified` confirms 4.2 eligibility still gates leg transfers. Coupling is on EMISSION, not on transfer.
- **Reuse, not reinvention:** `CoupledLeg is RoseToken` extends the 4.2 `virtual _update` (calls `super._update` LAST → eligibility + ERC20 mutation intact); inherits the owner-gated `mint`/`burn` and the burn sender-exemption (a revoked holder's coupled package is still retirable as a pair). Reuses `Ownable`, `ClaimFixtures`, and the `RoseToken.t.sol` identity-harness setUp. `@rose/rule-spec` NOT modified.
- **Scope held:** no Model-A principal/yield (4.4), no rule-spec→on-chain codegen / dual-plane vectors (4.5), no agent powers or Sepolia deploy script (4.6), no off-chain ledger wiring (Epic 5). `CoupledLeg._update` left `virtual` so 4.4 layers Model-A on the same chokepoint.
- **Gates:** Vitest 263/263 (unchanged — Solidity-only story), forge 98/98 (77 → +21 after the 3 code-review regression tests), typecheck/lint/check:regime/check:migrations/format:check all green, `forge fmt --check` clean.

### File List

**New — Solidity contracts (`prod/contracts/src/token/`):**

- `interface/ICoupledPair.sol`
- `CoupledLeg.sol`
- `CoupledPair.sol`

**New — Foundry tests (`prod/contracts/test/token/`):**

- `CoupledPair.t.sol` (19 unit + fuzz, incl. 3 code-review regressions)
- `CoupledPairInvariant.t.sol` (handler + 2 invariants)

**Modified:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions: ready-for-dev → in-progress → review → done)
- `_bmad-output/implementation-artifacts/deferred-work.md` (story-4.3 deferrals)

## Change Log

| Date       | Version | Description                                                                                                                          | Author |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev                                                                                         | Amelia |
| 2026-06-16 | 0.2     | Implemented CoupledLeg + CoupledPair + ICoupledPair; Foundry unit/fuzz (16) + invariant (2) tests → forge 95; gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers); +3 regression tests (zero-address leg target ×2, asymmetric burn atomicity) → forge 98; 4 deferred, 2 dismissed; gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] A zero-address leg target on a paired op must revert atomically — never become a silent no-op that desyncs the legs. CONFIRMED safe by construction: OZ `_mint`/`_burn` revert (`ERC20InvalidReceiver`/`ERC20InvalidSender`) on the zero account BEFORE `_update`, so `mintPair(0, …)` / `burnPair(…, 0)` revert before either leg is touched. Locked with regression tests `test_MintPair_RevertWhen_lToIsZero`, `test_BurnPair_RevertWhen_sFromIsZero` (assert both supplies unchanged + equal). Raised by Edge-Case Hunter (Med — coupling-critical defensive lock).
- [x] [Review][Patch] `burnPair` atomicity under ASYMMETRIC balances was not directly tested — if one holder lacks the balance, the failing leg must roll the other back. Added `test_BurnPair_RevertWhen_AsymmetricBalance` (move part of alice's L away, burnPair sized to her original L reverts `ERC20InsufficientBalance` and leaves both supplies equal/unchanged). Raised by Edge-Case Hunter (Med).
- [x] [Review][Defer] `CoupledPair` is `Ownable` single-key: `renounceOwnership()` (inherited) would permanently brick `mintPair`/`burnPair`; single-step `transferOwnership` is a footgun; no transfer-agent role separation or multisig. Same posture as `RoseToken` (4.2 deferral) — the role formalization + multisig lands with **Story 4.6** / deployment ops.
- [x] [Review][Defer] The legs' inherited `setIdentityRegistry` (owner = the pair) is not forwarded through `CoupledPair`, so each leg's registry is effectively frozen post-deploy. Safer for 4.3 (no registry-swap surface), but a registry-migration path + holder-continuity guard is an ops/**4.6** concern (mirrors the 4.2 `setIdentityRegistry` continuity deferral).
- [x] [Review][Defer] Unbounded claims-per-topic OOG on the leg mint/transfer hot path — inherited from `RoseToken._update` → `isVerified` (4.1/4.2 deferrals). Blast radius is holder-self-griefing only; burn is sender-exempt. Revisit a verification-scan cap alongside **Story 4.6** recovery design.
- [Review][Dismiss] Reentrancy while `_pairing == true` (a recipient re-entering to mint a single extra leg) — false positive: plain OZ ERC20 `_mint` invokes NO recipient callback (no ERC777/1363 hook), and `isVerified` is a `view` STATICCALL. There is no external call to an untrusted party between setting `_pairing` and resetting it, so the flag cannot be exploited; confirmed by the 128 000-call invariant (0 reverts, supplies always equal).
- [Review][Dismiss] "Transfers should be paired too" (AC-2 mentions transferring a single leg) — by-design per D1: L/S are directional/separate in HOLDING, and a transfer cannot change either total supply, so it can NEVER break the supply-coupling invariant. Coupling is enforced on EMISSION (mint/burn); leg transfers stay eligibility-gated (4.2). Proven by `test_LegTransfer_Succeeds_BetweenVerified_PreservesCoupling` + the invariant (which fuzzes leg transfers).

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (2 defensive regression patches; no unresolved High/Med)

Three parallel adversarial layers ran against the diff: **Blind Hunter** (correctness — reentrancy around the `_pairing` flag, stuck-flag-on-revert, equal-notional invariant from a clean start), **Edge-Case Hunter** (zero-address leg targets, asymmetric burn balances, transfer-to-zero, zero-amount pairs), and **Acceptance Auditor** (vs epic/architecture/brief). The Acceptance Auditor returned **PASS on AC-1 and AC-2** — atomic paired mint/burn at equal notional, single-leg mint/burn impossible on two independent layers (owner-as-coupler + the `_update` coupling guard), and the mandatory Foundry invariant (`lToken.totalSupply() == sToken.totalSupply()`, 256 runs × 500 calls × 2 invariants = 256 000 calls, 0 reverts) proving coupling cannot be broken — with no scope creep and `@rose/rule-spec` unmodified. The Edge-Case Hunter surfaced the only material findings: a zero-address leg target and an asymmetric burn must both revert ATOMICALLY (else the legs could desync). Both are safe by construction (OZ reverts on the zero account before `_update`; a reverting leg rolls the whole tx back), and both are now locked with regression tests. Remaining findings (single-key `Ownable`, registry-swap continuity, claims-per-topic OOG) are owner-trusted/recoverable or explicitly belong to Story 4.6; deferred and recorded in deferred-work.md.
</content>
