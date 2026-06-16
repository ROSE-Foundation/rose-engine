// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "./ClaimFixtures.sol";
import {ClaimIssuer} from "../../src/identity/ClaimIssuer.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IIdentity} from "../../src/identity/interface/IIdentity.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";

/// @title ClaimIssuer unit tests — signed claim issuance + validity + revocation (AC-1, AC-2).
contract ClaimIssuerTest is ClaimFixtures {
    ClaimIssuer internal issuer;
    Identity internal holder;
    address internal issuerOwner = address(this);
    address internal stranger = makeAddr("stranger");

    uint256 internal constant TOPIC = ClaimTopics.ONCHAINID_KYC;
    bytes internal constant DATA = bytes("kyc:passed");

    function setUp() public {
        issuer = new ClaimIssuer(issuerOwner);
        // Register the issuer's off-chain signing key as a CLAIM key on the issuer identity.
        issuer.addKey(_keyHash(_claimSignerAddr()), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());
        holder = new Identity(address(this));
    }

    function test_IsClaimValid_True_ForCorrectlySignedClaim() public view {
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(holder), TOPIC, DATA);
        assertTrue(issuer.isClaimValid(IIdentity(address(holder)), TOPIC, sig, DATA));
    }

    function test_IsClaimValid_False_WhenSignerNotAClaimKey() public view {
        uint256 wrongPk = 0xB0B;
        bytes memory sig = _signClaim(wrongPk, address(holder), TOPIC, DATA);
        assertFalse(issuer.isClaimValid(IIdentity(address(holder)), TOPIC, sig, DATA));
    }

    function test_IsClaimValid_False_WhenDataTampered() public view {
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(holder), TOPIC, DATA);
        assertFalse(issuer.isClaimValid(IIdentity(address(holder)), TOPIC, sig, bytes("tampered")));
    }

    function test_IsClaimValid_False_WhenTopicMismatch() public view {
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(holder), TOPIC, DATA);
        assertFalse(issuer.isClaimValid(IIdentity(address(holder)), TOPIC + 1, sig, DATA));
    }

    function test_IsClaimValid_False_ForMalformedSignature() public view {
        // A garbage signature must fail closed, not revert.
        assertFalse(issuer.isClaimValid(IIdentity(address(holder)), TOPIC, hex"1234", DATA));
    }

    function test_Revoke_FlipsValidity() public {
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(holder), TOPIC, DATA);
        assertTrue(issuer.isClaimValid(IIdentity(address(holder)), TOPIC, sig, DATA));

        issuer.revokeClaimBySignature(sig);

        assertTrue(issuer.isClaimRevoked(sig));
        assertFalse(issuer.isClaimValid(IIdentity(address(holder)), TOPIC, sig, DATA));
    }

    function test_Revoke_RevertWhen_NotManager() public {
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(holder), TOPIC, DATA);
        vm.prank(stranger);
        vm.expectRevert(bytes("Identity: sender lacks management key"));
        issuer.revokeClaimBySignature(sig);
    }

    function test_Revoke_RevertWhen_AlreadyRevoked() public {
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(holder), TOPIC, DATA);
        issuer.revokeClaimBySignature(sig);
        vm.expectRevert(bytes("ClaimIssuer: already revoked"));
        issuer.revokeClaimBySignature(sig);
    }
}
