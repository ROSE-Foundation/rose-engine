// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AgentRole} from "../identity/AgentRole.sol";
import {IRoseToken} from "./interface/IRoseToken.sol";
import {IIdentityRegistry} from "../identity/interface/IIdentityRegistry.sol";

/// @title RoseToken — custom ERC-3643-compatible token, eligibility-enforced on every movement
/// @notice An OpenZeppelin 5.6 `ERC20` whose single `_update` chokepoint rejects any balance
///         movement to or from an address that is not `isVerified` in the bound
///         `IdentityRegistry`. OZ-5 routes `transfer`, `transferFrom`, `_mint`, and `_burn`
///         through `_update`, so one override gates them all. Story 4.2 (FR-19).
/// @dev    Fail-closed (NFR-4): an unregistered/unclaimed/revoked sender OR recipient ⇒ revert.
///         Eligibility is re-checked LIVE at movement time (not frozen at acquisition), so a
///         holder whose claim is revoked can no longer move tokens. The zero-address side of a
///         mint (`from == 0`) or burn (`to == 0`) is naturally skipped. `_update` is kept
///         `virtual` so Stories 4.3 (pair coupling) and 4.4 (Model-A) extend it.
///
///         Story 4.6 (FR-22) adds the ERC-3643 transfer-agent agent powers, gated to the reused
///         `AgentRole` transfer-agent role:
///         - **pause / freeze** are enforced on the USER `transfer`/`transferFrom` overrides, NOT
///           inside `_update`, so the agent powers (which call `_transfer`/`_update` directly)
///           operate BENEATH them — the canonical ERC-3643 agent override;
///         - **forced transfer / recovery** set the `_agentBypass` transient flag so `_update`
///           skips ONLY the SENDER-eligibility check; the RECIPIENT check ALWAYS runs (forced /
///           recovery destinations must be allowlist-eligible — eligibility "preserved");
///         - **recovery** additionally sets `_recovering` so `CoupledLeg` moves the segregated
///           principal sub-position to the new wallet and skips the Model-A bright line (a full-
///           balance relocation), while a plain forced transfer keeps the bright line (principal
///           can never leave a position except via redemption burn or full recovery).
///         The `_agentBypass`/`_recovering` flags mirror `CoupledPair._pairing`: set true around a
///         privileged op, reset after, and roll back automatically if the tx reverts.
contract RoseToken is ERC20, AgentRole, Pausable, IRoseToken {
    IIdentityRegistry private _identityRegistry;

    /// @dev Fully-frozen addresses: cannot send or receive in a NORMAL transfer (enforced on the
    ///      user `transfer`/`transferFrom` paths). Agent forced ops bypass this.
    mapping(address => bool) private _frozen;
    /// @dev Partial freeze: the portion of an address's balance that is not movable by a normal
    ///      transfer. Invariant `_frozenTokens[a] <= balanceOf(a)` (held by the freeze setters,
    ///      the forced-transfer auto-thaw, and the burn clamp in `_update`).
    mapping(address => uint256) private _frozenTokens;

    /// @dev True only during an agent forced transfer / recovery: `_update` skips the SENDER
    ///      eligibility check (the recipient check still runs). The agent override on eligibility.
    bool private _agentBypass;
    /// @dev True only during a recovery: additionally tells `CoupledLeg` to relocate the holder's
    ///      segregated principal to the new wallet and skip the Model-A bright line (full move).
    bool private _recovering;

    constructor(string memory name_, string memory symbol_, IIdentityRegistry registry_, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        require(address(registry_) != address(0), "RoseToken: zero registry");
        _identityRegistry = registry_;
        emit IdentityRegistrySet(IIdentityRegistry(address(0)), registry_);
    }

    /// @inheritdoc IRoseToken
    function identityRegistry() external view override returns (IIdentityRegistry) {
        return _identityRegistry;
    }

    /// @inheritdoc IRoseToken
    function setIdentityRegistry(IIdentityRegistry newRegistry) external override onlyOwner {
        require(address(newRegistry) != address(0), "RoseToken: zero registry");
        IIdentityRegistry previous = _identityRegistry;
        _identityRegistry = newRegistry;
        emit IdentityRegistrySet(previous, newRegistry);
    }

    /// @inheritdoc IRoseToken
    function mint(address to, uint256 amount) external override onlyOwner {
        _mint(to, amount);
    }

    /// @inheritdoc IRoseToken
    function burn(address from, uint256 amount) external override onlyOwner {
        _burn(from, amount);
    }

    // --- freeze + pause views / admin (Story 4.6) -------------------------------------------

    /// @inheritdoc IRoseToken
    function isFrozen(address userAddress) external view override returns (bool) {
        return _frozen[userAddress];
    }

    /// @inheritdoc IRoseToken
    function frozenTokens(address userAddress) external view override returns (uint256) {
        return _frozenTokens[userAddress];
    }

    /// @inheritdoc IRoseToken
    function setAddressFrozen(address userAddress, bool freeze) external override onlyAgent {
        _frozen[userAddress] = freeze;
        emit AddressFrozen(userAddress, freeze);
    }

    /// @inheritdoc IRoseToken
    function freezePartialTokens(address userAddress, uint256 amount) external override onlyAgent {
        require(_frozenTokens[userAddress] + amount <= balanceOf(userAddress), "RoseToken: freeze exceeds balance");
        _frozenTokens[userAddress] += amount;
        emit TokensFrozen(userAddress, amount);
    }

    /// @inheritdoc IRoseToken
    function unfreezePartialTokens(address userAddress, uint256 amount) external override onlyAgent {
        require(amount <= _frozenTokens[userAddress], "RoseToken: unfreeze exceeds frozen");
        _frozenTokens[userAddress] -= amount;
        emit TokensUnfrozen(userAddress, amount);
    }

    /// @inheritdoc IRoseToken
    function pause() external override onlyAgent {
        _pause();
    }

    /// @inheritdoc IRoseToken
    function unpause() external override onlyAgent {
        _unpause();
    }

    // --- user movement paths: pause + freeze enforced HERE (agent powers operate beneath) ----

    /// @dev Normal transfer: blocked while paused, while either party is fully frozen, or beyond
    ///      the sender's unfrozen balance. Agent forced ops call `_transfer` directly and bypass.
    function transfer(address to, uint256 value) public override(ERC20, IERC20) whenNotPaused returns (bool) {
        _requireMovable(_msgSender(), to, value);
        return super.transfer(to, value);
    }

    /// @dev Normal `transferFrom`: same user-path guards as {transfer}. The frozen/balance check
    ///      is on `from` (the token owner), not the spender.
    function transferFrom(address from, address to, uint256 value)
        public
        override(ERC20, IERC20)
        whenNotPaused
        returns (bool)
    {
        _requireMovable(from, to, value);
        return super.transferFrom(from, to, value);
    }

    /// @dev User-path freeze guard: neither party fully frozen, and `from`'s UNFROZEN balance
    ///      covers `value` (partial-frozen tokens are not movable by a normal transfer).
    function _requireMovable(address from, address to, uint256 value) private view {
        require(!_frozen[from] && !_frozen[to], "RoseToken: frozen address");
        require(balanceOf(from) - _frozenTokens[from] >= value, "RoseToken: insufficient unfrozen balance");
    }

    // --- agent powers: forced transfer + recovery (Story 4.6) -------------------------------

    /// @inheritdoc IRoseToken
    function forcedTransfer(address from, address to, uint256 amount) external override onlyAgent returns (bool) {
        require(from != address(0) && to != address(0), "RoseToken: zero address");
        require(balanceOf(from) >= amount, "RoseToken: amount exceeds balance");
        // Forced transfer can move frozen tokens (canonical ERC-3643): auto-thaw the shortfall.
        uint256 free = balanceOf(from) - _frozenTokens[from];
        if (amount > free) {
            uint256 thaw = amount - free;
            _frozenTokens[from] -= thaw;
            emit TokensUnfrozen(from, thaw);
        }
        _agentBypass = true;
        _transfer(from, to, amount);
        _agentBypass = false;
        return true;
    }

    /// @inheritdoc IRoseToken
    function recoveryAddress(address lostWallet, address newWallet) external override onlyAgent returns (bool) {
        require(lostWallet != address(0) && newWallet != address(0), "RoseToken: zero address");
        require(lostWallet != newWallet, "RoseToken: same wallet");
        uint256 bal = balanceOf(lostWallet);
        require(bal > 0, "RoseToken: nothing to recover");

        uint256 frozenAmt = _frozenTokens[lostWallet];
        bool wasFrozen = _frozen[lostWallet];

        _agentBypass = true;
        _recovering = true;
        // Recipient must be `isVerified` (eligibility preserved); on a leg the segregated principal
        // moves with the balance and the bright line is skipped (see CoupledLeg._update).
        _transfer(lostWallet, newWallet, bal);
        _recovering = false;
        _agentBypass = false;

        // Carry freeze-state continuity to the new wallet (audit trail / restriction continuity):
        // a lost-key recovery must not let a frozen/sanctioned holder escape their freeze.
        if (frozenAmt > 0) {
            _frozenTokens[lostWallet] = 0;
            _frozenTokens[newWallet] += frozenAmt;
        }
        if (wasFrozen) {
            _frozen[newWallet] = true;
        }
        emit RecoverySuccess(lostWallet, newWallet, bal);
        return true;
    }

    /// @notice True while an agent forced transfer / recovery is in flight (sender-eligibility
    ///         bypass). Consulted by `CoupledLeg`.
    function _agentActionInProgress() internal view returns (bool) {
        return _agentBypass;
    }

    /// @notice True while a recovery is in flight (move principal + skip the Model-A bright line).
    ///         Consulted by `CoupledLeg`.
    function _recoveryInProgress() internal view returns (bool) {
        return _recovering;
    }

    /// @dev Single eligibility chokepoint. Tokens may only land on, or leave, an `isVerified`
    ///      address (fail-closed, NFR-4):
    ///      - mint (`from == 0`): the recipient must be verified;
    ///      - transfer / transferFrom (`from != 0 && to != 0`): the recipient must be verified, and
    ///        the sender must be verified UNLESS an agent forced op is in flight (`_agentBypass`) —
    ///        forced transfer / recovery may move tokens OUT of a revoked holder, but the
    ///        destination is always re-checked LIVE (eligibility preserved);
    ///      - burn (`to == 0`): the owner-gated supply-reduction primitive is EXEMPT from the
    ///        sender check, mirroring canonical ERC-3643. This lets the issuer reduce the supply
    ///        of a revoked/de-listed holder (otherwise such balances would be both untransferable
    ///        AND unburnable — stranded).
    ///      Exempting burn from the `isVerified(from)` call also keeps a hostile holder's
    ///      (uncapped — 4.1 deferred-work) claim list from gas-griefing the issuer's burn path.
    ///      AFTER the OZ mutation, a burn clamps `_frozenTokens[from]` down to the remaining
    ///      balance so the `_frozenTokens[a] <= balanceOf(a)` invariant holds even when the owner
    ///      burns into a partially-frozen balance.
    ///      `_update` stays `virtual` so Stories 4.3 (coupling) and 4.4 (Model-A) extend it.
    function _update(address from, address to, uint256 value) internal virtual override {
        // Recipient (mint + transfer) must be eligible.
        if (to != address(0)) {
            require(_identityRegistry.isVerified(to), "RoseToken: recipient not eligible");
            // Sender of a real transfer must be eligible; burns (to == 0) and agent forced ops
            // (`_agentBypass`) are exempt.
            if (from != address(0) && !_agentBypass) {
                require(_identityRegistry.isVerified(from), "RoseToken: sender not eligible");
            }
        }
        super._update(from, to, value);

        // Keep `_frozenTokens[from] <= balanceOf(from)` after an owner burn into frozen balance.
        if (from != address(0) && to == address(0)) {
            uint256 bal = balanceOf(from);
            if (_frozenTokens[from] > bal) {
                uint256 reduced = _frozenTokens[from] - bal;
                _frozenTokens[from] = bal;
                emit TokensUnfrozen(from, reduced);
            }
        }
    }
}
