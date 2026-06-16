// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIdentityRegistry} from "../../identity/interface/IIdentityRegistry.sol";

/// @title IRoseToken — custom ERC-3643-compatible token surface (eligibility-gated)
/// @notice An `IERC20` whose every balance movement is constrained by the on-chain eligibility
///         predicate `IIdentityRegistry.isVerified`: tokens can only be held or moved by
///         identity-verified, allowlist-eligible holders. Mirrors the ERC-3643 token's
///         identity-registry binding. Story 4.2 (FR-19). Pair coupling (4.3), the Model-A
///         bright line (4.4), rule-spec codegen (4.5), and transfer-agent powers / Sepolia
///         deployment (4.6) build on top of this base.
/// @dev    Story 4.6 (FR-22) ADDS the ERC-3643 transfer-agent agent powers — forced transfer,
///         lost-key recovery, address + partial-token freeze, and pause — each gated to the
///         `AgentRole` transfer-agent role. Pause/freeze are enforced on the USER `transfer`/
///         `transferFrom` paths; the agent powers operate beneath them (the agent override).
interface IRoseToken is IERC20 {
    /// @notice Emitted when the bound identity registry is set or replaced.
    event IdentityRegistrySet(IIdentityRegistry indexed previous, IIdentityRegistry indexed current);

    /// @notice Emitted when an address is fully frozen/unfrozen by the transfer-agent (4.6).
    event AddressFrozen(address indexed userAddress, bool isFrozen);
    /// @notice Emitted when `amount` of `userAddress`'s balance is frozen (partial freeze, 4.6).
    event TokensFrozen(address indexed userAddress, uint256 amount);
    /// @notice Emitted when `amount` of `userAddress`'s frozen balance is released (4.6). Also
    ///         emitted when a forced transfer auto-thaws frozen tokens or an owner burn clamps them.
    event TokensUnfrozen(address indexed userAddress, uint256 amount);
    /// @notice Emitted on a successful lost-key recovery: `amount` reissued from `lostWallet` to
    ///         `newWallet` (the audit trail, AC-2). `newWallet` is `isVerified` (eligibility kept).
    event RecoverySuccess(address indexed lostWallet, address indexed newWallet, uint256 amount);

    /// @notice The identity registry consulted (`isVerified`) on every transfer/mint/burn party.
    function identityRegistry() external view returns (IIdentityRegistry);

    /// @notice Replace the bound identity registry. Owner-only (transfer-agent generalization: 4.6).
    function setIdentityRegistry(IIdentityRegistry newRegistry) external;

    /// @notice Mint `amount` to `to`. Owner-only; `to` must be `isVerified` (enforced by the hook).
    function mint(address to, uint256 amount) external;

    /// @notice Burn `amount` from `from`. Owner-only.
    function burn(address from, uint256 amount) external;

    // --- ERC-3643 transfer-agent powers (Story 4.6, FR-22; all agent-gated) -----------------

    /// @notice True iff `userAddress` is fully frozen (cannot send/receive in a normal transfer).
    function isFrozen(address userAddress) external view returns (bool);

    /// @notice The amount of `userAddress`'s balance currently frozen (partial freeze).
    function frozenTokens(address userAddress) external view returns (uint256);

    /// @notice Fully freeze/unfreeze `userAddress`. Agent-only.
    function setAddressFrozen(address userAddress, bool freeze) external;

    /// @notice Freeze `amount` more of `userAddress`'s balance (cannot exceed balance). Agent-only.
    function freezePartialTokens(address userAddress, uint256 amount) external;

    /// @notice Release `amount` of `userAddress`'s frozen balance. Agent-only.
    function unfreezePartialTokens(address userAddress, uint256 amount) external;

    /// @notice Pause all normal transfers. Agent-only (agent/owner powers still function).
    function pause() external;

    /// @notice Resume normal transfers. Agent-only.
    function unpause() external;

    /// @notice Forcibly move `amount` from `from` to `to`. Agent-only: bypasses the sender
    ///         eligibility check, address-freeze and pause (auto-thaws frozen tokens if needed),
    ///         but `to` MUST be `isVerified` and the Model-A bright line still holds on a leg.
    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);

    /// @notice Lost-key recovery: reissue `lostWallet`'s FULL balance to `newWallet`. Agent-only.
    ///         `newWallet` MUST be `isVerified` (eligibility preserved); segregated principal and
    ///         freeze state move with the balance; emits {RecoverySuccess} (audit trail).
    function recoveryAddress(address lostWallet, address newWallet) external returns (bool);
}
