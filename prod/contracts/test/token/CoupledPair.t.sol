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
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @title CoupledPair coupling tests (Story 4.3).
/// @notice Stands up the full Story-4.1 identity stack + two verified holders, deploys a
///         `CoupledPair`, and proves: paired mint/burn move BOTH legs atomically at equal notional
///         (both-or-neither), a single-leg mint/burn is impossible (Ownable + coupling guard), and
///         leg transfers preserve the coupling invariant.
contract CoupledPairTest is ClaimFixtures {
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
        // --- identity stack (mirrors RoseToken.t.sol#setUp) ---
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

        // --- coupled pair (deploys both legs, owned by + couplered to itself), owned by this test ---
        pair = new CoupledPair(IIdentityRegistry(address(registry)), "Rose L", "ROSE-L", "Rose S", "ROSE-S", owner);
        lToken = CoupledLeg(address(pair.lToken()));
        sToken = CoupledLeg(address(pair.sToken()));
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

    // --- AC-1: paired mint/burn, both legs, equal notional ------------------

    function test_MintPair_MintsBothLegsEqualNotional() public {
        pair.mintPair(alice, bob, 1_000 ether);
        assertEq(lToken.balanceOf(alice), 1_000 ether);
        assertEq(sToken.balanceOf(bob), 1_000 ether);
        assertEq(lToken.totalSupply(), 1_000 ether);
        assertEq(sToken.totalSupply(), 1_000 ether);
    }

    function test_MintPair_ToSameHolder() public {
        pair.mintPair(alice, alice, 500 ether);
        assertEq(lToken.balanceOf(alice), 500 ether);
        assertEq(sToken.balanceOf(alice), 500 ether);
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    function test_BurnPair_BurnsBothLegs() public {
        pair.mintPair(alice, bob, 1_000 ether);
        pair.burnPair(alice, bob, 400 ether);
        assertEq(lToken.balanceOf(alice), 600 ether);
        assertEq(sToken.balanceOf(bob), 600 ether);
        assertEq(lToken.totalSupply(), 600 ether);
        assertEq(sToken.totalSupply(), 600 ether);
    }

    function test_MintPair_RevertWhen_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pair.mintPair(alice, bob, 1_000 ether);
    }

    function test_BurnPair_RevertWhen_NotOwner() public {
        pair.mintPair(alice, bob, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pair.burnPair(alice, bob, 100 ether);
    }

    // --- AC-1: atomicity — a failing leg rolls BOTH back (both-or-neither) ---

    function test_MintPair_RevertWhen_sLegRecipientNotEligible() public {
        // S-leg recipient is unverified: the S mint reverts, which reverts the WHOLE tx,
        // so the already-attempted L mint is rolled back too (neither leg minted).
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        pair.mintPair(alice, stranger, 1_000 ether);
        assertEq(lToken.totalSupply(), 0);
        assertEq(sToken.totalSupply(), 0);
    }

    function test_MintPair_RevertWhen_lLegRecipientNotEligible() public {
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        pair.mintPair(stranger, bob, 1_000 ether);
        assertEq(lToken.totalSupply(), 0);
        assertEq(sToken.totalSupply(), 0);
    }

    // Regression (review/edge-case): a zero-address leg target must NOT silently become a no-op
    // (which would desync the legs and break coupling). OZ `_mint`/`_burn` revert on the zero
    // account BEFORE `_update`, so the whole paired op reverts atomically — legs stay equal.
    function test_MintPair_RevertWhen_lToIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        pair.mintPair(address(0), bob, 1_000 ether);
        assertEq(lToken.totalSupply(), 0);
        assertEq(sToken.totalSupply(), 0);
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    function test_BurnPair_RevertWhen_sFromIsZero() public {
        pair.mintPair(alice, bob, 1_000 ether);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidSender.selector, address(0)));
        pair.burnPair(alice, address(0), 100 ether);
        assertEq(lToken.totalSupply(), 1_000 ether);
        assertEq(sToken.totalSupply(), 1_000 ether);
    }

    // Regression (review/edge-case): burnPair is atomic even when one holder lacks the balance.
    // After moving part of alice's L away, a burnPair sized to her ORIGINAL L reverts on the L
    // leg and rolls the (untouched) S leg back too — legs stay equal (both-or-neither).
    function test_BurnPair_RevertWhen_AsymmetricBalance() public {
        pair.mintPair(alice, bob, 1_000 ether);
        vm.prank(alice);
        lToken.transfer(bob, 600 ether); // alice now holds 400 L, bob holds 1_000 S
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 400 ether, 500 ether)
        );
        pair.burnPair(alice, bob, 500 ether);
        // both-or-neither: no supply changed.
        assertEq(lToken.totalSupply(), 1_000 ether);
        assertEq(sToken.totalSupply(), 1_000 ether);
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    // --- AC-2: single-leg mint/burn impossible ------------------------------

    function test_LegMint_RevertWhen_CalledDirectlyByEOA() public {
        // The leg's inherited owner-gated mint is owned by the coupler (pair), not any EOA.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        lToken.mint(alice, 1_000 ether);
    }

    function test_LegBurn_RevertWhen_CalledDirectlyByEOA() public {
        pair.mintPair(alice, bob, 1_000 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        lToken.burn(alice, 100 ether);
    }

    function test_LegMint_RevertWhen_OwnerNotPairing() public {
        // Prove the `_update` coupling guard independently of Ownable: a standalone leg owned by
        // this test (the caller IS the owner) whose coupler is a real CoupledPair with _pairing
        // == false. A direct single-leg mint still reverts on the coupling guard.
        CoupledLeg standalone = new CoupledLeg("Solo L", "SOLO-L", IIdentityRegistry(address(registry)), address(pair));
        vm.prank(address(pair)); // caller is the owner (coupler), but pair is NOT mid-operation
        vm.expectRevert(bytes("CoupledLeg: single-leg mint/burn"));
        standalone.mint(alice, 1_000 ether);
    }

    function test_LegBurn_RevertWhen_OwnerNotPairing() public {
        CoupledLeg standalone = new CoupledLeg("Solo L", "SOLO-L", IIdentityRegistry(address(registry)), address(pair));
        // Seed a balance via a genuine paired-context mint is not possible on a standalone leg;
        // instead prove the burn branch of the guard: any direct burn (to == 0) while not pairing
        // reverts on the coupling guard before touching balances.
        vm.prank(address(pair));
        vm.expectRevert(bytes("CoupledLeg: single-leg mint/burn"));
        standalone.burn(alice, 1 ether);
    }

    function test_Constructor_RevertWhen_ZeroRegistry() public {
        vm.expectRevert(bytes("CoupledPair: zero registry"));
        new CoupledPair(IIdentityRegistry(address(0)), "L", "L", "S", "S", owner);
    }

    // --- coupling preserved by transfer (legs separately held, D1) ----------

    function test_LegTransfer_Succeeds_BetweenVerified_PreservesCoupling() public {
        pair.mintPair(alice, alice, 1_000 ether);
        vm.prank(alice);
        lToken.transfer(bob, 250 ether);
        // balances moved...
        assertEq(lToken.balanceOf(alice), 750 ether);
        assertEq(lToken.balanceOf(bob), 250 ether);
        // ...but supplies (and thus coupling) unchanged.
        assertEq(lToken.totalSupply(), 1_000 ether);
        assertEq(sToken.totalSupply(), 1_000 ether);
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    function test_LegTransfer_RevertWhen_RecipientNotVerified() public {
        // 4.2 eligibility still applies to leg transfers (inherited).
        pair.mintPair(alice, alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("RoseToken: recipient not eligible"));
        lToken.transfer(stranger, 1 ether);
    }

    // --- wiring sanity ------------------------------------------------------

    function test_Pair_DeploysDistinctLegsOwnedByPair() public view {
        assertTrue(address(lToken) != address(sToken));
        assertEq(lToken.owner(), address(pair));
        assertEq(sToken.owner(), address(pair));
        assertEq(lToken.coupler(), address(pair));
        assertEq(sToken.coupler(), address(pair));
        assertFalse(pair.pairingInProgress());
    }

    // --- fuzz: paired mint keeps legs equal for any amount/recipients -------

    function testFuzz_MintPair_KeepsLegsEqual(uint256 amount) public {
        amount = bound(amount, 0, 1_000_000_000 ether);
        pair.mintPair(alice, bob, amount);
        assertEq(lToken.totalSupply(), amount);
        assertEq(sToken.totalSupply(), amount);
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }
}
