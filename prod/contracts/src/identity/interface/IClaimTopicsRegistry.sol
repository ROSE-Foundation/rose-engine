// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IClaimTopicsRegistry — required eligibility claim topics
/// @notice The set of claim topics every eligible holder must carry. Mirrors the ERC-3643
///         ClaimTopicsRegistry. The P0 required topic is `ClaimTopics.ONCHAINID_KYC`, kept
///         in sync with `rose/rule-spec` `eligibility.requiredClaimTopics`. Story 4.1.
interface IClaimTopicsRegistry {
    /// @notice Emitted when a required claim topic is added.
    event ClaimTopicAdded(uint256 indexed claimTopic);
    /// @notice Emitted when a required claim topic is removed.
    event ClaimTopicRemoved(uint256 indexed claimTopic);

    /// @notice Add `claimTopic` to the required set. Owner-only. Rejects duplicates.
    function addClaimTopic(uint256 claimTopic) external;

    /// @notice Remove `claimTopic` from the required set. Owner-only.
    function removeClaimTopic(uint256 claimTopic) external;

    /// @notice Return every required claim topic.
    function getClaimTopics() external view returns (uint256[] memory);
}
