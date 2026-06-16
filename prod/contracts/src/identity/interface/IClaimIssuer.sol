// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentity} from "./IIdentity.sol";

/// @title IClaimIssuer — trusted claim issuer (ONCHAINID identity + signature validity)
/// @notice An issuer is itself an ONCHAINID identity whose CLAIM keys sign claims it issues.
///         It can revoke a claim by its signature and validate a claim's signature on demand.
///         Mirrors the ERC-3643 ClaimIssuer. Story 4.1 (FR-19).
interface IClaimIssuer is IIdentity {
    /// @notice Emitted when the issuer revokes a claim identified by its signature.
    event ClaimRevoked(bytes signature);

    /// @notice Revoke a claim by its `signature`. Restricted to a MANAGEMENT key.
    function revokeClaimBySignature(bytes calldata signature) external;

    /// @notice True iff the claim with `signature` has been revoked by this issuer.
    function isClaimRevoked(bytes calldata signature) external view returns (bool);

    /// @notice Fail-closed validity check: returns true iff `signature` over
    ///         `keccak256(abi.encode(identity, topic, data))` was produced by a CLAIM key of
    ///         THIS issuer AND the claim is not revoked. Returns false (never reverts) for a
    ///         malformed signature.
    function isClaimValid(IIdentity identity, uint256 topic, bytes memory signature, bytes memory data)
        external
        view
        returns (bool);
}
