// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC735 — ONCHAINID Claim Holder (ERC-735 subset)
/// @notice Claim-management surface of an ONCHAINID identity. A claim attests that an
///         off-chain fact (e.g. KYC/AML pass) holds for the identity. `claimId` is
///         deterministic: `keccak256(abi.encode(issuer, topic))` — one claim per
///         (issuer, topic). Mirrors ERC-735 as used by Tokeny T-REX / ONCHAINID.
interface IERC735 {
    /// @notice Emitted when a new claim is added.
    event ClaimAdded(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    /// @notice Emitted when an existing (issuer, topic) claim is replaced.
    event ClaimChanged(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    /// @notice Emitted when a claim is removed.
    event ClaimRemoved(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    /// @notice Add or replace the (`issuer`, `topic`) claim. Restricted to a CLAIM (or
    ///         MANAGEMENT) key on this identity, or to the identity itself.
    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (bytes32 claimId);

    /// @notice Remove the claim with `claimId`. Restricted to a MANAGEMENT key.
    function removeClaim(bytes32 claimId) external returns (bool success);

    /// @notice Return the stored fields of the claim with `claimId`.
    function getClaim(bytes32 claimId)
        external
        view
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        );

    /// @notice Return every claim id recorded under `topic`.
    function getClaimIdsByTopic(uint256 topic) external view returns (bytes32[] memory claimIds);
}
