// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AgentRole} from "./AgentRole.sol";
import {IIdentityRegistry} from "./interface/IIdentityRegistry.sol";
import {IClaimTopicsRegistry} from "./interface/IClaimTopicsRegistry.sol";
import {ITrustedIssuersRegistry} from "./interface/ITrustedIssuersRegistry.sol";
import {IIdentity} from "./interface/IIdentity.sol";
import {IClaimIssuer} from "./interface/IClaimIssuer.sol";

/// @title IdentityRegistry — curated allowlist + fail-closed eligibility predicate
/// @notice Agent-gated registry binding holder wallets to ONCHAINID identities (the curated
///         allowlist; registration presupposes off-chain KYC/AML passed). `isVerified` ties
///         the identity, claim-topics, and trusted-issuers registries together into the
///         on-chain eligibility decision the token will enforce in Story 4.2. Mirrors the
///         ERC-3643 IdentityRegistry. Story 4.1 (FR-19 foundation).
contract IdentityRegistry is IIdentityRegistry, AgentRole {
    /// @notice The required claim topics registry.
    IClaimTopicsRegistry public immutable claimTopicsRegistry;
    /// @notice The trusted issuers registry.
    ITrustedIssuersRegistry public immutable trustedIssuersRegistry;

    mapping(address => IIdentity) internal _identities;
    mapping(address => uint16) internal _countries;

    constructor(
        address initialOwner,
        IClaimTopicsRegistry claimTopicsRegistry_,
        ITrustedIssuersRegistry trustedIssuersRegistry_
    ) Ownable(initialOwner) {
        require(address(claimTopicsRegistry_) != address(0), "IdentityRegistry: zero topics registry");
        require(address(trustedIssuersRegistry_) != address(0), "IdentityRegistry: zero issuers registry");
        claimTopicsRegistry = claimTopicsRegistry_;
        trustedIssuersRegistry = trustedIssuersRegistry_;
    }

    /// @inheritdoc IIdentityRegistry
    function registerIdentity(address userAddress, IIdentity identity_, uint16 country) external override onlyAgent {
        require(userAddress != address(0), "IdentityRegistry: zero wallet");
        require(address(identity_) != address(0), "IdentityRegistry: zero identity");
        require(address(_identities[userAddress]) == address(0), "IdentityRegistry: already registered");
        _identities[userAddress] = identity_;
        _countries[userAddress] = country;
        emit IdentityRegistered(userAddress, identity_);
    }

    /// @inheritdoc IIdentityRegistry
    function updateIdentity(address userAddress, IIdentity identity_) external override onlyAgent {
        require(address(identity_) != address(0), "IdentityRegistry: zero identity");
        IIdentity old = _identities[userAddress];
        require(address(old) != address(0), "IdentityRegistry: not registered");
        _identities[userAddress] = identity_;
        emit IdentityUpdated(old, identity_);
    }

    /// @inheritdoc IIdentityRegistry
    function updateCountry(address userAddress, uint16 country) external override onlyAgent {
        require(address(_identities[userAddress]) != address(0), "IdentityRegistry: not registered");
        _countries[userAddress] = country;
        emit CountryUpdated(userAddress, country);
    }

    /// @inheritdoc IIdentityRegistry
    function deleteIdentity(address userAddress) external override onlyAgent {
        IIdentity old = _identities[userAddress];
        require(address(old) != address(0), "IdentityRegistry: not registered");
        delete _identities[userAddress];
        delete _countries[userAddress];
        emit IdentityRemoved(userAddress, old);
    }

    /// @inheritdoc IIdentityRegistry
    function contains(address userAddress) external view override returns (bool) {
        return address(_identities[userAddress]) != address(0);
    }

    /// @inheritdoc IIdentityRegistry
    function identity(address userAddress) external view override returns (IIdentity) {
        return _identities[userAddress];
    }

    /// @inheritdoc IIdentityRegistry
    function investorCountry(address userAddress) external view override returns (uint16) {
        return _countries[userAddress];
    }

    /// @inheritdoc IIdentityRegistry
    function isVerified(address userAddress) external view override returns (bool) {
        IIdentity id = _identities[userAddress];
        if (address(id) == address(0)) {
            // Not on the curated allowlist ⇒ not eligible (fail closed).
            return false;
        }

        // Story 4.5 hardening (≥1 required topic, fail-closed): an un-seeded topics registry
        // verifies NO ONE. The single source `@rose/rule-spec` `eligibility.requiredClaimTopics`
        // is `.min(1)` and `GeneratedComplianceConfig.seedClaimTopics` seeds the registry from it,
        // so an empty set is only a transient admin/deploy window — and during that window
        // eligibility is DENY by default (NFR-4), not the canonical ERC-3643 "empty ⇒ verified".
        uint256[] memory requiredTopics = claimTopicsRegistry.getClaimTopics();
        if (requiredTopics.length == 0) {
            return false;
        }
        for (uint256 i = 0; i < requiredTopics.length; i++) {
            if (!_hasValidClaimForTopic(id, requiredTopics[i])) {
                return false;
            }
        }
        return true;
    }

    /// @dev True iff `id` carries at least one non-revoked, validly-signed claim for `topic`
    ///      from an issuer trusted for that topic. Every external call — to the (agent-curated
    ///      but still arbitrary) holder identity AND to the trusted issuer — is wrapped in
    ///      try/catch so a reverting/garbage-returning callee is treated as "no valid claim".
    ///      This keeps `isVerified` TOTAL: it always returns a bool and never reverts, so a
    ///      malicious-but-registered identity cannot turn the eligibility predicate into a DoS
    ///      (fail closed). NOTE: try/catch does not catch out-of-gas; a holder that bloats its
    ///      own claim list can only grief its own verification (see deferred-work: claim cap).
    function _hasValidClaimForTopic(IIdentity id, uint256 topic) internal view returns (bool) {
        bytes32[] memory claimIds;
        try id.getClaimIdsByTopic(topic) returns (bytes32[] memory ids) {
            claimIds = ids;
        } catch {
            return false;
        }

        for (uint256 j = 0; j < claimIds.length; j++) {
            uint256 claimTopic;
            address issuer;
            bytes memory signature;
            bytes memory data;
            try id.getClaim(claimIds[j]) returns (
                uint256 t, uint256, address iss, bytes memory sig, bytes memory d, string memory
            ) {
                claimTopic = t;
                issuer = iss;
                signature = sig;
                data = d;
            } catch {
                continue;
            }

            if (claimTopic != topic) {
                continue;
            }
            if (!trustedIssuersRegistry.isTrustedIssuer(issuer)) {
                continue;
            }
            if (!trustedIssuersRegistry.hasClaimTopic(issuer, topic)) {
                continue;
            }
            try IClaimIssuer(issuer).isClaimValid(id, topic, signature, data) returns (bool valid) {
                if (valid) {
                    return true;
                }
            } catch {
                continue;
            }
        }
        return false;
    }
}
