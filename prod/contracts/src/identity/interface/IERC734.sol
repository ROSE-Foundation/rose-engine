// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC734 — ONCHAINID Key Holder (ERC-734 subset)
/// @notice Key-management surface of an ONCHAINID identity. Keys are referenced by
///         `keccak256(abi.encode(addressOrKey))` and carry one or more purposes
///         (1 = MANAGEMENT, 2 = ACTION, 3 = CLAIM). Mirrors the ERC-734 patterns used by
///         Tokeny T-REX / ONCHAINID. Story 4.1 (FR-19 foundation).
interface IERC734 {
    /// @notice Emitted when a key is added with a given purpose and key type.
    event KeyAdded(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    /// @notice Emitted when a purpose is removed from a key.
    event KeyRemoved(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);

    /// @notice Add `purpose` to `key` (of `keyType`). Restricted to a MANAGEMENT key.
    function addKey(bytes32 key, uint256 purpose, uint256 keyType) external returns (bool success);

    /// @notice Remove `purpose` from `key`. Restricted to a MANAGEMENT key.
    function removeKey(bytes32 key, uint256 purpose) external returns (bool success);

    /// @notice Return the purposes, key type, and key value for `key`.
    function getKey(bytes32 key) external view returns (uint256[] memory purposes, uint256 keyType, bytes32 keyValue);

    /// @notice Return the purposes held by `key`.
    function getKeyPurposes(bytes32 key) external view returns (uint256[] memory purposes);

    /// @notice Return every key that holds `purpose`.
    function getKeysByPurpose(uint256 purpose) external view returns (bytes32[] memory keys);

    /// @notice True iff `key` holds `purpose` (a MANAGEMENT key satisfies every purpose).
    function keyHasPurpose(bytes32 key, uint256 purpose) external view returns (bool exists);
}
