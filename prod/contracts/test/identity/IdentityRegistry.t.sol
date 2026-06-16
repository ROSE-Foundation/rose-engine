// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "./ClaimFixtures.sol";
import {IdentityRegistry} from "../../src/identity/IdentityRegistry.sol";
import {ClaimTopicsRegistry} from "../../src/identity/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "../../src/identity/TrustedIssuersRegistry.sol";
import {ClaimIssuer} from "../../src/identity/ClaimIssuer.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IIdentity} from "../../src/identity/interface/IIdentity.sol";
import {IClaimIssuer} from "../../src/identity/interface/IClaimIssuer.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";

/// @dev A registered identity contract that reverts on every call — used to prove
///      `isVerified` is TOTAL (never reverts) even against a hostile/buggy identity.
contract RevertingIdentity {
    fallback() external payable {
        revert("RevertingIdentity: boom");
    }
}

/// @title IdentityRegistry end-to-end tests — curated allowlist + fail-closed eligibility.
/// @notice Exercises the full AC-1 path: register an ONCHAINID, issue a KYC claim from the
///         trusted issuer, and confirm the three registries record the eligible holder; plus
///         every fail-closed branch of `isVerified` and the agent-gating of the allowlist.
contract IdentityRegistryTest is ClaimFixtures {
    IdentityRegistry internal registry;
    ClaimTopicsRegistry internal topicsRegistry;
    TrustedIssuersRegistry internal issuersRegistry;
    ClaimIssuer internal issuer;

    address internal owner = address(this);
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");
    address internal holderWallet = makeAddr("holderWallet");

    uint256 internal constant KYC = ClaimTopics.ONCHAINID_KYC;
    bytes internal constant DATA = bytes("kyc:passed");

    function setUp() public {
        topicsRegistry = new ClaimTopicsRegistry(owner);
        issuersRegistry = new TrustedIssuersRegistry(owner);
        registry = new IdentityRegistry(owner, topicsRegistry, issuersRegistry);

        registry.addAgent(agent);

        // Trusted claim issuer whose CLAIM signing key is CLAIM_SIGNER_PK.
        issuer = new ClaimIssuer(address(this));
        issuer.addKey(_keyHash(_claimSignerAddr()), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());

        // Required eligibility topic + trust the issuer for it.
        topicsRegistry.addClaimTopic(KYC);
        uint256[] memory topics = new uint256[](1);
        topics[0] = KYC;
        issuersRegistry.addTrustedIssuer(IClaimIssuer(address(issuer)), topics);
    }

    /// @dev Deploy a fresh holder identity (management key = this test) and issue a valid
    ///      KYC claim from `claimIssuer`.
    function _newVerifiedIdentity(ClaimIssuer claimIssuer) internal returns (Identity id, bytes memory sig) {
        id = new Identity(address(this));
        sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, address(claimIssuer), sig, DATA, "");
    }

    // --- curated allowlist gating (AC-1) ------------------------------------

    function test_RegisterIdentity_ByAgent() public {
        (Identity id,) = _newVerifiedIdentity(issuer);

        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertTrue(registry.contains(holderWallet));
        assertEq(address(registry.identity(holderWallet)), address(id));
        assertEq(registry.investorCountry(holderWallet), 250);
    }

    function test_RegisterIdentity_RevertWhen_NotAgent() public {
        (Identity id,) = _newVerifiedIdentity(issuer);
        vm.prank(stranger);
        vm.expectRevert(bytes("AgentRole: caller is not an agent"));
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
    }

    function test_RegisterIdentity_RevertWhen_OwnerIsNotAgent() public {
        // Owner is NOT implicitly an agent — allowlist mutation is agent-gated.
        (Identity id,) = _newVerifiedIdentity(issuer);
        vm.expectRevert(bytes("AgentRole: caller is not an agent"));
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
    }

    function test_RegisterIdentity_RevertWhen_AlreadyRegistered() public {
        (Identity id,) = _newVerifiedIdentity(issuer);
        vm.startPrank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
        vm.expectRevert(bytes("IdentityRegistry: already registered"));
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
        vm.stopPrank();
    }

    function test_DeleteIdentity_RemovesFromAllowlist() public {
        (Identity id,) = _newVerifiedIdentity(issuer);
        vm.startPrank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
        registry.deleteIdentity(holderWallet);
        vm.stopPrank();

        assertFalse(registry.contains(holderWallet));
        assertFalse(registry.isVerified(holderWallet));
    }

    // --- eligibility predicate (AC-1, fail-closed) --------------------------

    function test_IsVerified_True_EndToEnd() public {
        (Identity id,) = _newVerifiedIdentity(issuer);
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertTrue(registry.isVerified(holderWallet));
    }

    function test_IsVerified_False_WhenNotRegistered() public view {
        assertFalse(registry.isVerified(holderWallet));
    }

    function test_IsVerified_False_WhenRegisteredButNoClaim() public {
        Identity id = new Identity(address(this)); // no KYC claim issued
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertFalse(registry.isVerified(holderWallet));
    }

    function test_IsVerified_False_WhenClaimRevoked() public {
        (Identity id, bytes memory sig) = _newVerifiedIdentity(issuer);
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
        assertTrue(registry.isVerified(holderWallet));

        issuer.revokeClaimBySignature(sig);
        assertFalse(registry.isVerified(holderWallet));
    }

    function test_IsVerified_False_WhenIssuerNotTrusted() public {
        // Claim signed by a DIFFERENT issuer that is not in the trusted registry.
        ClaimIssuer untrusted = new ClaimIssuer(address(this));
        untrusted.addKey(_keyHash(_claimSignerAddr()), untrusted.CLAIM_SIGNER_KEY(), untrusted.ECDSA_TYPE());
        (Identity id,) = _newVerifiedIdentity(untrusted);

        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertFalse(registry.isVerified(holderWallet));
    }

    function test_IsVerified_False_WhenIssuerNotTrustedForThatTopic() public {
        // Trust the issuer, but only for an unrelated topic; the required KYC topic is unmet.
        ClaimIssuer otherIssuer = new ClaimIssuer(address(this));
        otherIssuer.addKey(_keyHash(_claimSignerAddr()), otherIssuer.CLAIM_SIGNER_KEY(), otherIssuer.ECDSA_TYPE());
        uint256[] memory wrongTopics = new uint256[](1);
        wrongTopics[0] = 999;
        issuersRegistry.addTrustedIssuer(IClaimIssuer(address(otherIssuer)), wrongTopics);

        (Identity id,) = _newVerifiedIdentity(otherIssuer);
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertFalse(registry.isVerified(holderWallet));
    }

    // Regression (review Blind-MED): isVerified must stay TOTAL — a registered identity that
    // reverts on getClaim* must yield `false`, never propagate the revert (fail closed, no DoS).
    function test_IsVerified_DoesNotRevert_WhenIdentityReverts() public {
        RevertingIdentity hostile = new RevertingIdentity();
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(hostile)), 250);

        assertFalse(registry.isVerified(holderWallet));
    }

    // Regression (review L1): an identity with several claims for the required topic (one valid,
    // others from untrusted issuers) is verified via the valid one.
    function test_IsVerified_True_WithMultipleClaimsForTopic() public {
        (Identity id,) = _newVerifiedIdentity(issuer); // valid, trusted claim
        // A second claim for the SAME topic from an untrusted issuer address (distinct claimId).
        id.addClaim(KYC, 1, makeAddr("untrustedIssuer"), hex"00", DATA, "");

        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertTrue(registry.isVerified(holderWallet));
    }

    // Story 4.5 hardening (inverts the 4.1 ERC-3643 deferral): with ZERO required topics the
    // registry verifies NO ONE — even a registered holder is denied (fail-closed, NFR-4).
    // Production keeps the topic set non-empty (rule-spec .min(1), seeded from the generated config
    // via `GeneratedComplianceConfig.seedClaimTopics` in 4.5).
    function test_IsVerified_EmptyTopics_FailsClosed_AfterHardening() public {
        topicsRegistry.removeClaimTopic(KYC);
        Identity id = new Identity(address(this)); // no claims
        vm.prank(agent);
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);

        assertFalse(registry.isVerified(holderWallet));
    }

    // --- fuzz ---------------------------------------------------------------

    function testFuzz_IsVerified_False_ForUnregisteredAddress(address who) public view {
        vm.assume(who != holderWallet);
        assertFalse(registry.isVerified(who));
    }

    function testFuzz_RegisterIdentity_RevertWhen_NonAgentCaller(address caller) public {
        vm.assume(caller != agent);
        (Identity id,) = _newVerifiedIdentity(issuer);
        vm.prank(caller);
        vm.expectRevert(bytes("AgentRole: caller is not an agent"));
        registry.registerIdentity(holderWallet, IIdentity(address(id)), 250);
    }
}
