// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "../identity/ClaimFixtures.sol";
import {CoupledPair} from "../../src/token/CoupledPair.sol";
import {CoupledLeg} from "../../src/token/CoupledLeg.sol";
import {IdentityRegistry} from "../../src/identity/IdentityRegistry.sol";
import {ClaimTopicsRegistry} from "../../src/identity/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "../../src/identity/TrustedIssuersRegistry.sol";
import {ClaimIssuer} from "../../src/identity/ClaimIssuer.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IIdentity} from "../../src/identity/interface/IIdentity.sol";
import {IIdentityRegistry} from "../../src/identity/interface/IIdentityRegistry.sol";
import {IClaimIssuer} from "../../src/identity/interface/IClaimIssuer.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CoupledLeg Model-A principal/yield tests (Story 4.4).
/// @notice Proves the on-chain Model-A bright line on a `CoupledLeg`: a transfer that would move
///         segregated principal out of a position is rejected, while the yield surplus moves
///         freely; principal is reachable only via the owner-gated pair forwarders; an authorized
///         burn (redemption) retires principal (clamped); and the 4.2 eligibility + 4.3 coupling
///         layers still hold.
contract CoupledLegPrincipalTest is ClaimFixtures {
    CoupledPair internal pair;
    CoupledLeg internal lToken;
    CoupledLeg internal sToken;
    IdentityRegistry internal registry;
    ClaimTopicsRegistry internal topicsRegistry;
    TrustedIssuersRegistry internal issuersRegistry;
    ClaimIssuer internal issuer;

    address internal owner = address(this);
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant KYC = ClaimTopics.ONCHAINID_KYC;
    bytes internal constant DATA = bytes("kyc:passed");

    function setUp() public {
        topicsRegistry = new ClaimTopicsRegistry(owner);
        issuersRegistry = new TrustedIssuersRegistry(owner);
        registry = new IdentityRegistry(owner, topicsRegistry, issuersRegistry);
        registry.addAgent(agent);

        issuer = new ClaimIssuer(address(this));
        issuer.addKey(_keyHash(_claimSignerAddr()), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());

        topicsRegistry.addClaimTopic(KYC);
        uint256[] memory topics = new uint256[](1);
        topics[0] = KYC;
        issuersRegistry.addTrustedIssuer(IClaimIssuer(address(issuer)), topics);

        _registerVerified(alice);
        _registerVerified(bob);

        pair = new CoupledPair(IIdentityRegistry(address(registry)), "Rose L", "ROSE-L", "Rose S", "ROSE-S", owner);
        lToken = CoupledLeg(address(pair.lToken()));
        sToken = CoupledLeg(address(pair.sToken()));
    }

    function _registerVerified(address wallet) internal {
        Identity id = new Identity(address(this));
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, address(issuer), sig, DATA, "");
        vm.prank(agent);
        registry.registerIdentity(wallet, IIdentity(address(id)), 250);
        assertTrue(registry.isVerified(wallet));
    }

    // --- AC-1: principal egress rejected ------------------------------------

    function test_Transfer_RevertWhen_WouldMovePrincipal() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 700 ether);
        // Transferring 400 would leave 600 < 700 principal → reject.
        vm.prank(alice);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        lToken.transfer(bob, 400 ether);
        // nothing moved
        assertEq(lToken.balanceOf(alice), 1_000 ether);
        assertEq(lToken.balanceOf(bob), 0);
        assertEq(lToken.principalOf(alice), 700 ether);
    }

    // --- AC-2: yield surplus moves freely -----------------------------------

    function test_Transfer_YieldSurplus_Succeeds() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 700 ether);
        // 300 yield surplus is movable.
        vm.prank(alice);
        lToken.transfer(bob, 300 ether);
        assertEq(lToken.balanceOf(alice), 700 ether);
        assertEq(lToken.principalOf(alice), 700 ether);
        assertEq(lToken.balanceOf(bob), 300 ether);
        // recipient receives MOVABLE tokens (no principal carried over)
        assertEq(lToken.principalOf(bob), 0);
    }

    function test_Transfer_ExactYield_Succeeds_OneMoreReverts() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 600 ether);
        vm.prank(alice);
        lToken.transfer(bob, 400 ether); // exactly the surplus
        assertEq(lToken.balanceOf(alice), 600 ether);
        // now balance == principal, zero yield: one more wei out reverts
        vm.prank(alice);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        lToken.transfer(bob, 1);
    }

    function test_Transfer_RevertWhen_FullyPrincipal() public {
        pair.mintPair(alice, bob, 500 ether);
        pair.designateLPrincipal(alice, 500 ether); // entire balance is principal
        vm.prank(alice);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        lToken.transfer(bob, 1 ether);
        // a zero-amount transfer is a harmless no-op (balance unchanged >= principal)
        vm.prank(alice);
        lToken.transfer(bob, 0);
        assertEq(lToken.balanceOf(alice), 500 ether);
    }

    // --- designation guards / sealed legs -----------------------------------

    function test_DesignatePrincipal_RevertWhen_ExceedsBalance() public {
        pair.mintPair(alice, bob, 1_000 ether);
        vm.expectRevert(bytes("CoupledLeg: principal exceeds balance"));
        pair.designateLPrincipal(alice, 1_000 ether + 1);
    }

    function test_DesignatePrincipal_Accumulates() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 300 ether);
        pair.designateLPrincipal(alice, 400 ether);
        assertEq(lToken.principalOf(alice), 700 ether);
        // designating more than the remaining free balance reverts
        vm.expectRevert(bytes("CoupledLeg: principal exceeds balance"));
        pair.designateLPrincipal(alice, 301 ether);
    }

    function test_DesignatePrincipal_RevertWhen_NotOwner() public {
        pair.mintPair(alice, bob, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pair.designateLPrincipal(alice, 100 ether);
    }

    function test_DesignateLeg_RevertWhen_CalledDirectlyByEOA() public {
        pair.mintPair(alice, bob, 1_000 ether);
        // the leg's designatePrincipal is owner-gated; owner is the pair, not any EOA.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        lToken.designatePrincipal(alice, 100 ether);
    }

    function test_DesignateSPrincipal_GatesSLeg() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateSPrincipal(bob, 800 ether);
        assertEq(sToken.principalOf(bob), 800 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        sToken.transfer(alice, 300 ether); // would leave 700 < 800
        vm.prank(bob);
        sToken.transfer(alice, 200 ether); // exactly the 200 surplus
        assertEq(sToken.balanceOf(bob), 800 ether);
    }

    // --- burn retires principal (redemption), clamped -----------------------

    function test_BurnPair_ReducesPrincipal_Clamped() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 1_000 ether); // fully principal
        // authorized paired burn (redemption) is NOT blocked by the bright line
        pair.burnPair(alice, bob, 400 ether);
        assertEq(lToken.balanceOf(alice), 600 ether);
        assertEq(lToken.principalOf(alice), 600 ether); // clamped down to balance
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    function test_BurnPair_FullBurn_ZeroesPrincipal() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 1_000 ether);
        pair.burnPair(alice, bob, 1_000 ether);
        assertEq(lToken.balanceOf(alice), 0);
        assertEq(lToken.principalOf(alice), 0);
    }

    function test_BurnPair_PartialBurn_PrincipalStillCovered_Unchanged() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 400 ether); // 600 yield surplus
        pair.burnPair(alice, bob, 300 ether); // burns into the surplus only
        assertEq(lToken.balanceOf(alice), 700 ether);
        assertEq(lToken.principalOf(alice), 400 ether); // still fully covered, not clamped
    }

    // --- mint lands as movable yield; recipient unaffected ------------------

    function test_Mint_LandsAsMovableYield() public {
        pair.mintPair(alice, bob, 1_000 ether);
        assertEq(lToken.principalOf(alice), 0);
        vm.prank(alice);
        lToken.transfer(bob, 1_000 ether); // entire balance is movable
        assertEq(lToken.balanceOf(alice), 0);
        assertEq(lToken.balanceOf(bob), 1_000 ether);
    }

    // A self-transfer (from == to) leaves balance unchanged, so the bright line passes even when
    // the holder is 100% principal — no principal leaves the position.
    function test_SelfTransfer_FullyPrincipal_NoPrincipalLeaves() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 1_000 ether); // fully principal, zero yield
        vm.prank(alice);
        lToken.transfer(alice, 1_000 ether); // self-transfer: balance unchanged
        assertEq(lToken.balanceOf(alice), 1_000 ether);
        assertEq(lToken.principalOf(alice), 1_000 ether);
    }

    // A recipient who is ALREADY 100% principal and then receives more tokens: the inbound transfer
    // lifts their movable surplus above the locked principal; only that NEW surplus is movable, the
    // pre-existing principal stays locked.
    function test_Recipient_WithFullPrincipal_ReceivesMore_OnlyNewSurplusMovable() public {
        // bob ends up holding L principal: mint L to bob, lock it all.
        pair.mintPair(bob, alice, 500 ether); // bob: 500 L, alice: 500 S
        pair.designateLPrincipal(bob, 500 ether); // bob's 500 L fully principal
        // alice acquires L (mint a fresh pair to alice) and sends bob 200 L of movable yield.
        pair.mintPair(alice, alice, 200 ether); // alice: +200 L
        vm.prank(alice);
        lToken.transfer(bob, 200 ether); // bob now 700 L, principal still 500 → 200 surplus
        assertEq(lToken.balanceOf(bob), 700 ether);
        assertEq(lToken.principalOf(bob), 500 ether);
        // bob can move exactly the new 200 surplus, not a wei more
        vm.prank(bob);
        lToken.transfer(alice, 200 ether);
        assertEq(lToken.balanceOf(bob), 500 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        lToken.transfer(alice, 1);
    }

    // --- composition with 4.2 eligibility & 4.3 coupling --------------------

    function test_PrincipalLockedTransfer_StillEligibilityGated() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 100 ether); // surplus 900, so amount alone would be allowed
        // transfer to an UNVERIFIED recipient reverts on 4.2 eligibility, not the bright line
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        lToken.transfer(stranger, 50 ether);
    }

    function test_DesignatePrincipal_DoesNotAffectCoupling() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 500 ether);
        pair.designateSPrincipal(bob, 250 ether);
        // designation never changes supplies → coupling invariant intact
        assertEq(lToken.totalSupply(), 1_000 ether);
        assertEq(sToken.totalSupply(), 1_000 ether);
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    function test_YieldFromExtraMint_IsMovable() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.designateLPrincipal(alice, 1_000 ether); // all initial collateral is principal
        // yield accrues: a further paired mint to alice (not designated) is movable surplus
        pair.mintPair(alice, bob, 200 ether);
        assertEq(lToken.balanceOf(alice), 1_200 ether);
        assertEq(lToken.principalOf(alice), 1_000 ether);
        vm.prank(alice);
        lToken.transfer(bob, 200 ether); // exactly the yield surplus
        assertEq(lToken.balanceOf(alice), 1_000 ether);
        assertEq(lToken.principalOf(alice), 1_000 ether);
    }

    // --- fuzz: yield is transferable up to surplus, principal is not --------

    function testFuzz_YieldTransferableUpToSurplus(uint256 mintAmt, uint256 principalAmt, uint256 xfer) public {
        mintAmt = bound(mintAmt, 1, 1_000_000_000 ether);
        principalAmt = bound(principalAmt, 0, mintAmt);
        uint256 surplus = mintAmt - principalAmt;
        xfer = bound(xfer, 0, surplus);

        pair.mintPair(alice, bob, mintAmt);
        pair.designateLPrincipal(alice, principalAmt);

        vm.prank(alice);
        lToken.transfer(bob, xfer); // within surplus → always succeeds
        assertEq(lToken.balanceOf(alice), mintAmt - xfer);
        assertGe(lToken.balanceOf(alice), lToken.principalOf(alice));
    }

    function testFuzz_PrincipalEgressAlwaysReverts(uint256 mintAmt, uint256 principalAmt, uint256 over) public {
        mintAmt = bound(mintAmt, 1, 1_000_000_000 ether);
        principalAmt = bound(principalAmt, 1, mintAmt); // some principal exists
        uint256 surplus = mintAmt - principalAmt;
        // attempt to move MORE than the surplus (dips into principal), but <= balance
        over = bound(over, surplus + 1, mintAmt);

        pair.mintPair(alice, bob, mintAmt);
        pair.designateLPrincipal(alice, principalAmt);

        vm.prank(alice);
        vm.expectRevert(bytes("CoupledLeg: principal cannot leave position"));
        lToken.transfer(bob, over);
        assertEq(lToken.balanceOf(alice), mintAmt); // unchanged
    }
}
