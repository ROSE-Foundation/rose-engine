// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "../identity/ClaimFixtures.sol";
import {RoseToken} from "../../src/token/RoseToken.sol";
import {IRoseToken} from "../../src/token/interface/IRoseToken.sol";
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

/// @title RoseToken eligibility-enforcement tests (Story 4.2).
/// @notice Stands up the full Story-4.1 identity stack, registers two verified holder wallets
///         (`alice`, `bob`), and proves the token's `_update` chokepoint enforces
///         `isVerified` on every transfer/mint/transferFrom party: allowed paths succeed,
///         rejected paths revert (fail-closed), incl. fuzz over random unverified recipients.
contract RoseTokenTest is ClaimFixtures {
    RoseToken internal token;
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
        // --- identity stack (mirrors IdentityRegistry.t.sol#setUp) ---
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

        // --- register + verify alice and bob as holder WALLETS ---
        _registerVerified(alice);
        _registerVerified(bob);

        // --- token bound to the registry, owned by this test ---
        token = new RoseToken("Rose Token", "ROSE", IIdentityRegistry(address(registry)), owner);
    }

    /// @dev Deploy a holder identity carrying a valid KYC claim, then register `wallet` → identity
    ///      via the agent-gated allowlist so `isVerified(wallet)` is true.
    function _registerVerified(address wallet) internal returns (Identity id, bytes memory sig) {
        id = new Identity(address(this));
        sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, address(issuer), sig, DATA, "");
        vm.prank(agent);
        registry.registerIdentity(wallet, IIdentity(address(id)), 250);
        assertTrue(registry.isVerified(wallet));
    }

    // --- mint (AC-1 rejected, AC-2 allowed) ---------------------------------

    function test_Mint_Succeeds_ToVerifiedRecipient() public {
        token.mint(alice, 1_000 ether);
        assertEq(token.balanceOf(alice), 1_000 ether);
        assertEq(token.totalSupply(), 1_000 ether);
    }

    function test_Mint_RevertWhen_RecipientNotVerified() public {
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        token.mint(stranger, 1_000 ether);
    }

    function test_Mint_RevertWhen_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(alice, 1_000 ether);
    }

    // --- transfer (AC-1 rejected, AC-2 allowed) -----------------------------

    function test_Transfer_Succeeds_BetweenVerified() public {
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        token.transfer(bob, 400 ether);
        assertEq(token.balanceOf(alice), 600 ether);
        assertEq(token.balanceOf(bob), 400 ether);
    }

    function test_Transfer_RevertWhen_RecipientNotVerified() public {
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        token.transfer(stranger, 100 ether);
    }

    function test_Transfer_RevertWhen_SenderNoLongerVerified() public {
        token.mint(alice, 1_000 ether);
        // Revoke alice's KYC claim AFTER she acquired tokens → eligibility re-checked live.
        (, bytes memory aliceSig) = _claimFor(alice);
        issuer.revokeClaimBySignature(aliceSig);
        assertFalse(registry.isVerified(alice));

        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: sender not eligible"));
        token.transfer(bob, 100 ether);
    }

    // --- transferFrom (AC-1 rejected, AC-2 allowed) -------------------------

    function test_TransferFrom_Succeeds_BetweenVerified() public {
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        token.approve(stranger, 500 ether); // approval is not a balance movement; spender need not be verified
        vm.prank(stranger);
        token.transferFrom(alice, bob, 500 ether);
        assertEq(token.balanceOf(alice), 500 ether);
        assertEq(token.balanceOf(bob), 500 ether);
    }

    function test_TransferFrom_RevertWhen_RecipientNotVerified() public {
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        token.approve(stranger, 500 ether);
        vm.prank(stranger);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        token.transferFrom(alice, stranger, 500 ether);
    }

    // --- burn ---------------------------------------------------------------

    function test_Burn_Succeeds_ByOwner() public {
        token.mint(alice, 1_000 ether);
        token.burn(alice, 400 ether);
        assertEq(token.balanceOf(alice), 600 ether);
        assertEq(token.totalSupply(), 600 ether);
    }

    function test_Burn_RevertWhen_NotOwner() public {
        token.mint(alice, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.burn(alice, 100 ether);
    }

    // Regression (review): a revoked/de-listed holder's balance must remain BURNABLE by the
    // issuer (owner) even though the holder can no longer TRANSFER it. Burn (to == 0) is exempt
    // from the sender-eligibility check so non-compliant balances are not stranded (canonical
    // ERC-3643). Pairs with test_Transfer_RevertWhen_SenderNoLongerVerified (transfer still blocked).
    function test_Burn_Succeeds_AfterHolderRevoked() public {
        token.mint(alice, 1_000 ether);
        (, bytes memory aliceSig) = _claimFor(alice);
        issuer.revokeClaimBySignature(aliceSig);
        assertFalse(registry.isVerified(alice));

        // Holder can no longer move tokens...
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: sender not eligible"));
        token.transfer(bob, 1 ether);

        // ...but the issuer can still burn them (supply reduction is not stranded).
        token.burn(alice, 400 ether);
        assertEq(token.balanceOf(alice), 600 ether);
        assertEq(token.totalSupply(), 600 ether);
    }

    // --- registry binding ---------------------------------------------------

    function test_SetIdentityRegistry_OnlyOwner() public {
        IdentityRegistry fresh = new IdentityRegistry(owner, topicsRegistry, issuersRegistry);
        token.setIdentityRegistry(IIdentityRegistry(address(fresh)));
        assertEq(address(token.identityRegistry()), address(fresh));
    }

    function test_SetIdentityRegistry_RevertWhen_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.setIdentityRegistry(IIdentityRegistry(address(registry)));
    }

    function test_SetIdentityRegistry_RevertWhen_Zero() public {
        vm.expectRevert(bytes("RoseToken: zero registry"));
        token.setIdentityRegistry(IIdentityRegistry(address(0)));
    }

    function test_Constructor_RevertWhen_ZeroRegistry() public {
        vm.expectRevert(bytes("RoseToken: zero registry"));
        new RoseToken("Rose Token", "ROSE", IIdentityRegistry(address(0)), owner);
    }

    // --- fuzz (AC-2 mandatory) ----------------------------------------------

    /// @dev Any random recipient that is not a registered/verified wallet is rejected (fail-closed).
    function testFuzz_Transfer_RevertsForUnverifiedRecipient(address to) public {
        vm.assume(to != alice && to != bob && to != address(0));
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        token.transfer(to, 1 ether);
    }

    /// @dev A transfer between two verified holders succeeds for any amount within balance.
    function testFuzz_Transfer_Succeeds_AmountWithinBalance(uint256 amount) public {
        uint256 supply = 1_000_000 ether;
        amount = bound(amount, 0, supply);
        token.mint(alice, supply);
        vm.prank(alice);
        token.transfer(bob, amount);
        assertEq(token.balanceOf(bob), amount);
        assertEq(token.balanceOf(alice), supply - amount);
    }

    /// @dev Helper: recompute the KYC claim signature for a registered wallet's bound identity,
    ///      so a test can revoke it via the issuer.
    function _claimFor(address wallet) internal view returns (address idAddr, bytes memory sig) {
        idAddr = address(registry.identity(wallet));
        sig = _signClaim(CLAIM_SIGNER_PK, idAddr, KYC, DATA);
    }
}
