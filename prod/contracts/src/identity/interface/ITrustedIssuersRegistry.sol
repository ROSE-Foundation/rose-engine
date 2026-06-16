// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClaimIssuer} from "./IClaimIssuer.sol";

/// @title ITrustedIssuersRegistry — issuers trusted to attest claim topics
/// @notice Maps trusted claim issuers to the claim topics they are trusted to issue. Mirrors
///         the ERC-3643 TrustedIssuersRegistry. Story 4.1.
interface ITrustedIssuersRegistry {
    /// @notice Emitted when a trusted issuer is added for a set of topics.
    event TrustedIssuerAdded(IClaimIssuer indexed issuer, uint256[] claimTopics);
    /// @notice Emitted when a trusted issuer is removed.
    event TrustedIssuerRemoved(IClaimIssuer indexed issuer);
    /// @notice Emitted when a trusted issuer's topic set is replaced.
    event ClaimTopicsUpdated(IClaimIssuer indexed issuer, uint256[] claimTopics);

    /// @notice Trust `issuer` for `claimTopics`. Owner-only. Rejects an empty topic set or a
    ///         duplicate issuer.
    function addTrustedIssuer(IClaimIssuer issuer, uint256[] calldata claimTopics) external;

    /// @notice Stop trusting `issuer` entirely. Owner-only.
    function removeTrustedIssuer(IClaimIssuer issuer) external;

    /// @notice Replace the trusted topic set of `issuer`. Owner-only.
    function updateIssuerClaimTopics(IClaimIssuer issuer, uint256[] calldata claimTopics) external;

    /// @notice Return every trusted issuer.
    function getTrustedIssuers() external view returns (address[] memory);

    /// @notice Return the trusted issuers that may attest `claimTopic`.
    function getTrustedIssuersForClaimTopic(uint256 claimTopic) external view returns (address[] memory);

    /// @notice The topics `issuer` is trusted to attest.
    function getTrustedIssuerClaimTopics(IClaimIssuer issuer) external view returns (uint256[] memory);

    /// @notice True iff `issuer` is a trusted issuer.
    function isTrustedIssuer(address issuer) external view returns (bool);

    /// @notice True iff `issuer` is trusted to attest `claimTopic`.
    function hasClaimTopic(address issuer, uint256 claimTopic) external view returns (bool);
}
