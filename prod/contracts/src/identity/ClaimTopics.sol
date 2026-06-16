// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GeneratedComplianceConfig} from "../generated/GeneratedComplianceConfig.sol";

/// @title ClaimTopics — on-chain claim-topic vocabulary, GENERATED from the rule-spec
/// @notice Maps the `@rose/rule-spec` eligibility claim-topic LABELS to their on-chain
///         `uint256` topic ids. The single source of truth is
///         `prod/packages/rule-spec/src/spec/rule-spec.v1.ts`:
///         `eligibility.requiredClaimTopics = ['ONCHAINID_KYC']`.
/// @dev    DERIVATION (Story 4.5): the value is no longer hand-pinned — it is re-exported from the
///         GENERATED `GeneratedComplianceConfig` library, which the rule-spec → on-chain codegen
///         emits from the single source. The on-chain claim-topics registry is likewise seeded from
///         that library (`GeneratedComplianceConfig.seedClaimTopics`), so the off-chain and on-chain
///         planes cannot silently diverge (FR-19, §8 Q5, SM-4). Do NOT add topics here by hand.
library ClaimTopics {
    /// @notice The ONCHAINID KYC/AML eligibility topic — `uint256(keccak256("ONCHAINID_KYC"))`,
    ///         re-exported from the generated config so the value is single-sourced.
    uint256 internal constant ONCHAINID_KYC = GeneratedComplianceConfig.ONCHAINID_KYC;
}
