// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ITrustedIssuersRegistry} from "./interface/ITrustedIssuersRegistry.sol";
import {IClaimIssuer} from "./interface/IClaimIssuer.sol";

/// @title TrustedIssuersRegistry — issuers trusted to attest claim topics
/// @notice Owner-curated mapping of trusted claim issuers to the topics they may attest.
///         Mirrors the ERC-3643 TrustedIssuersRegistry. Story 4.1 (FR-19).
contract TrustedIssuersRegistry is ITrustedIssuersRegistry, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Upper bound on topics per issuer (bounds bookkeeping loops).
    uint256 public constant MAX_TOPICS_PER_ISSUER = 15;

    EnumerableSet.AddressSet internal _trustedIssuers;
    mapping(address => uint256[]) internal _issuerClaimTopics;
    mapping(address => mapping(uint256 => bool)) internal _issuerHasTopic;
    mapping(uint256 => EnumerableSet.AddressSet) internal _issuersByTopic;

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @inheritdoc ITrustedIssuersRegistry
    function addTrustedIssuer(IClaimIssuer issuer, uint256[] calldata claimTopics) external override onlyOwner {
        require(address(issuer) != address(0), "TrustedIssuers: zero issuer");
        // The issuer MUST be a contract: IdentityRegistry.isVerified calls isClaimValid on it,
        // and a high-level call to a codeless account (an EOA added by mistake) would revert in
        // a way try/catch cannot contain. Requiring code keeps the verification path total.
        require(address(issuer).code.length > 0, "TrustedIssuers: issuer not a contract");
        require(claimTopics.length > 0, "TrustedIssuers: no topics");
        require(claimTopics.length <= MAX_TOPICS_PER_ISSUER, "TrustedIssuers: too many topics");
        require(_trustedIssuers.add(address(issuer)), "TrustedIssuers: already trusted");

        _setIssuerTopics(address(issuer), claimTopics);
        emit TrustedIssuerAdded(issuer, claimTopics);
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function removeTrustedIssuer(IClaimIssuer issuer) external override onlyOwner {
        require(_trustedIssuers.remove(address(issuer)), "TrustedIssuers: not trusted");
        _clearIssuerTopics(address(issuer));
        emit TrustedIssuerRemoved(issuer);
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function updateIssuerClaimTopics(IClaimIssuer issuer, uint256[] calldata claimTopics) external override onlyOwner {
        require(_trustedIssuers.contains(address(issuer)), "TrustedIssuers: not trusted");
        require(claimTopics.length > 0, "TrustedIssuers: no topics");
        require(claimTopics.length <= MAX_TOPICS_PER_ISSUER, "TrustedIssuers: too many topics");

        _clearIssuerTopics(address(issuer));
        _setIssuerTopics(address(issuer), claimTopics);
        emit ClaimTopicsUpdated(issuer, claimTopics);
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function getTrustedIssuers() external view override returns (address[] memory) {
        return _trustedIssuers.values();
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function getTrustedIssuersForClaimTopic(uint256 claimTopic) external view override returns (address[] memory) {
        return _issuersByTopic[claimTopic].values();
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function getTrustedIssuerClaimTopics(IClaimIssuer issuer) external view override returns (uint256[] memory) {
        return _issuerClaimTopics[address(issuer)];
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function isTrustedIssuer(address issuer) external view override returns (bool) {
        return _trustedIssuers.contains(issuer);
    }

    /// @inheritdoc ITrustedIssuersRegistry
    function hasClaimTopic(address issuer, uint256 claimTopic) external view override returns (bool) {
        return _issuerHasTopic[issuer][claimTopic];
    }

    /// @dev Record `claimTopics` for `issuer`, rejecting duplicate topics in the same set.
    function _setIssuerTopics(address issuer, uint256[] calldata claimTopics) internal {
        for (uint256 i = 0; i < claimTopics.length; i++) {
            uint256 topic = claimTopics[i];
            require(!_issuerHasTopic[issuer][topic], "TrustedIssuers: duplicate topic");
            _issuerHasTopic[issuer][topic] = true;
            _issuersByTopic[topic].add(issuer);
        }
        _issuerClaimTopics[issuer] = claimTopics;
    }

    /// @dev Erase all topic bookkeeping for `issuer`.
    function _clearIssuerTopics(address issuer) internal {
        uint256[] memory topics = _issuerClaimTopics[issuer];
        for (uint256 i = 0; i < topics.length; i++) {
            uint256 topic = topics[i];
            _issuerHasTopic[issuer][topic] = false;
            _issuersByTopic[topic].remove(issuer);
        }
        delete _issuerClaimTopics[issuer];
    }
}
