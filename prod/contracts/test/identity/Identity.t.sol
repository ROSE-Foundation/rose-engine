// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IERC734} from "../../src/identity/interface/IERC734.sol";

/// @title Identity unit tests — ERC-734 keys + ERC-735 claims (Story 4.1, AC-2).
contract IdentityTest is Test {
    Identity internal identity;
    address internal owner = address(this); // bootstrapped MANAGEMENT key
    address internal stranger = makeAddr("stranger");
    address internal claimSigner = makeAddr("claimSigner");
    address internal issuer = makeAddr("issuer");

    uint256 internal constant TOPIC = 42;

    // Cached so they are NOT evaluated as external getter calls inside a pranked /
    // expectRevert-guarded statement (which would consume the cheatcode).
    uint256 internal MGMT;
    uint256 internal CLAIM;
    uint256 internal ECDSA;

    function setUp() public {
        identity = new Identity(owner);
        MGMT = identity.MANAGEMENT_KEY();
        CLAIM = identity.CLAIM_SIGNER_KEY();
        ECDSA = identity.ECDSA_TYPE();
    }

    function _keyHash(address a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }

    // --- keys ---------------------------------------------------------------

    function test_Constructor_BootstrapsManagementKey() public view {
        assertTrue(identity.keyHasPurpose(_keyHash(owner), MGMT));
        bytes32[] memory mgmt = identity.getKeysByPurpose(MGMT);
        assertEq(mgmt.length, 1);
        assertEq(mgmt[0], _keyHash(owner));
    }

    function test_Constructor_RevertWhen_ZeroManagementKey() public {
        vm.expectRevert(bytes("Identity: zero management key"));
        new Identity(address(0));
    }

    function test_AddKey_ClaimSigner() public {
        bytes32 k = _keyHash(claimSigner);
        identity.addKey(k, CLAIM, ECDSA);

        assertTrue(identity.keyHasPurpose(k, CLAIM));
        // A claim key is NOT a management key.
        assertFalse(identity.keyHasPurpose(k, MGMT));

        (uint256[] memory purposes, uint256 keyType, bytes32 keyValue) = identity.getKey(k);
        assertEq(purposes.length, 1);
        assertEq(purposes[0], CLAIM);
        assertEq(keyType, ECDSA);
        assertEq(keyValue, k);
    }

    function test_KeyHasPurpose_ManagementSatisfiesAnyPurpose() public view {
        // The bootstrapped management key implicitly satisfies a CLAIM purpose check.
        assertTrue(identity.keyHasPurpose(_keyHash(owner), CLAIM));
    }

    function test_KeyHasPurpose_UnknownKeyIsFalse() public view {
        assertFalse(identity.keyHasPurpose(_keyHash(stranger), MGMT));
    }

    function test_AddKey_RevertWhen_NotManager() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Identity: sender lacks management key"));
        identity.addKey(_keyHash(claimSigner), CLAIM, ECDSA);
    }

    function test_AddKey_RevertWhen_DuplicatePurpose() public {
        bytes32 k = _keyHash(claimSigner);
        identity.addKey(k, CLAIM, ECDSA);
        vm.expectRevert(bytes("Identity: key already has purpose"));
        identity.addKey(k, CLAIM, ECDSA);
    }

    function test_RemoveKey() public {
        bytes32 k = _keyHash(claimSigner);
        identity.addKey(k, CLAIM, ECDSA);
        identity.removeKey(k, CLAIM);

        assertFalse(identity.keyHasPurpose(k, CLAIM));
        (,, bytes32 keyValue) = identity.getKey(k);
        assertEq(keyValue, bytes32(0));
        bytes32[] memory byPurpose = identity.getKeysByPurpose(CLAIM);
        assertEq(byPurpose.length, 0);
    }

    function test_RemoveKey_RevertWhen_NotRegistered() public {
        vm.expectRevert(bytes("Identity: key not registered"));
        identity.removeKey(_keyHash(claimSigner), CLAIM);
    }

    // Regression (review H2): removing the sole MANAGEMENT key would brick the identity.
    function test_RemoveKey_RevertWhen_LastManagementKey() public {
        vm.expectRevert(bytes("Identity: cannot remove last management key"));
        identity.removeKey(_keyHash(owner), MGMT);
    }

    function test_RemoveKey_NonLastManagementKey_Succeeds() public {
        bytes32 k2 = _keyHash(claimSigner);
        identity.addKey(k2, MGMT, ECDSA); // two management keys now
        identity.removeKey(_keyHash(owner), MGMT); // dropping one leaves one — allowed

        assertFalse(identity.keyHasPurpose(_keyHash(owner), MGMT));
        assertTrue(identity.keyHasPurpose(k2, MGMT));
    }

    // Regression (review Low): event keyType for an existing key must mirror STORED type.
    function test_AddKey_ExistingKey_EmitsStoredKeyType() public {
        bytes32 k = _keyHash(claimSigner);
        identity.addKey(k, CLAIM, ECDSA); // stored keyType = ECDSA (1)

        uint256 action = identity.ACTION_KEY();
        vm.expectEmit(true, true, true, true);
        emit IERC734.KeyAdded(k, action, ECDSA); // expect STORED type, not the passed `2`
        identity.addKey(k, action, 2);

        (, uint256 storedType,) = identity.getKey(k);
        assertEq(storedType, ECDSA);
    }

    // --- claims -------------------------------------------------------------

    function test_AddClaim_ByManagementKey_AndGet() public {
        bytes memory sig = hex"deadbeef";
        bytes memory data = bytes("kyc-pass");
        bytes32 claimId = identity.addClaim(TOPIC, 1, issuer, sig, data, "ipfs://uri");

        assertEq(claimId, keccak256(abi.encode(issuer, TOPIC)));

        (
            uint256 topic,
            uint256 scheme,
            address gotIssuer,
            bytes memory gotSig,
            bytes memory gotData,
            string memory uri
        ) = identity.getClaim(claimId);
        assertEq(topic, TOPIC);
        assertEq(scheme, 1);
        assertEq(gotIssuer, issuer);
        assertEq(gotSig, sig);
        assertEq(gotData, data);
        assertEq(uri, "ipfs://uri");

        bytes32[] memory ids = identity.getClaimIdsByTopic(TOPIC);
        assertEq(ids.length, 1);
        assertEq(ids[0], claimId);
    }

    function test_AddClaim_RevertWhen_SenderLacksClaimKey() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Identity: sender lacks claim key"));
        identity.addClaim(TOPIC, 1, issuer, hex"00", bytes("d"), "");
    }

    function test_AddClaim_ReplaceSameIssuerTopic_DoesNotDuplicateIndex() public {
        identity.addClaim(TOPIC, 1, issuer, hex"01", bytes("a"), "");
        identity.addClaim(TOPIC, 1, issuer, hex"02", bytes("b"), "");

        bytes32[] memory ids = identity.getClaimIdsByTopic(TOPIC);
        assertEq(ids.length, 1);
        (,,,, bytes memory data,) = identity.getClaim(ids[0]);
        assertEq(data, bytes("b"));
    }

    function test_RemoveClaim() public {
        bytes32 claimId = identity.addClaim(TOPIC, 1, issuer, hex"01", bytes("a"), "");
        identity.removeClaim(claimId);

        (,, address gotIssuer,,,) = identity.getClaim(claimId);
        assertEq(gotIssuer, address(0));
        assertEq(identity.getClaimIdsByTopic(TOPIC).length, 0);
    }

    function test_RemoveClaim_RevertWhen_NotFound() public {
        vm.expectRevert(bytes("Identity: claim not found"));
        identity.removeClaim(keccak256("nope"));
    }
}
