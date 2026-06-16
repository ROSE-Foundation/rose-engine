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

/// @title PrincipalHandler — bounded actor exercising the Model-A surface for invariant fuzzing.
/// @notice Owns the `CoupledPair`, so the invariant runner can drive `mintPair`/`burnPair`,
///         principal designation, and leg transfers over two pre-verified holders (alice holds L,
///         bob holds S). Designation is bounded to the current free surplus so it never reverts
///         spuriously; transfers are bounded by balance (the fuzzer WILL attempt principal-violating
///         amounts — a revert just rolls that call back). `attemptPrincipalEgress` probes that a
///         transfer dipping into principal can NEVER succeed (latches a flag iff it ever does).
contract PrincipalHandler {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    CoupledPair internal immutable pair;
    CoupledLeg internal immutable lToken;
    CoupledLeg internal immutable sToken;
    address internal immutable alice;
    address internal immutable bob;

    /// @notice Set true iff a transfer that dips into principal ever succeeds (must stay false).
    bool public principalEgressSucceeded;

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

    function designateLPrincipal(uint256 amount) external {
        uint256 free = lToken.balanceOf(alice) - lToken.principalOf(alice);
        amount = _bound(amount, 0, free);
        pair.designateLPrincipal(alice, amount);
    }

    function designateSPrincipal(uint256 amount) external {
        uint256 free = sToken.balanceOf(bob) - sToken.principalOf(bob);
        amount = _bound(amount, 0, free);
        pair.designateSPrincipal(bob, amount);
    }

    /// @dev Drive the multi-holder-per-leg case: bob can hold L (from `transferL`) and have L
    ///      principal locked — exercises `lToken.principalOf(bob)` (otherwise trivially 0).
    function designateLPrincipalBob(uint256 amount) external {
        uint256 free = lToken.balanceOf(bob) - lToken.principalOf(bob);
        amount = _bound(amount, 0, free);
        pair.designateLPrincipal(bob, amount);
    }

    /// @dev Symmetric: alice can hold S (from `transferS`) and have S principal locked —
    ///      exercises `sToken.principalOf(alice)` (otherwise trivially 0).
    function designateSPrincipalAlice(uint256 amount) external {
        uint256 free = sToken.balanceOf(alice) - sToken.principalOf(alice);
        amount = _bound(amount, 0, free);
        pair.designateSPrincipal(alice, amount);
    }

    function transferL(uint256 amount) external {
        amount = _bound(amount, 0, lToken.balanceOf(alice));
        vm.prank(alice);
        // alice & bob both verified ⇒ eligibility passes; the bright line may revert (rolls back).
        try lToken.transfer(bob, amount) {} catch {}
    }

    function transferS(uint256 amount) external {
        amount = _bound(amount, 0, sToken.balanceOf(bob));
        vm.prank(bob);
        try sToken.transfer(alice, amount) {} catch {}
    }

    /// @dev Deliberately attempt to move MORE than the yield surplus (dip into principal). It must
    ///      ALWAYS revert; if it ever lands, latch the failure flag.
    function attemptPrincipalEgress(uint256 amount) external {
        uint256 bal = lToken.balanceOf(alice);
        uint256 principal = lToken.principalOf(alice);
        uint256 surplus = bal - principal;
        if (bal == 0 || surplus >= bal) return; // nothing to violate (no principal locked)
        amount = _bound(amount, surplus + 1, bal); // strictly more than surplus, within balance
        vm.prank(alice);
        try lToken.transfer(bob, amount) {
            principalEgressSucceeded = true;
        } catch {
            // expected: "CoupledLeg: principal cannot leave position"
        }
    }

    /// @dev S-leg twin of `attemptPrincipalEgress`: bob holds S; a transfer dipping into bob's S
    ///      principal must ALWAYS revert. Latches the SAME flag so the invariant covers BOTH legs.
    function attemptPrincipalEgressS(uint256 amount) external {
        uint256 bal = sToken.balanceOf(bob);
        uint256 principal = sToken.principalOf(bob);
        uint256 surplus = bal - principal;
        if (bal == 0 || surplus >= bal) return; // nothing to violate (no principal locked)
        amount = _bound(amount, surplus + 1, bal); // strictly more than surplus, within balance
        vm.prank(bob);
        try sToken.transfer(alice, amount) {
            principalEgressSucceeded = true;
        } catch {
            // expected: "CoupledLeg: principal cannot leave position"
        }
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

/// @title CoupledLeg Model-A invariant test (Story 4.4, AC-2).
/// @notice Proves principal can NEVER leave a position: after ANY reachable sequence of paired
///         mints/burns, principal designations, and leg transfers, `principalOf <= balanceOf` for
///         every actor on every leg, and a transfer dipping into principal never succeeds.
contract CoupledLegPrincipalInvariantTest is ClaimFixtures {
    CoupledPair internal pair;
    CoupledLeg internal lToken;
    CoupledLeg internal sToken;
    PrincipalHandler internal handler;
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

        handler = new PrincipalHandler(pair, alice, bob);
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

    /// @notice Principal can never exceed balance on either leg for either actor — the structural
    ///         proof that principal never left a position (transfers reduce balance, and the bright
    ///         line forbids dropping below principal).
    function invariant_PrincipalNeverExceedsBalance() public view {
        assertLe(lToken.principalOf(alice), lToken.balanceOf(alice));
        assertLe(lToken.principalOf(bob), lToken.balanceOf(bob));
        assertLe(sToken.principalOf(alice), sToken.balanceOf(alice));
        assertLe(sToken.principalOf(bob), sToken.balanceOf(bob));
    }

    /// @notice A transfer that would dip into principal never succeeds under any fuzzed sequence.
    function invariant_PrincipalEgressNeverSucceeds() public view {
        assertFalse(handler.principalEgressSucceeded());
    }

    /// @notice Coupling (4.3) is preserved alongside the Model-A layer.
    function invariant_LegSuppliesAlwaysEqual() public view {
        assertEq(lToken.totalSupply(), sToken.totalSupply());
    }
}
