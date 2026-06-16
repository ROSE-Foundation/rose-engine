// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentity} from "./IIdentity.sol";

/// @title IIdentityRegistry — curated allowlist + on-chain eligibility predicate
/// @notice Agent-gated registry mapping holder wallets to ONCHAINID identities (the curated
///         allowlist, presupposing off-chain KYC/AML). `isVerified` is the fail-closed
///         eligibility predicate the token will consult in Story 4.2. Mirrors the ERC-3643
///         IdentityRegistry. Story 4.1 (FR-19).
interface IIdentityRegistry {
    /// @notice Emitted when a holder is added to the curated allowlist.
    event IdentityRegistered(address indexed investorAddress, IIdentity indexed identity);
    /// @notice Emitted when a holder is removed from the curated allowlist.
    event IdentityRemoved(address indexed investorAddress, IIdentity indexed identity);
    /// @notice Emitted when a holder's identity contract is replaced.
    event IdentityUpdated(IIdentity indexed oldIdentity, IIdentity indexed newIdentity);
    /// @notice Emitted when a holder's country code is updated.
    event CountryUpdated(address indexed investorAddress, uint16 indexed country);

    /// @notice Register `userAddress` → `identity` with `country`. Agent-only (curated
    ///         allowlist gate). Rejects re-registration of an already-registered wallet.
    function registerIdentity(address userAddress, IIdentity identity, uint16 country) external;

    /// @notice Replace the identity contract bound to `userAddress`. Agent-only.
    function updateIdentity(address userAddress, IIdentity identity) external;

    /// @notice Update the country code bound to `userAddress`. Agent-only.
    function updateCountry(address userAddress, uint16 country) external;

    /// @notice Remove `userAddress` from the curated allowlist. Agent-only.
    function deleteIdentity(address userAddress) external;

    /// @notice True iff `userAddress` is on the curated allowlist.
    function contains(address userAddress) external view returns (bool);

    /// @notice The identity bound to `userAddress` (zero address if not registered).
    function identity(address userAddress) external view returns (IIdentity);

    /// @notice The country code bound to `userAddress`.
    function investorCountry(address userAddress) external view returns (uint16);

    /// @notice Fail-closed eligibility: true iff `userAddress` is registered AND, for every
    ///         required claim topic, carries a non-revoked, validly-signed claim from an
    ///         issuer trusted for that topic.
    function isVerified(address userAddress) external view returns (bool);
}
