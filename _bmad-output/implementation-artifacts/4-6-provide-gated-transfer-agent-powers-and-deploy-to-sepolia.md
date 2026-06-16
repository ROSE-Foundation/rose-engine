---
baseline_commit: NO_VCS
---

# Story 4.6: Provide gated transfer-agent powers and deploy to Sepolia

Status: done

## Story

As a transfer-agent / administrator,
I want forced transfer, recovery (lost-key reissue), freeze (address + partial amount), and pause callable ONLY by the transfer-agent role, plus a `forge script` that deploys the whole suite in the order the prior stories validated,
so that privileged lifecycle operations are available and safely restricted (FR-22), and the on-chain plane is deployable to Sepolia from one rule-spec-derived script.

## Acceptance Criteria

**AC-1 — Agent powers are GATED to the transfer-agent role (non-agent reverts, agent succeeds)**
**Given** the deployed token suite with a transfer-agent granted the agent role (reusing `AgentRole`)
**When** an agent power — forced transfer, recovery, address freeze, partial-token freeze/unfreeze, pause, or unpause — is called by a NON-agent address
**Then** the call reverts (`AgentRole: caller is not an agent`); called by the authorized transfer-agent it succeeds, and forge tests cover EACH power's allowed-by-agent and rejected-for-non-agent paths.

**AC-2 — Lost-key recovery reissues the balance to a new wallet, preserving eligibility and the audit trail**
**Given** a holder whose key is lost (and whose claim may even be revoked) holding L and/or S tokens (possibly with segregated principal and/or frozen tokens)
**When** the transfer-agent performs `recoveryAddress(lostWallet, newWallet)`
**Then** the holder's FULL balance is reissued to `newWallet` (which MUST be `isVerified` — eligibility preserved), the segregated principal sub-position and freeze state move WITH the balance (continuity / Model-A consistency), a `RecoverySuccess` event is emitted (audit trail), and the coupling supply invariant (`lToken.totalSupply() == sToken.totalSupply()`) is unbroken (recovery is a transfer, not a mint/burn).

**AC-3 — Forced transfer, freeze and pause enforce the documented semantics on the single `_update` chokepoint**
**Given** the eligibility / coupling / Model-A chokepoint from 4.2/4.3/4.4
**When** an agent forces a transfer out of a holder (even a revoked or address-frozen one), or freezes an address / partial tokens, or pauses the token
**Then**: forced transfer bypasses the SENDER-eligibility check, address-freeze and pause (the agent override) but the RECIPIENT must still be `isVerified` AND the Model-A bright line still holds (principal cannot leave via forced transfer — only via recovery or redemption burn); a frozen address cannot send/receive in a NORMAL transfer; partial-frozen tokens are not movable by a normal transfer; a paused token rejects normal `transfer`/`transferFrom` but the agent's forced/recovery powers and the owner's mint/burn still function; forge tests (incl. fuzz on the non-agent rejection) cover every branch.

**AC-4 — A `forge script` deploys the suite in the validated order from the generated rule-spec config, refusing if network secrets are absent**
**Given** the `GeneratedComplianceConfig` (Story 4.5) and the contract suite
**When** the deploy script's pure `deploy(...)` is exercised LOCALLY (forge in-process EVM, NO `--broadcast`)
**Then** it deploys in order — ClaimTopicsRegistry → TrustedIssuersRegistry → IdentityRegistry → seed topics via `GeneratedComplianceConfig.seedClaimTopics` (NOT hand-written topics) → ClaimIssuer (trusted for `GeneratedComplianceConfig.requiredClaimTopics()`) → grant the identity agent → `CoupledPair(...)` → grant the transfer-agent on both legs → hand ownership to the final owner — and a forge test proves the resulting suite is wired (topics == generated, a registered+claimed holder is `isVerified`, the transfer-agent `isAgent` on both legs, the final owner owns every contract).
**And** the broadcast entrypoint `run()` REFUSES cleanly when `SEPOLIA_RPC_URL` or the deployer key / role addresses are absent (refuse-if-absent: `vm.envAddress`/`vm.envUint` revert on missing, plus an explicit `SEPOLIA_RPC_URL` guard) — NO placeholder, NO default secret, NO `.env` created. The REAL Sepolia broadcast is a deferred ops step (documented in `deferred-work.md`).

## Tasks / Subtasks

- [x] **Task 1 — Extend `AgentRole` reach onto the token + add agent-power surface to `IRoseToken` (AC: 1, 2, 3)**
  - [x] `prod/contracts/src/token/interface/IRoseToken.sol` — ADD the agent-power surface to the token interface (keep all existing members): events `AddressFrozen(address indexed userAddress, bool isFrozen)`, `TokensFrozen(address indexed userAddress, uint256 amount)`, `TokensUnfrozen(address indexed userAddress, uint256 amount)`, `RecoverySuccess(address indexed lostWallet, address indexed newWallet, uint256 amount)`; views `isFrozen(address) returns (bool)`, `frozenTokens(address) returns (uint256)`; functions `setAddressFrozen(address,bool)`, `freezePartialTokens(address,uint256)`, `unfreezePartialTokens(address,uint256)`, `pause()`, `unpause()`, `forcedTransfer(address from,address to,uint256 amount) returns (bool)`, `recoveryAddress(address lostWallet,address newWallet) returns (bool)`. Update the title NatSpec to note 4.6 adds the transfer-agent powers. Do NOT redeclare `paused()` (it comes from OZ `Pausable`).

- [x] **Task 2 — Implement gated transfer-agent powers on `RoseToken` (AC: 1, 2, 3)**
  - [x] `prod/contracts/src/token/RoseToken.sol` — change inheritance to `contract RoseToken is ERC20, AgentRole, Pausable, IRoseToken` (import `AgentRole` from `../identity/AgentRole.sol`, `Pausable` from `@openzeppelin/contracts/utils/Pausable.sol`; REMOVE the now-redundant direct `Ownable` import — `Ownable` arrives transitively via `AgentRole`, but the constructor still initializes `Ownable(initialOwner)`). This grants the token `addAgent`/`removeAgent`/`isAgent`/`onlyAgent` (the transfer-agent role primitive) — reusing `AgentRole`, no new role contract. The legs inherit all of this through `CoupledLeg is RoseToken`.
  - [x] State: `mapping(address => bool) private _frozen;`, `mapping(address => uint256) private _frozenTokens;`, and TWO transient flags `bool private _agentBypass;` (true during forced/recovery: skip the SENDER-eligibility check in `_update`) and `bool private _recovering;` (true during recovery only: also bypass the Model-A bright line + move principal — consulted by `CoupledLeg`). Expose `function _agentActionInProgress() internal view returns (bool)` and `function _recoveryInProgress() internal view returns (bool)` for the `CoupledLeg` override. Add views `isFrozen`/`frozenTokens`.
  - [x] Freeze admin (all `onlyAgent`): `setAddressFrozen(addr, freeze)` sets `_frozen` + emits `AddressFrozen`; `freezePartialTokens(addr, amount)` requires `_frozenTokens[addr] + amount <= balanceOf(addr)`, increments, emits `TokensFrozen`; `unfreezePartialTokens(addr, amount)` requires `amount <= _frozenTokens[addr]`, decrements, emits `TokensUnfrozen`.
  - [x] Pause admin (`onlyAgent`): `pause()` → `_pause()`, `unpause()` → `_unpause()`.
  - [x] Override the USER movement paths to enforce pause + freeze (so agent powers, which call `_transfer`/`_update` directly, bypass them): `function transfer(address to, uint256 value) public override(ERC20, IERC20) whenNotPaused returns (bool)` and `function transferFrom(address from, address to, uint256 value) public override(ERC20, IERC20) whenNotPaused returns (bool)`; each first calls a private `_requireMovable(from, to, value)` that requires `!_frozen[from] && !_frozen[to]` (`RoseToken: frozen address`) and `balanceOf(from) - _frozenTokens[from] >= value` (`RoseToken: insufficient unfrozen balance`), then `super.transfer/transferFrom`. (Determine the exact `override(...)` list the compiler requires; `override(ERC20, IERC20)` is expected since `IRoseToken is IERC20`.)
  - [x] `forcedTransfer(from, to, amount) onlyAgent returns (bool)`: require `to != 0`, `from != 0`, `balanceOf(from) >= amount`; if `amount` exceeds the unfrozen balance, auto-thaw the shortfall from `_frozenTokens[from]` (emit `TokensUnfrozen`) — canonical ERC-3643 "forced transfer can move frozen tokens"; then `_agentBypass = true; _transfer(from, to, amount); _agentBypass = false;`. Goes through `_update` so the RECIPIENT-eligibility check still runs (sender skipped via `_agentBypass`); for a leg the Model-A bright line STILL applies (not recovering) so principal cannot leave via forced transfer.
  - [x] `recoveryAddress(lostWallet, newWallet) onlyAgent returns (bool)`: require both non-zero and `newWallet != lostWallet`; `uint256 bal = balanceOf(lostWallet); require(bal > 0, "RoseToken: nothing to recover");`; capture `uint256 frozenAmt = _frozenTokens[lostWallet]; bool wasFrozen = _frozen[lostWallet];`; set `_agentBypass = true; _recovering = true; _transfer(lostWallet, newWallet, bal); _recovering = false; _agentBypass = false;` (recipient must be `isVerified` ⇒ eligibility preserved; for a leg, principal moves with the balance — see Task 3); then carry continuity: `_frozenTokens[lostWallet] = 0; _frozenTokens[newWallet] += frozenAmt;` and `if (wasFrozen) { _frozen[newWallet] = true; }`; emit `RecoverySuccess(lostWallet, newWallet, bal)`.
  - [x] `_update` override — add the agent bypass and the burn-frozen-clamp: keep recipient `isVerified` check; change the sender check to `if (from != address(0) && !_agentBypass) { require(isVerified(from), "RoseToken: sender not eligible"); }`; call `super._update`; THEN if `from != 0 && to == 0` (burn) clamp `_frozenTokens[from]` down to `balanceOf(from)` if it exceeds it (emit `TokensUnfrozen` for the delta) so the `_frozenTokens[a] <= balanceOf(a)` invariant holds after an owner burn. Keep `_update` `virtual` (CoupledLeg still extends it).
  - [x] Update the contract/`_update` NatSpec: document the agent override (sender-eligibility/freeze/pause bypassed by forced ops; recipient + Model-A still enforced; recovery additionally moves principal + bypasses the bright line), and that pause/freeze are enforced on the USER `transfer`/`transferFrom` paths so agent powers operate beneath them.

- [x] **Task 3 — Make `CoupledLeg` move segregated principal on recovery; keep the bright line on forced transfer (AC: 2, 3)**
  - [x] `prod/contracts/src/token/CoupledLeg.sol` — in the `_update` transfer branch (`from != 0 && to != 0`), replace the unconditional bright-line check with: `if (_recoveryInProgress()) { uint256 p = _principal[from]; if (p > 0) { _principal[from] = 0; _principal[to] += p; emit PrincipalRecovered(from, to, p); } }` (recovery moves the WHOLE balance, so the WHOLE principal follows — `_principal[to] += p <= balanceOf(to)` holds because the full `from` balance ≥ `p` was just credited) `else { require(balanceOf(from) >= _principal[from], "CoupledLeg: principal cannot leave position"); }`. Add event `PrincipalRecovered(address indexed from, address indexed to, uint256 amount)`. Leave the coupling guard (mint/burn `pairingInProgress`) and the burn-clamp branch UNCHANGED — forced transfer / recovery are transfers, never single-leg mint/burn.
  - [x] Update NatSpec: recovery relocates a holder's segregated principal to the new wallet (resolves the 4.4 deferral "single-leg recovery / forced transfer to a new wallet is Story 4.6"); a plain forced transfer still cannot move principal (Model-A bright line preserved — principal leaves a position ONLY via authorized redemption burn or full recovery).

- [x] **Task 4 — `CoupledPair` forwarders to grant/revoke the transfer-agent role on both legs (AC: 1, 4)**
  - [x] `prod/contracts/src/token/CoupledPair.sol` — add `addLegAgent(address agent) external onlyOwner` (calls `_lToken.addAgent(agent); _sToken.addAgent(agent);`) and `removeLegAgent(address agent) external onlyOwner` (both `removeAgent`). The legs are owned by the pair, so `AgentRole.addAgent` (`onlyOwner`) on a leg is reachable ONLY through these forwarders — this is how the deployer grants the transfer-agent on both legs in one call. The agent then calls `forcedTransfer`/`recoveryAddress`/`setAddressFrozen`/`pause` DIRECTLY on each leg. (Do NOT route per-call powers through the pair — they are leg-scoped transfers that cannot break the supply-coupling invariant.) Add the two methods to `prod/contracts/src/token/interface/ICoupledPair.sol` with NatSpec, plus events `LegAgentAdded(address indexed agent)` / `LegAgentRemoved(address indexed agent)`.

- [x] **Task 5 — `forge script` deploy in the validated order, refuse-if-absent on secrets (AC: 4)**
  - [x] `prod/contracts/script/DeployRoseSuite.s.sol` — `contract DeployRoseSuite is Script`. Define `struct DeployConfig { address setupOwner; address finalOwner; address transferAgent; address identityAgent; address claimSigner; uint16 country; }` and `struct DeployedAddresses { address topicsRegistry; address issuersRegistry; address identityRegistry; address claimIssuer; address pair; address lToken; address sToken; }`.
  - [x] `function deploy(DeployConfig memory cfg) public returns (DeployedAddresses memory a)` — the PURE, broadcast-free deployment (so it is callable from a forge test AND from `run()` under broadcast). Order: (1) `ClaimTopicsRegistry topics = new ClaimTopicsRegistry(cfg.setupOwner);` (2) `TrustedIssuersRegistry issuers = new TrustedIssuersRegistry(cfg.setupOwner);` (3) `IdentityRegistry idReg = new IdentityRegistry(cfg.setupOwner, topics, issuers);` (4) `GeneratedComplianceConfig.seedClaimTopics(topics);` — topics from the generated lib, NOT hand-written (the `setupOwner` is the topics owner, so this `onlyOwner` call passes); (5) `ClaimIssuer issuer = new ClaimIssuer(cfg.setupOwner);` then `issuer.addKey(keccak256(abi.encode(cfg.claimSigner)), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());` and `issuers.addTrustedIssuer(IClaimIssuer(address(issuer)), GeneratedComplianceConfig.requiredClaimTopics());`; (6) `idReg.addAgent(cfg.identityAgent);` (the agent that will register holders at runtime — Epic 5); (7) `CoupledPair pair = new CoupledPair(idReg, "ROSE Long", "ROSE-L", "ROSE Short", "ROSE-S", cfg.setupOwner);`; (8) `pair.addLegAgent(cfg.transferAgent);` (grant the transfer-agent on both legs); (9) hand over: add `cfg.finalOwner` as a `MANAGEMENT_KEY` on the claim issuer (`issuer.addKey(keccak256(abi.encode(cfg.finalOwner)), issuer.MANAGEMENT_KEY(), issuer.ECDSA_TYPE())`), then `topics.transferOwnership(cfg.finalOwner); issuers.transferOwnership(cfg.finalOwner); idReg.transferOwnership(cfg.finalOwner); pair.transferOwnership(cfg.finalOwner);`. Populate + return `DeployedAddresses`. CRITICAL ownership note: under `vm.startBroadcast(pk)` the script's calls have `msg.sender == vm.addr(pk)`, so `run()` MUST set `cfg.setupOwner = vm.addr(pk)`; in a plain test the script's calls have `msg.sender == address(script)`, so the test MUST set `cfg.setupOwner = address(scriptInstance)`.
  - [x] `function run() external returns (DeployedAddresses memory)` — the BROADCAST entrypoint (deferred real ops). First `_refuseIfNetworkAbsent()`; then `uint256 pk = vm.envUint("ROSE_DEPLOYER_PRIVATE_KEY");` (reverts if absent — refuse-if-absent, NO default); build `DeployConfig` with `setupOwner: vm.addr(pk)`, `finalOwner: vm.envAddress("ROSE_TOKEN_OWNER")`, `transferAgent: vm.envAddress("ROSE_TRANSFER_AGENT")`, `identityAgent: vm.envAddress("ROSE_IDENTITY_AGENT")`, `claimSigner: vm.envAddress("ROSE_CLAIM_SIGNER")`, `country: uint16(vm.envOr("ROSE_INVESTOR_COUNTRY", uint256(0)))` (country is not a secret; 0 is an acceptable non-correctness-critical default); `vm.startBroadcast(pk); a = deploy(cfg); vm.stopBroadcast();`; `_log(a)`; return.
  - [x] `function _refuseIfNetworkAbsent() internal view` — `string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string("")); require(bytes(rpc).length > 0, "DeployRoseSuite: SEPOLIA_RPC_URL absent (refuse-if-absent); provide network secrets out-of-band before broadcast");`. This is the explicit, clean refusal demanded by the user decision — NO placeholder RPC, NO default key.
  - [x] `function _log(DeployedAddresses memory a) internal view` — `console2.log` each deployed address (the addresses to be "recorded in config", §8 Q4). Import `console2` from forge-std. Use SPDX `MIT`, `pragma solidity ^0.8.28;` (NOT the Counter script's `UNLICENSED`/`^0.8.13`).

- [x] **Task 6 — Forge tests: every agent power + gating + recovery + Model-A/coupling preservation (AC: 1, 2, 3)**
  - [x] `prod/contracts/test/token/AgentPowers.t.sol` — stand up the full identity stack + a `CoupledPair` exactly like `CoupledPair.t.sol#setUp` (reuse `ClaimFixtures`, seed topics via `GeneratedComplianceConfig.seedClaimTopics`), register verified holders (`alice`, `bob`, `carol`), and grant `agent` the transfer-agent role on the legs via `pair.addLegAgent(agent)`. Cover, on a leg (and a couple on a bare `RoseToken` for the standalone path):
    - GATING (AC-1): for EACH power (`setAddressFrozen`, `freezePartialTokens`, `unfreezePartialTokens`, `pause`, `unpause`, `forcedTransfer`, `recoveryAddress`) a `test_RevertWhen_<Power>_NotAgent` asserting `vm.expectRevert(bytes("AgentRole: caller is not an agent"))` for a non-agent caller, and a `test_<Power>_Succeeds_ByAgent` happy path.
    - FORCED TRANSFER (AC-3): agent forces tokens out of a holder whose claim was REVOKED (sender-eligibility bypassed) to an eligible recipient; reverts if recipient NOT eligible (`RoseToken: recipient not eligible`); forced transfer of a holder's YIELD surplus succeeds but forcing PRINCIPAL reverts (`CoupledLeg: principal cannot leave position`) — Model-A preserved; forced transfer auto-thaws partial-frozen tokens.
    - FREEZE (AC-3): a fully-frozen address cannot `transfer` nor receive (`RoseToken: frozen address`); partial-frozen tokens are not transferable by the holder (`RoseToken: insufficient unfrozen balance`) but the unfrozen surplus is; `unfreezePartialTokens` restores movability; an owner `burn` that dips into frozen tokens clamps `frozenTokens` (no stuck invariant).
    - PAUSE (AC-3): when paused, holder `transfer`/`transferFrom` revert (`Pausable: EnforcedPause` — use the OZ custom error selector) but the agent's `forcedTransfer`/`recoveryAddress` and the owner's `mint`/`burn` still succeed; `unpause` restores transfers.
    - RECOVERY (AC-2): `recoveryAddress(lost, new)` moves the FULL balance to `new`, `principalOf(new)` equals the old `principalOf(lost)` and `principalOf(lost) == 0`, freeze state carried, `RecoverySuccess` emitted; recovery to a NON-verified wallet reverts (`RoseToken: recipient not eligible`); recovery of a holder with revoked claim still succeeds (sender bypass); `lToken.totalSupply() == sToken.totalSupply()` unchanged after recovery (coupling intact).
    - FUZZ (AC-1): `testFuzz_<Power>_RevertsForNonAgent(address caller)` with `vm.assume(caller != agent)` for at least `forcedTransfer` and `recoveryAddress`.
  - [x] Naming: `test_*`, `test_RevertWhen_*`, `testFuzz_*`. Reuse `_registerVerified`/`_claimFor` helpers (lift the pattern from `RoseToken.t.sol`/`CoupledPair.t.sol`).

- [x] **Task 7 — Forge test: prove the deploy script LOCALLY (in-process EVM, NO broadcast) (AC: 4)**
  - [x] `prod/contracts/test/script/DeployRoseSuite.t.sol` — `new DeployRoseSuite()`, build a `DeployConfig` with `setupOwner = address(script)` (the test calls `script.deploy(cfg)`, so the script is the transient owner), `finalOwner`/`transferAgent`/`identityAgent` = `makeAddr` addresses, `claimSigner = vm.addr(0xA11CE)` (the `ClaimFixtures` signer). Call `DeployedAddresses memory a = script.deploy(cfg);` and assert: `ClaimTopicsRegistry(a.topicsRegistry).getClaimTopics()` equals `GeneratedComplianceConfig.requiredClaimTopics()` (seeded, ≥1); `TrustedIssuersRegistry(a.issuersRegistry).isTrustedIssuer(a.claimIssuer)`; the transfer-agent `isAgent` on BOTH `a.lToken` and `a.sToken`; the identity agent `isAgent` on `a.identityRegistry`; `Ownable(a.topicsRegistry/.issuersRegistry/.identityRegistry/.pair).owner() == cfg.finalOwner`; and an END-TO-END eligibility proof — register a holder identity (agent-gated, signed by `claimSigner`) and assert `IdentityRegistry(a.identityRegistry).isVerified(holder) == true`, then `mintPair` to the holder works (must impersonate `finalOwner` via `vm.prank` since the pair is now finalOwner-owned). This is the "run the script against a local EVM" proof — NO `--broadcast`, NO Sepolia.
  - [x] Optionally assert `run()` reverts without secrets: `vm.expectRevert(); script.run();` (env unset ⇒ the `SEPOLIA_RPC_URL` guard or `vm.envUint` refuses) — proves refuse-if-absent. (If `vm.expectRevert()` on a cheatcode-env revert is flaky, assert the guard via a direct check instead; keep it green.)

- [x] **Task 8 — Resolve the relevant prior deferrals; update `deferred-work.md` (AC: 2, 3)**
  - [x] In `_bmad-output/implementation-artifacts/deferred-work.md`, add a "Resolved by story-4.6" subsection noting which prior deferrals 4.6 CLOSES: the 4.2/4.3/4.4 "no forced-transfer / recovery / pause / freeze" item (now shipped); the 4.4 "stranded-principal recovery / single-leg forced transfer to a new wallet" item (recovery now relocates principal). For deferrals 4.6 does NOT close, record the new ops-deferred item: the REAL Sepolia broadcast (secrets provided out-of-band; `run()` refuses until then) and the residual `Ownable`/single-key + claim-issuer deployer-management-key cleanup (multisig / role-separation / deployer-key rotation remain ops hardening). Be precise and evidence-based.

- [x] **Task 9 — Format + full gate (AC: 1, 2, 3, 4)**
  - [x] `forge fmt prod/contracts/src prod/contracts/test prod/contracts/script` (NOT `src/generated`, which is `[fmt] ignore`d). `forge build` then `forge test` — green, strictly ADDING to the forge baseline (129 → 129 + new), ZERO regressions across 4.1–4.5.
  - [x] `pnpm test` (Vitest 302, unchanged — this story adds NO TS), `pnpm typecheck`, `pnpm lint`, `pnpm check:regime`, `pnpm check:migrations`, `pnpm format:check`, `forge test`, `forge fmt --check`.

## Dev Notes

### Scope discipline (what 4.6 IS and IS NOT)

- **IN scope:** ERC-3643 transfer-agent agent powers (forced transfer, lost-key recovery, address + partial-token freeze, pause) on the token, GATED to the `AgentRole` transfer-agent role (reused, not reinvented); the `CoupledPair` forwarders that grant/revoke that role on the legs; recovery that relocates the Model-A segregated principal to the new wallet (closing the 4.4 deferral); a `forge script` that deploys the suite in the order validated by 4.1–4.5 using the GENERATED `seedClaimTopics`/`requiredClaimTopics` (Story 4.5), proven LOCALLY via `forge test`'s in-process EVM, with refuse-if-absent on network secrets. [Source: epics.md#Story 4.6; FR-22; architecture.md:156; deferred-work.md story-4.2/4.4]
- **OUT of scope (do NOT pull forward):** the REAL Sepolia broadcast (deferred ops — there are NO Sepolia secrets; `run()` refuses cleanly; document in `deferred-work.md`) — do NOT create a `.env`, do NOT invent an `SEPOLIA_RPC_URL`/key/placeholder; typed viem clients / event watchers (**Story 5.1**); ledger↔chain mint/burn/reconcile (**Epic 5**); multisig / full `Ownable`→role-separation refactor and claim-issuer deployer-key rotation (ops hardening, keep the existing `Ownable` pattern — only ADD the agent role); the bounded-claim-scan / per-topic claim cap OOG item (still deferred — 4.6 adds no new unbounded `isVerified` loop). Do NOT modify `ruleSpecV1`, the shared `conformanceVectors`, or `GeneratedComplianceConfig.sol` (generated; drift-guarded). [Source: epics.md#Story 5.1/Epic 5; deferred-work.md story-4.1/4.2 OOG + Ownable bullets; user deployment-scope decision]

### The single-chokepoint layering (do NOT break 4.2/4.3/4.4)

- `RoseToken._update` is the eligibility chokepoint; `CoupledLeg._update` layers coupling (BEFORE `super`) and the Model-A bright line (AFTER `super`) on the SAME hook. 4.6 adds agent powers AROUND and THROUGH this hook without disturbing the existing order:
  - Pause + address-freeze + partial-freeze are enforced on the USER-facing `transfer`/`transferFrom` overrides, NOT inside `_update`. So agent forced ops (which call `_transfer`/`_update` directly) operate BENEATH pause/freeze — exactly the ERC-3643 agent-override semantics. [Source: RoseToken.sol:54-78; T-REX Token pause/freeze model]
  - The `_agentBypass` transient flag (mirroring `CoupledPair._pairing`) makes `_update` skip ONLY the sender-eligibility check during forced/recovery; the RECIPIENT-eligibility check ALWAYS runs (forced/recovery destinations must be allowlist-eligible — eligibility "preserved"). [Source: RoseToken.sol:68-78; CoupledPair.sol:29,61-67]
  - The `_recovering` transient flag additionally tells `CoupledLeg._update` to MOVE the principal sub-position to the destination and skip the bright line (full-balance recovery). A plain forced transfer keeps the bright line, so principal can NEVER leave a position except via authorized redemption burn (4.4) or a full recovery to a verified new wallet. [Source: CoupledLeg.sol:74-107; deferred-work.md story-4.4 bullets 1 & 3]
- Coupling (single-leg mint/burn) is UNAFFECTED: forced transfer and recovery are transfers (`from != 0 && to != 0`), never single-leg emissions, so `pairingInProgress` is never consulted and `lToken.totalSupply() == sToken.totalSupply()` holds. [Source: CoupledLeg.sol:87-90; CoupledPair invariant]

### Role model & ownership (why the pair forwards `addAgent`)

- `AgentRole.addAgent`/`removeAgent` are `onlyOwner`. A standalone `RoseToken`'s owner grants the transfer-agent directly. But each `CoupledLeg`'s owner is the `CoupledPair` (`initialOwner == coupler == this`), so the ONLY path to grant an agent on a leg is a pair forwarder — hence `CoupledPair.addLegAgent`/`removeLegAgent`. The agent then calls the per-call powers (`forcedTransfer`, `recoveryAddress`, `setAddressFrozen`, `freezePartialTokens`, `pause`, …) DIRECTLY on each leg. [Source: AgentRole.sol:26-38; CoupledPair.sol:31-43]
- The deploy script deploys registries/pair with `setupOwner` as the transient owner (so it can seed topics + add agents), then `transferOwnership` to `finalOwner`. Under `vm.startBroadcast(pk)` the script's calls have `msg.sender == vm.addr(pk)`, so `setupOwner` MUST be `vm.addr(pk)`; in a plain forge test the script's calls have `msg.sender == address(script)`, so the test MUST pass `setupOwner = address(scriptInstance)`. This is the canonical forge-script ownership gotcha — get it right or `onlyOwner` reverts. [Source: forge-std Script broadcast semantics; ClaimTopicsRegistry/IdentityRegistry constructors]

### Refuse-if-absent on secrets (user deployment-scope decision)

- There are NO Sepolia secrets in this repo (`.env.example` ships `SEPOLIA_RPC_URL=` blank; no `.env`). 4.6 implements ALL the code and proves it on the LOCAL in-process EVM via `forge test` (the same "run against a local chain" the 4.5 story used for conformance). The REAL broadcast is a separate ops step, DEFERRED until secrets are provided out-of-band. `run()` must REFUSE cleanly: `vm.envUint("ROSE_DEPLOYER_PRIVATE_KEY")` and `vm.envAddress(...)` REVERT on a missing var (no default), and an explicit `require(bytes(SEPOLIA_RPC_URL).length > 0, ...)` guard gives a clear refusal message. NEVER write a placeholder key/RPC, NEVER create a `.env`. [Source: .env.example:1-11; architecture.md:151 "deployer/transfer-agent keys handled out-of-band"; CLAUDE.md no-placeholder rule; user decision]

### Reuse — do NOT reinvent (load-bearing)

- **`AgentRole`** is the transfer-agent role primitive — reuse it on `RoseToken` (add to the inheritance list); do NOT write a new role contract. [Source: AgentRole.sol:11-44; story task]
- **OZ `Pausable`** (`@openzeppelin/contracts/utils/Pausable.sol`) for pause — `_pause`/`_unpause`/`whenNotPaused`/`paused`; do NOT hand-roll a bool. The paused error is the OZ custom error `EnforcedPause()`; tests use its selector. [Source: lib/.../utils/Pausable.sol:23-108]
- **`GeneratedComplianceConfig.seedClaimTopics(registry)` + `requiredClaimTopics()`** (Story 4.5) for the deploy's topic seeding and trusted-issuer topic list — do NOT hand-write `addClaimTopic(KYC)` in the script. [Source: GeneratedComplianceConfig.sol:28-43; 4-5 story]
- **`ClaimFixtures` + the `IdentityRegistry.t.sol`/`CoupledPair.t.sol` setUp pattern** (`_registerVerified`, `CLAIM_SIGNER_PK`, key-hash = `keccak256(abi.encode(addr))`) for the test stacks — lift it, don't reinvent. [Source: test/identity/ClaimFixtures.sol; test/token/RoseToken.t.sol:39-71]
- **The `CoupledPair._pairing` transient-flag pattern** is the model for `_agentBypass`/`_recovering` (set true → privileged op → set false; rolls back on revert). [Source: CoupledPair.sol:29,61-76]
- **`ClaimIssuer.addKey(keccak256(abi.encode(signer)), CLAIM_SIGNER_KEY, ECDSA_TYPE)`** for wiring the claim signer in the deploy. `MANAGEMENT_KEY = 1`, `CLAIM_SIGNER_KEY = 3`, `ECDSA_TYPE = 1`. [Source: Identity.sol:17-23,66; test/token/RoseToken.t.sol:46-47]

### Architecture constraints

- **Stack (D2):** custom ERC-3643-compatible suite on OpenZeppelin 5.6.1, Foundry, solc `0.8.28`, `evm_version=cancun`, `optimizer_runs=200`. New Solidity: `pragma solidity ^0.8.28;`, SPDX `MIT`. The deploy script uses forge-std `Script`/`console2`. [Source: foundry.toml; architecture.md:156-158]
- **Numeric (NFR-2):** no float; amounts are `uint256` smallest units. [Source: architecture.md#Data]
- **Regime boundary:** all new code under `prod/contracts`; never reference `/throwaway`. Solidity is outside the pnpm workspace so the TS gates (`pnpm test`/`typecheck`/`lint`) are unaffected by these additions. [Source: pnpm-workspace.yaml; tools/check-regime-boundary.mjs]
- **D3 — chain is the source of truth at runtime.** 4.6 finalizes the on-chain enforcement plane (agent powers) and its deploy; runtime ledger↔chain wiring is Epic 5. [Source: architecture.md; brief D3]
- **`forge fmt --check`:** format `src`/`test`/`script` but NOT `src/generated` (`[fmt] ignore`d). The deploy script lives in `prod/contracts/script` (formatted). [Source: foundry.toml:14-15]

### Project Structure Notes

- New Solidity: `prod/contracts/script/DeployRoseSuite.s.sol`, `prod/contracts/test/token/AgentPowers.t.sol`, `prod/contracts/test/script/DeployRoseSuite.t.sol`. Edited Solidity: `src/token/RoseToken.sol`, `src/token/CoupledLeg.sol`, `src/token/CoupledPair.sol`, `src/token/interface/IRoseToken.sol`, `src/token/interface/ICoupledPair.sol`. Edited tracking: `_bmad-output/implementation-artifacts/{sprint-status.yaml,deferred-work.md}`.
- Mirrors the established `src/token` + `test/token` layout; the deploy script mirrors the placeholder `script/Counter.s.sol` (but on `^0.8.28` / SPDX MIT). [Source: contracts/src tree; script/Counter.s.sol]
- Do NOT touch `src/generated/GeneratedComplianceConfig.sol` (generated, Vitest drift-guarded) — only CONSUME it from the script. [Source: 4-5 story; foundry.toml:11-15]

### Testing standards

- **Solidity/Foundry** in `prod/contracts/test/**/*.t.sol`, run by `forge test` (in-process EVM — this IS the local-chain proof; NO anvil/Sepolia needed for the gate). Cover every agent power's gating (agent-allowed + non-agent-revert), the forced-transfer / freeze / pause / recovery semantics, Model-A + coupling preservation, and the local deploy wiring. Naming: `test_*`, `test_RevertWhen_*`, `testFuzz_*`. [Source: architecture.md#On-Chain; test/token/RoseToken.t.sol; test/token/CoupledPair.t.sol]
- **No TS changes** — Vitest stays at 302; do NOT add or modify any `@rose/*` package for this story. [Source: package.json; story scope]
- **Baseline before this story: Vitest 302/302, forge 129/129.** forge must GROW with zero regressions; Vitest stays 302. [Source: 4-5 story Dev Agent Record; baseline run 2026-06-16]

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 / Story 4.6 (+ FR-22)]
- [Source: _bmad-output/planning-artifacts/architecture.md:151,156-158 (agent powers, deploy, out-of-band keys)]
- [Source: prod/contracts/src/token/{RoseToken,CoupledLeg,CoupledPair}.sol; interface/{IRoseToken,ICoupledPair}.sol]
- [Source: prod/contracts/src/identity/{AgentRole,IdentityRegistry,ClaimTopicsRegistry,TrustedIssuersRegistry,ClaimIssuer,Identity}.sol]
- [Source: prod/contracts/src/generated/GeneratedComplianceConfig.sol (seedClaimTopics / requiredClaimTopics — Story 4.5)]
- [Source: prod/contracts/test/{identity/ClaimFixtures.sol,token/RoseToken.t.sol,token/CoupledPair.t.sol}]
- [Source: prod/contracts/{foundry.toml,remappings.txt,script/Counter.s.sol}; .env.example]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md (story-4.2 "no forced-transfer/recovery/pause/freeze"; story-4.4 "single-leg recovery / forced transfer to a new wallet")]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `forge build` compiled cleanly under solc 0.8.28 with the new agent powers + deploy script (only pre-existing `forge lint` advisories on unrelated files; 0 compiler errors).
- `forge test` 129 → 170 (+41): `test/token/AgentPowers.t.sol` (+34) and `test/script/DeployRoseSuite.t.sol` (+7). Zero regressions across 4.1–4.5.
- `forge fmt --check` exit 0 (generated `src/generated/**` stays `[fmt] ignore`d).
- Local deploy proof: `DeployRoseSuite.deploy(...)` runs on forge's in-process EVM (NO `--broadcast`, NO Sepolia) and the suite is fully wired (seeded topics, trusted issuer, agents granted, ownership handed over, end-to-end eligibility + paired mint). `run()` refuses with the env unset (refuse-if-absent proven by `test_RevertWhen_Run_NetworkSecretsAbsent`).

### Completion Notes List

- **AC-1 (powers gated to the transfer-agent role):** added the ERC-3643 agent powers to `RoseToken` by inheriting the reused `AgentRole` (+ OZ `Pausable`) — `forcedTransfer`, `recoveryAddress`, `setAddressFrozen`, `freezePartialTokens`/`unfreezePartialTokens`, `pause`/`unpause`, all `onlyAgent`. `CoupledPair.addLegAgent`/`removeLegAgent` grant/revoke the role on both legs (the legs are pair-owned, so this owner forwarder is the only path to their `addAgent`). Each power has an agent happy-path test and a non-agent `AgentRole: caller is not an agent` revert (plus fuzz on `forcedTransfer`/`recoveryAddress`).
- **AC-2 (lost-key recovery):** `recoveryAddress(lost, new)` moves the FULL balance to a verified `new` wallet (recipient `isVerified` re-checked ⇒ eligibility preserved), relocates the segregated principal sub-position (`CoupledLeg` `_recoveryInProgress` branch → `PrincipalRecovered`), carries freeze state for continuity, emits `RecoverySuccess` (audit trail), and leaves `lToken.totalSupply() == sToken.totalSupply()` intact (recovery is a transfer). Works even on a holder whose claim was revoked (sender bypass); reverts to a non-verified target.
- **AC-3 (forced transfer / freeze / pause semantics):** pause + address-freeze + partial-freeze are enforced on the USER `transfer`/`transferFrom` overrides, so agent forced ops (which call `_transfer`/`_update` directly) operate beneath them — the agent override. `_agentBypass` skips ONLY the sender-eligibility check (recipient always re-checked); a plain `forcedTransfer` keeps the Model-A bright line (principal cannot leave) and auto-thaws frozen tokens if needed; an owner burn into frozen balance clamps `frozenTokens`. Paused token rejects normal transfers (`Pausable.EnforcedPause`) but agent/owner ops still function.
- **AC-4 (deploy script, refuse-if-absent):** `DeployRoseSuite.s.sol` deploys in the validated order — registries → IdentityRegistry → `GeneratedComplianceConfig.seedClaimTopics` (generated, NOT hand-written) → ClaimIssuer trusted for `requiredClaimTopics()` → identity agent → `CoupledPair` → `addLegAgent` → hand ownership to `finalOwner`. Proven LOCALLY (in-process EVM, no broadcast). `run()` refuses cleanly via `vm.envUint`/`vm.envAddress` (revert on missing) + an explicit `SEPOLIA_RPC_URL` guard — NO placeholder, NO default secret, NO `.env` created. REAL Sepolia broadcast deferred to ops (documented in `deferred-work.md`).
- **Resolved prior deferrals:** story-4.2 "no forced-transfer/recovery/pause/freeze" and story-4.4 "single-leg recovery / stranded-principal" are closed (recorded under "Resolved by story-4.6" in `deferred-work.md`).
- **Scope held:** no TS changes (Vitest stays 302); no viem clients (5.1); no ledger↔chain wiring (Epic 5); `GeneratedComplianceConfig.sol`/`ruleSpecV1`/`conformanceVectors` untouched; no multisig refactor (kept `Ownable`, only ADDED the `AgentRole`).
- **Gates:** Vitest 302/302, forge 171/171, `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` green, `forge fmt --check` clean.

### File List

**New — Solidity (`prod/contracts/`):**

- `script/DeployRoseSuite.s.sol` (ordered deploy script; `deploy(...)` pure + `run()` refuse-if-absent broadcast entrypoint)
- `test/token/AgentPowers.t.sol` (35 tests: gating, forced transfer, freeze, pause, recovery, standalone path)
- `test/script/DeployRoseSuite.t.sol` (7 tests: local deploy proof + refuse-if-absent)

**Modified — Solidity:**

- `src/token/RoseToken.sol` (inherit `AgentRole` + `Pausable`; forced transfer, recovery, freeze, pause; `_update` agent bypass + burn frozen-clamp; user-path pause/freeze guards)
- `src/token/CoupledLeg.sol` (recovery relocates segregated principal; plain forced transfer keeps the Model-A bright line; `PrincipalRecovered` event)
- `src/token/CoupledPair.sol` (`addLegAgent`/`removeLegAgent` forwarders)
- `src/token/interface/IRoseToken.sol` (agent-power surface: events + views + functions)
- `src/token/interface/ICoupledPair.sol` (`addLegAgent`/`removeLegAgent` + events)

**Modified — tracking:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/deferred-work.md` (resolved 4.2/4.4 deferrals; new 4.6 ops-deferred items)

## Change Log

| Date       | Version | Description                                  | Author |
| ---------- | ------- | -------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev | Amelia |
| 2026-06-16 | 0.2     | Implemented ERC-3643 transfer-agent powers (forced transfer, lost-key recovery, address + partial freeze, pause) on `RoseToken` gated to the reused `AgentRole`; `CoupledPair` leg-agent forwarders; recovery relocates segregated principal (closes 4.4 deferral); `DeployRoseSuite` ordered deploy script (generated topic seeding, refuse-if-absent on secrets), proven LOCALLY on the in-process EVM (no Sepolia broadcast); forge 129→170, Vitest 302 unchanged; full gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers); +2 patches (forced-transfer-from-address-frozen coverage test; removed unused `DeployConfig.country` dead env read) → forge 170→171; 0 deferred, 2 dismissed; full gate green; status → done | Amelia |

## Review Findings

- [x] [Review][Patch] AC-3 coverage gap: no test forced a transfer OUT of an `setAddressFrozen(true)` holder (only the normal-path block and recovery-carry were covered) [prod/contracts/test/token/AgentPowers.t.sol] — added `test_ForcedTransfer_FromAddressFrozenHolder_Succeeds` proving the agent override bypasses the address freeze while the holder's own transfer is blocked.
- [x] [Review][Patch] Dead code: `DeployConfig.country` was read from env (`ROSE_INVESTOR_COUNTRY`) in `run()` but never used by `deploy()` (holder registration is Epic 5, not deploy-time) [prod/contracts/script/DeployRoseSuite.s.sol] — removed the field, the env read, and the test config entry (CLAUDE.md code-cleanup).
- [Review][Dismiss] `recoveryAddress` carries the address-freeze flag + frozen-token bookkeeping to the new wallet, which would also freeze any pre-existing balance the new wallet holds ON THIS LEG — by-design: a lost-key recovery targets a FRESH wallet, and carrying the freeze is the deliberate continuity choice (a frozen/sanctioned holder must not escape the freeze via recovery; AC-2 "preserving the audit trail"). Documented in `recoveryAddress` NatSpec.
- [Review][Dismiss] `setAddressFrozen` / `AddressFrozen` fire even on a no-op state change (re-freezing an already-frozen address) — harmless idempotent admin op; mirrors canonical ERC-3643 setters.

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (2 patches applied — test-strengthening + dead-code removal; no unresolved High/Med correctness issues)

Three parallel adversarial layers ran against the 4.6 diff. **Blind Hunter** (diff only) verified the freeze-invariant `_frozenTokens[a] <= balanceOf(a)` is upheld in EVERY path — the `freezePartialTokens` cap, the `forcedTransfer` auto-thaw (which lands `_frozenTokens == new balance` exactly when thawing), the normal-transfer `_requireMovable` guard (so `balanceOf - _frozenTokens` never underflows), the `recoveryAddress` reset-to-zero-then-carry, and the `_update` burn clamp — so there is no underflow in `_requireMovable`; confirmed the `_agentBypass`/`_recovering` transient flags mirror the proven `_pairing` pattern (reset after the op, roll back on revert); confirmed pause/freeze live on the USER `transfer`/`transferFrom` overrides while forced/recovery call `_transfer` directly (correct agent override), and that mint/burn (owner) never pass through the paused user path. **Edge-Case Hunter** (project access) confirmed forced transfer keeps the Model-A bright line (principal can't leave) while recovery relocates the whole principal and skips it, the coupling supply invariant survives recovery (it is a transfer), and surfaced the dead `DeployConfig.country` env read — patched out. **Acceptance Auditor** returned **PASS on AC-1/AC-2/AC-3/AC-4** with one coverage gap: AC-3's "address-frozen holder" forced-transfer path was unproven — patched with a dedicated test. No scope creep: no TS changes (Vitest 302), no viem/Epic-5 wiring, `GeneratedComplianceConfig.sol`/`ruleSpecV1` untouched, `Ownable` kept (only the `AgentRole` added), and the deploy script holds refuse-if-absent (no `.env`, no placeholder, no secret) with the REAL Sepolia broadcast deferred to ops. After the 2 patches: forge 171/171, Vitest 302/302, `pnpm typecheck`/`lint`/`check:regime`/`check:migrations`/`format:check` green, `forge fmt --check` clean.
