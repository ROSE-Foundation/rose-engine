// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "../identity/ClaimFixtures.sol";
import {GeneratedComplianceConfig} from "../../src/generated/GeneratedComplianceConfig.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";
import {ClaimTopicsRegistry} from "../../src/identity/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "../../src/identity/TrustedIssuersRegistry.sol";
import {IdentityRegistry} from "../../src/identity/IdentityRegistry.sol";
import {ClaimIssuer} from "../../src/identity/ClaimIssuer.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IIdentity} from "../../src/identity/interface/IIdentity.sol";
import {IClaimIssuer} from "../../src/identity/interface/IClaimIssuer.sol";

/// @title GeneratedComplianceConfig — generated-config consumption + dual-plane equivalence (4.5)
/// @notice Proves the on-chain plane derives from the SAME rule-spec source as the off-chain plane:
///         the eligibility topic == `uint256(keccak256("ONCHAINID_KYC"))` (generated value), the
///         `ClaimTopicsRegistry` is SEEDED from the generated config, the curated allowlist ==
///         `IdentityRegistry` (eligible iff registered + valid KYC claim), and the Story-4.5
///         ≥1-topic fail-closed hardening holds. The 10 shared flow vectors are exercised against
///         the on-chain plane in the TS dual-plane conformance test; here we prove the on-chain
///         PRIMITIVES on the real EVM contracts (FR-19, §8 Q5, SM-4).
contract GeneratedComplianceConfigTest is ClaimFixtures {
    ClaimTopicsRegistry internal topicsRegistry;
    TrustedIssuersRegistry internal issuersRegistry;
    IdentityRegistry internal registry;
    ClaimIssuer internal issuer;

    address internal owner = address(this);
    address internal agent = makeAddr("agent");
    address internal holderWallet = makeAddr("holderWallet");

    uint256 internal constant KYC = ClaimTopics.ONCHAINID_KYC;
    bytes internal constant DATA = bytes("kyc:passed");

    function setUp() public {
        topicsRegistry = new ClaimTopicsRegistry(owner);
        issuersRegistry = new TrustedIssuersRegistry(owner);
        registry = new IdentityRegistry(owner, topicsRegistry, issuersRegistry);
        registry.addAgent(agent);

        issuer = new ClaimIssuer(address(this));
        issuer.addKey(_keyHash(_claimSignerAddr()), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());

        // SEED the required topics FROM the generated config (not a hand-written addClaimTopic).
        GeneratedComplianceConfig.seedClaimTopics(topicsRegistry);

        // Trust the issuer for exactly the generated topics.
        issuersRegistry.addTrustedIssuer(IClaimIssuer(address(issuer)), GeneratedComplianceConfig.requiredClaimTopics());
    }

    function _newVerifiedIdentity() internal returns (Identity id) {
        id = new Identity(address(this));
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, address(issuer), sig, DATA, "");
    }

    // --- AC-1: topic == keccak256("ONCHAINID_KYC"), single-sourced & generated ----------------

    function test_TopicId_EqualsGeneratedKeccak() public pure {
        // The convened equivalence: the on-chain eligibility topic is the generated keccak value.
        assertEq(GeneratedComplianceConfig.ONCHAINID_KYC, uint256(keccak256("ONCHAINID_KYC")));
        // `ClaimTopics.ONCHAINID_KYC` (consumed across the suite) re-exports the GENERATED value.
        assertEq(ClaimTopics.ONCHAINID_KYC, GeneratedComplianceConfig.ONCHAINID_KYC);
    }

    function test_RequiredTopics_NonEmpty_ContainsKyc() public pure {
        uint256[] memory topics = GeneratedComplianceConfig.requiredClaimTopics();
        assertGe(topics.length, 1, "must require >= 1 topic");
        bool found;
        for (uint256 i = 0; i < topics.length; i++) {
            if (topics[i] == GeneratedComplianceConfig.ONCHAINID_KYC) {
                found = true;
            }
        }
        assertTrue(found, "generated topics must contain ONCHAINID_KYC");
    }

    function test_RequireAllowlist_IsTrue() public pure {
        // Allowlist == IdentityRegistry: eligibility requires curated registration.
        assertTrue(GeneratedComplianceConfig.REQUIRE_ALLOWLIST);
    }

    // --- AC-1: ClaimTopicsRegistry seeded from the generated config ---------------------------

    function test_Seeding_RegistryMatchesGeneratedTopics() public {
        // A fresh registry seeded by the generated primitive carries exactly the generated topics.
        ClaimTopicsRegistry fresh = new ClaimTopicsRegistry(owner);
        GeneratedComplianceConfig.seedClaimTopics(fresh);

        uint256[] memory onChain = fresh.getClaimTopics();
        uint256[] memory generated = GeneratedComplianceConfig.requiredClaimTopics();
        assertEq(onChain.length, generated.length);
        for (uint256 i = 0; i < generated.length; i++) {
            assertEq(onChain[i], generated[i]);
        }
        // And the setUp registry (also generated-seeded) agrees.
        assertEq(topicsRegistry.getClaimTopics().length, generated.length);
    }

    // --- AC-2: dual-plane eligibility on the REAL contracts (allowlist + topic == decision) ---

    function test_OnChainEligibility_VerifiedHolder_IsEligible() public {
        Identity id = _newVerifiedIdentity();
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        // Registered (allowlist) + valid generated-topic KYC claim ⇒ eligible (on-chain ALLOW).
        assertTrue(registry.isVerified(holderWallet));
    }

    function test_OnChainEligibility_Unregistered_IsDenied() public view {
        // Not on the curated allowlist ⇒ not eligible (on-chain DENY).
        assertFalse(registry.isVerified(holderWallet));
    }

    function test_OnChainEligibility_RegisteredButNoClaim_IsDenied() public {
        Identity id = new Identity(address(this)); // no KYC claim
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        // On the allowlist but missing the required generated topic ⇒ denied.
        assertFalse(registry.isVerified(holderWallet));
    }

    // --- AC-1: Story-4.5 >=1-topic FAIL-CLOSED hardening --------------------------------------

    function test_ZeroTopics_FailsClosed_EvenForRegisteredHolder() public {
        // A brand-new, UN-SEEDED topics registry (zero topics) must verify NO ONE — the explicit
        // 4.5 hardening that inverts the canonical ERC-3643 "empty ⇒ verified" deferral (4.1).
        ClaimTopicsRegistry emptyTopics = new ClaimTopicsRegistry(owner);
        IdentityRegistry emptyRegistry = new IdentityRegistry(owner, emptyTopics, issuersRegistry);
        emptyRegistry.addAgent(agent);

        Identity id = _newVerifiedIdentity();
        vm.prank(agent);
        emptyRegistry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertEq(emptyTopics.getClaimTopics().length, 0, "precondition: zero required topics");
        assertFalse(emptyRegistry.isVerified(holderWallet), "zero topics must fail closed");
    }
}
