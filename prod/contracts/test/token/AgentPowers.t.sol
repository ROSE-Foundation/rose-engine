// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "../identity/ClaimFixtures.sol";
import {CoupledPair} from "../../src/token/CoupledPair.sol";
import {CoupledLeg} from "../../src/token/CoupledLeg.sol";
import {RoseToken} from "../../src/token/RoseToken.sol";
import {IdentityRegistry} from "../../src/identity/IdentityRegistry.sol";
import {ClaimTopicsRegistry} from "../../src/identity/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "../../src/identity/TrustedIssuersRegistry.sol";
import {ClaimIssuer} from "../../src/identity/ClaimIssuer.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IIdentity} from "../../src/identity/interface/IIdentity.sol";
import {IIdentityRegistry} from "../../src/identity/interface/IIdentityRegistry.sol";
import {IClaimIssuer} from "../../src/identity/interface/IClaimIssuer.sol";
import {GeneratedComplianceConfig} from "../../src/generated/GeneratedComplianceConfig.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Transfer-agent agent-power tests (Story 4.6, FR-22).
/// @notice Stands up the full identity stack (topics seeded via `GeneratedComplianceConfig`),
///         a `CoupledPair` with a transfer-agent granted on both legs, and a standalone
///         `RoseToken`, and proves: every agent power is gated to the `AgentRole` transfer-agent
///         (non-agent reverts), forced transfer bypasses sender-eligibility / freeze / pause but
///         keeps the recipient + Model-A checks, freeze blocks normal movement, pause blocks
///         normal transfers but not agent/owner ops, and recovery relocates the FULL balance +
///         segregated principal + freeze state to a verified new wallet (audit trail), leaving the
///         coupling supply invariant intact.
contract AgentPowersTest is ClaimFixtures {
    CoupledPair internal pair;
    CoupledLeg internal lToken;
    CoupledLeg internal sToken;
    RoseToken internal solo;
    IdentityRegistry internal registry;
    ClaimTopicsRegistry internal topicsRegistry;
    TrustedIssuersRegistry internal issuersRegistry;
    ClaimIssuer internal issuer;

    address internal owner = address(this);
    address internal agent = makeAddr("agent");
    address internal identityAgent = makeAddr("identityAgent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant KYC = ClaimTopics.ONCHAINID_KYC;
    bytes internal constant DATA = bytes("kyc:passed");

    bytes internal constant NOT_AGENT = bytes("AgentRole: caller is not an agent");

    function setUp() public {
        topicsRegistry = new ClaimTopicsRegistry(owner);
        issuersRegistry = new TrustedIssuersRegistry(owner);
        registry = new IdentityRegistry(owner, topicsRegistry, issuersRegistry);
        registry.addAgent(identityAgent);

        issuer = new ClaimIssuer(address(this));
        issuer.addKey(_keyHash(_claimSignerAddr()), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());

        GeneratedComplianceConfig.seedClaimTopics(topicsRegistry);
        issuersRegistry.addTrustedIssuer(IClaimIssuer(address(issuer)), GeneratedComplianceConfig.requiredClaimTopics());

        _registerVerified(alice);
        _registerVerified(bob);
        _registerVerified(carol);
        _registerVerified(dave);

        pair = new CoupledPair(IIdentityRegistry(address(registry)), "Rose L", "ROSE-L", "Rose S", "ROSE-S", owner);
        lToken = CoupledLeg(address(pair.lToken()));
        sToken = CoupledLeg(address(pair.sToken()));
        // Grant the transfer-agent role on BOTH legs via the pair forwarder.
        pair.addLegAgent(agent);

        // Standalone token (the non-coupled path), owned by this test, with the agent granted.
        solo = new RoseToken("Solo Rose", "SOLO", IIdentityRegistry(address(registry)), owner);
        solo.addAgent(agent);
    }

    function _registerVerified(address wallet) internal returns (Identity id, bytes memory sig) {
        id = new Identity(address(this));
        sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, address(issuer), sig, DATA, "");
        vm.prank(identityAgent);
        registry.registerIdentity(wallet, IIdentity(address(id)), 250);
        assertTrue(registry.isVerified(wallet));
    }

    function _claimFor(address wallet) internal view returns (bytes memory sig) {
        address idAddr = address(registry.identity(wallet));
        sig = _signClaim(CLAIM_SIGNER_PK, idAddr, KYC, DATA);
    }

    // =====================================================================================
    // AC-1: every power is gated to the transfer-agent role (non-agent reverts)
    // =====================================================================================

    function test_RevertWhen_SetAddressFrozen_NotAgent() public {
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.setAddressFrozen(alice, true);
    }

    function test_RevertWhen_FreezePartialTokens_NotAgent() public {
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.freezePartialTokens(alice, 1);
    }

    function test_RevertWhen_UnfreezePartialTokens_NotAgent() public {
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.unfreezePartialTokens(alice, 1);
    }

    function test_RevertWhen_Pause_NotAgent() public {
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.pause();
    }

    function test_RevertWhen_Unpause_NotAgent() public {
        vm.prank(agent);
        lToken.pause();
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.unpause();
    }

    function test_RevertWhen_ForcedTransfer_NotAgent() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.forcedTransfer(alice, bob, 100 ether);
    }

    function test_RevertWhen_RecoveryAddress_NotAgent() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        lToken.recoveryAddress(alice, bob);
    }

    function test_RevertWhen_AddLegAgent_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pair.addLegAgent(stranger);
    }

    function testFuzz_ForcedTransfer_RevertsForNonAgent(address caller) public {
        vm.assume(caller != agent && caller != address(0));
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(caller);
        vm.expectRevert(NOT_AGENT);
        lToken.forcedTransfer(alice, bob, 1 ether);
    }

    function testFuzz_RecoveryAddress_RevertsForNonAgent(address caller) public {
        vm.assume(caller != agent && caller != address(0));
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(caller);
        vm.expectRevert(NOT_AGENT);
        lToken.recoveryAddress(alice, bob);
    }

    // =====================================================================================
    // AC-1 / AC-3: forced transfer happy path + semantics
    // =====================================================================================

    function test_ForcedTransfer_Succeeds_ByAgent() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.forcedTransfer(alice, bob, 400 ether);
        assertEq(lToken.balanceOf(alice), 600 ether);
        assertEq(lToken.balanceOf(bob), 400 ether);
    }

    function test_ForcedTransfer_FromRevokedHolder_BypassesSenderEligibility() public {
        pair.mintPair(alice, carol, 1_000 ether);
        // Revoke alice's claim: she can no longer transfer herself...
        issuer.revokeClaimBySignature(_claimFor(alice));
        assertFalse(registry.isVerified(alice));
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: sender not eligible"));
        lToken.transfer(bob, 1 ether);
        // ...but the agent CAN force tokens out of her to an eligible recipient.
        vm.prank(agent);
        lToken.forcedTransfer(alice, bob, 250 ether);
        assertEq(lToken.balanceOf(bob), 250 ether);
        assertEq(lToken.balanceOf(alice), 750 ether);
    }

    function test_ForcedTransfer_FromAddressFrozenHolder_Succeeds() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.setAddressFrozen(alice, true);
        // Alice cannot move herself (address frozen)...
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: frozen address"));
        lToken.transfer(bob, 1 ether);
        // ...but the agent forced op bypasses the address freeze (AC-3).
        vm.prank(agent);
        lToken.forcedTransfer(alice, bob, 300 ether);
        assertEq(lToken.balanceOf(bob), 300 ether);
        assertEq(lToken.balanceOf(alice), 700 ether);
    }

    function test_RevertWhen_ForcedTransfer_RecipientNotEligible() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        lToken.forcedTransfer(alice, stranger, 100 ether);
    }

    function test_ForcedTransfer_AutoThawsFrozenTokens() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.freezePartialTokens(alice, 800 ether); // free = 200
        vm.prank(agent);
        lToken.forcedTransfer(alice, bob, 500 ether); // thaws 300
        assertEq(lToken.balanceOf(alice), 500 ether);
        assertEq(lToken.balanceOf(bob), 500 ether);
        assertEq(lToken.frozenTokens(alice), 500 ether); // 800 - 300 thawed
    }

    function test_RevertWhen_ForcedTransfer_WouldMovePrincipal() public {
        pair.mintPair(alice, carol, 1_000 ether);
        pair.designateLPrincipal(alice, 600 ether); // 400 yield surplus
        // Forcing the yield surplus is fine...
        vm.prank(agent);
        lToken.forcedTransfer(alice, bob, 400 ether);
        // ...but forcing into principal is rejected — the Model-A bright line still holds.
        vm.prank(agent);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        lToken.forcedTransfer(alice, bob, 1 ether);
    }

    // =====================================================================================
    // AC-3: address freeze + partial freeze on the NORMAL transfer path
    // =====================================================================================

    function test_RevertWhen_FrozenSender_CannotTransfer() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.setAddressFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: frozen address"));
        lToken.transfer(bob, 1 ether);
    }

    function test_RevertWhen_FrozenRecipient_CannotReceive() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.setAddressFrozen(bob, true);
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: frozen address"));
        lToken.transfer(bob, 1 ether);
    }

    function test_PartialFreeze_BlocksFrozenPortionOnly() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.freezePartialTokens(alice, 600 ether); // 400 movable
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: insufficient unfrozen balance"));
        lToken.transfer(bob, 401 ether);
        // exactly the unfrozen surplus moves
        vm.prank(alice);
        lToken.transfer(bob, 400 ether);
        assertEq(lToken.balanceOf(bob), 400 ether);
    }

    function test_UnfreezePartialTokens_RestoresMovability() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.freezePartialTokens(alice, 600 ether);
        vm.prank(agent);
        lToken.unfreezePartialTokens(alice, 600 ether);
        assertEq(lToken.frozenTokens(alice), 0);
        vm.prank(alice);
        lToken.transfer(bob, 1_000 ether);
        assertEq(lToken.balanceOf(bob), 1_000 ether);
    }

    function test_RevertWhen_FreezePartial_ExceedsBalance() public {
        pair.mintPair(alice, carol, 100 ether);
        vm.prank(agent);
        vm.expectRevert(bytes("RoseToken: freeze exceeds balance"));
        lToken.freezePartialTokens(alice, 101 ether);
    }

    function test_BurnClampsFrozenTokens_OnStandaloneToken() public {
        solo.mint(alice, 1_000 ether);
        vm.prank(agent);
        solo.freezePartialTokens(alice, 800 ether);
        solo.burn(alice, 950 ether); // balance → 50, frozen must clamp to 50
        assertEq(solo.balanceOf(alice), 50 ether);
        assertEq(solo.frozenTokens(alice), 50 ether);
    }

    // =====================================================================================
    // AC-3: pause blocks normal transfers but not agent/owner powers
    // =====================================================================================

    function test_RevertWhen_Paused_NormalTransferBlocked() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        lToken.transfer(bob, 1 ether);
    }

    function test_Paused_AgentAndOwnerPowersStillWork() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.pause();
        // forced transfer still works while paused
        vm.prank(agent);
        lToken.forcedTransfer(alice, bob, 100 ether);
        assertEq(lToken.balanceOf(bob), 100 ether);
        // recovery still works while paused
        vm.prank(agent);
        lToken.recoveryAddress(alice, dave);
        assertEq(lToken.balanceOf(dave), 900 ether);
        // owner mint/burn (via pair coupling) still works while paused
        pair.mintPair(carol, carol, 10 ether);
        assertEq(lToken.balanceOf(carol), 10 ether);
    }

    function test_Unpause_RestoresTransfers() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.pause();
        vm.prank(agent);
        lToken.unpause();
        vm.prank(alice);
        lToken.transfer(bob, 100 ether);
        assertEq(lToken.balanceOf(bob), 100 ether);
    }

    // =====================================================================================
    // AC-2: lost-key recovery
    // =====================================================================================

    function test_RecoveryAddress_MovesFullBalanceAndPrincipal() public {
        pair.mintPair(alice, carol, 1_000 ether);
        pair.designateLPrincipal(alice, 600 ether);

        uint256 lTotalBefore = lToken.totalSupply();
        uint256 sTotalBefore = sToken.totalSupply();

        vm.prank(agent);
        lToken.recoveryAddress(alice, dave);

        assertEq(lToken.balanceOf(alice), 0);
        assertEq(lToken.balanceOf(dave), 1_000 ether);
        assertEq(lToken.principalOf(alice), 0);
        assertEq(lToken.principalOf(dave), 600 ether);
        // coupling supply invariant intact (recovery is a transfer, not a mint/burn)
        assertEq(lToken.totalSupply(), lTotalBefore);
        assertEq(lToken.totalSupply(), sTotalBefore);
    }

    function test_RecoveryAddress_CarriesFreezeState() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        lToken.freezePartialTokens(alice, 300 ether);
        vm.prank(agent);
        lToken.setAddressFrozen(alice, true);

        vm.prank(agent);
        lToken.recoveryAddress(alice, dave);

        assertEq(lToken.frozenTokens(alice), 0);
        assertEq(lToken.frozenTokens(dave), 300 ether);
        assertTrue(lToken.isFrozen(dave));
    }

    function test_RecoveryAddress_FromRevokedHolder_Succeeds() public {
        pair.mintPair(alice, carol, 1_000 ether);
        issuer.revokeClaimBySignature(_claimFor(alice));
        assertFalse(registry.isVerified(alice));
        vm.prank(agent);
        lToken.recoveryAddress(alice, dave); // sender bypass; dave is verified
        assertEq(lToken.balanceOf(dave), 1_000 ether);
    }

    function test_RevertWhen_RecoveryAddress_NewWalletNotEligible() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        lToken.recoveryAddress(alice, stranger);
    }

    function test_RevertWhen_RecoveryAddress_NothingToRecover() public {
        vm.prank(agent);
        vm.expectRevert(bytes("RoseToken: nothing to recover"));
        lToken.recoveryAddress(alice, dave);
    }

    function test_RecoveryAddress_EmitsRecoverySuccess() public {
        pair.mintPair(alice, carol, 1_000 ether);
        vm.expectEmit(true, true, false, true, address(lToken));
        emit RecoverySuccess(alice, dave, 1_000 ether);
        vm.prank(agent);
        lToken.recoveryAddress(alice, dave);
    }

    // local mirror of IRoseToken.RecoverySuccess (same signature ⇒ same topic) for expectEmit
    event RecoverySuccess(address indexed lostWallet, address indexed newWallet, uint256 amount);

    // =====================================================================================
    // Standalone RoseToken path (non-coupled): forced transfer + recovery work + gated
    // =====================================================================================

    function test_Solo_ForcedTransfer_Succeeds_ByAgent() public {
        solo.mint(alice, 1_000 ether);
        vm.prank(agent);
        solo.forcedTransfer(alice, bob, 400 ether);
        assertEq(solo.balanceOf(bob), 400 ether);
    }

    function test_Solo_RevertWhen_ForcedTransfer_NotAgent() public {
        solo.mint(alice, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(NOT_AGENT);
        solo.forcedTransfer(alice, bob, 1 ether);
    }

    function test_Solo_Recovery_MovesFullBalance() public {
        solo.mint(alice, 1_000 ether);
        vm.prank(agent);
        solo.recoveryAddress(alice, dave);
        assertEq(solo.balanceOf(alice), 0);
        assertEq(solo.balanceOf(dave), 1_000 ether);
    }

    function test_RemoveLegAgent_RevokesRole() public {
        pair.removeLegAgent(agent);
        assertFalse(lToken.isAgent(agent));
        assertFalse(sToken.isAgent(agent));
        pair.mintPair(alice, carol, 1_000 ether);
        vm.prank(agent);
        vm.expectRevert(NOT_AGENT);
        lToken.forcedTransfer(alice, bob, 1 ether);
    }
}
