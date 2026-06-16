// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "../identity/ClaimFixtures.sol";
import {Vm} from "forge-std/Vm.sol";
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

/// @title CoupledPairHandler — bounded actor exercising the coupling surface for invariant fuzzing.
/// @notice Owns the `CoupledPair`, so the invariant runner can drive `mintPair`/`burnPair` and leg
///         transfers over two pre-verified holders. Also probes that a direct single-leg mint
///         ALWAYS reverts (tracked in `singleLegMintSucceeded`), so the invariant can assert the
///         single-leg path can never break coupling.
contract CoupledPairHandler {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    CoupledPair internal immutable pair;
    CoupledLeg internal immutable lToken;
    CoupledLeg internal immutable sToken;
    address internal immutable alice;
    address internal immutable bob;

    /// @notice Set true iff a direct single-leg mint ever succeeds (must stay false forever).
    bool public singleLegMintSucceeded;

    constructor(CoupledPair pair_, address alice_, address bob_) {
        pair = pair_;
        lToken = CoupledLeg(address(pair_.lToken()));
        sToken = CoupledLeg(address(pair_.sToken()));
        alice = alice_;
        bob = bob_;
    }

    function mintPair(uint256 amount) external {
        amount = _bound(amount, 0, 1_000_000 ether);
        pair.mintPair(alice, bob, amount);
    }

    function burnPair(uint256 amount) external {
        uint256 cap = _min(lToken.balanceOf(alice), sToken.balanceOf(bob));
        amount = _bound(amount, 0, cap);
        pair.burnPair(alice, bob, amount);
    }

    function transferL(uint256 amount) external {
        amount = _bound(amount, 0, lToken.balanceOf(alice));
        vm.prank(alice);
        lToken.transfer(bob, amount); // alice & bob both verified ⇒ eligibility passes
    }

    function transferS(uint256 amount) external {
        amount = _bound(amount, 0, sToken.balanceOf(bob));
        vm.prank(bob);
        sToken.transfer(alice, amount);
    }

    /// @dev A direct single-leg mint must ALWAYS revert (leg owner is the pair, and the coupling
    ///      guard requires pairingInProgress). If it ever succeeded, latch the failure flag.
    function attemptSingleLegMint(uint256 amount) external {
        amount = _bound(amount, 1, 1_000 ether);
        try lToken.mint(alice, amount) {
            singleLegMintSucceeded = true;
        } catch {
            // expected: Ownable (handler is not the leg owner) or coupling guard
        }
    }

    // --- helpers ---

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

/// @title CoupledPair invariant test (Story 4.3, AC-2).
/// @notice Proves the coupling invariant `lToken.totalSupply() == sToken.totalSupply()` holds after
///         ANY reachable sequence of paired mints/burns and leg transfers — i.e. coupling cannot be
///         broken — and that a direct single-leg mint never succeeds.
contract CoupledPairInvariantTest is ClaimFixtures {
    CoupledPair internal pair;
    CoupledLeg internal lToken;
    CoupledLeg internal sToken;
    CoupledPairHandler internal handler;
    IdentityRegistry internal registry;
    ClaimTopicsRegistry internal topicsRegistry;
    TrustedIssuersRegistry internal issuersRegistry;
    ClaimIssuer internal issuer;

    address internal owner = address(this);
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

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

        // Hand pair ownership to the fuzzing handler so it can drive paired ops.
        handler = new CoupledPairHandler(pair, alice, bob);
        pair.transferOwnership(address(handler));

        targetContract(address(handler));
    }

    function _registerVerified(address wallet) internal {
        Identity id = new Identity(address(this));
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, address(issuer), sig, DATA, "");
        vm.prank(agent);
        registry.registerIdentity(wallet, IIdentity(address(id)), 250);
        assertTrue(registry.isVerified(wallet));
    }

    /// @notice The legs can never desynchronize: their total supplies are always equal.
    function invariant_LegSuppliesAlwaysEqual() public view {
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }

    /// @notice A direct single-leg mint never succeeds under any fuzzed sequence.
    function invariant_SingleLegMintNeverSucceeds() public view {
        assertFalse(handler.singleLegMintSucceeded());
    }
}
