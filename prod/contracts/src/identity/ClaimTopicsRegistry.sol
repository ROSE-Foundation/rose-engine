// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IClaimTopicsRegistry} from "./interface/IClaimTopicsRegistry.sol";

/// @title ClaimTopicsRegistry — required eligibility claim topics
/// @notice Owner-curated set of claim topics every eligible holder must carry. The count is
///         capped so the TOPIC axis of `IdentityRegistry.isVerified` is bounded (the
///         claims-per-topic axis is not capped here — see deferred-work). Mirrors the
///         ERC-3643 ClaimTopicsRegistry. Story 4.1 (FR-19).
contract ClaimTopicsRegistry is IClaimTopicsRegistry, Ownable {
    using EnumerableSet for EnumerableSet.UintSet;

    /// @notice Upper bound on required topics (bounds the verification loop).
    uint256 public constant MAX_CLAIM_TOPICS = 15;

    EnumerableSet.UintSet internal _claimTopics;

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @inheritdoc IClaimTopicsRegistry
    function addClaimTopic(uint256 claimTopic) external override onlyOwner {
        require(_claimTopics.length() < MAX_CLAIM_TOPICS, "ClaimTopics: max topics reached");
        require(_claimTopics.add(claimTopic), "ClaimTopics: topic already exists");
        emit ClaimTopicAdded(claimTopic);
    }

    /// @inheritdoc IClaimTopicsRegistry
    function removeClaimTopic(uint256 claimTopic) external override onlyOwner {
        require(_claimTopics.remove(claimTopic), "ClaimTopics: topic not found");
        emit ClaimTopicRemoved(claimTopic);
    }

    /// @inheritdoc IClaimTopicsRegistry
    function getClaimTopics() external view override returns (uint256[] memory) {
        return _claimTopics.values();
    }
}
