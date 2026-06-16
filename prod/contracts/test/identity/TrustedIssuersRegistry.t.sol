// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TrustedIssuersRegistry} from "../../src/identity/TrustedIssuersRegistry.sol";
import {ClaimIssuer} from "../../src/identity/ClaimIssuer.sol";
import {IClaimIssuer} from "../../src/identity/interface/IClaimIssuer.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";

/// @title TrustedIssuersRegistry unit tests (Story 4.1, AC-1/AC-2).
contract TrustedIssuersRegistryTest is Test {
    TrustedIssuersRegistry internal registry;
    ClaimIssuer internal issuer;
    address internal owner = address(this);
    address internal stranger = makeAddr("stranger");

    uint256 internal constant KYC = ClaimTopics.ONCHAINID_KYC;
    uint256 internal constant OTHER = 777;

    function setUp() public {
        registry = new TrustedIssuersRegistry(owner);
        issuer = new ClaimIssuer(address(this));
    }

    function _topics(uint256 a) internal pure returns (uint256[] memory t) {
        t = new uint256[](1);
        t[0] = a;
    }

    function _topics(uint256 a, uint256 b) internal pure returns (uint256[] memory t) {
        t = new uint256[](2);
        t[0] = a;
        t[1] = b;
    }

    function test_AddTrustedIssuer_RecordsIssuerAndTopics() public {
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(KYC));

        assertTrue(registry.isTrustedIssuer(address(issuer)));
        assertTrue(registry.hasClaimTopic(address(issuer), KYC));
        assertFalse(registry.hasClaimTopic(address(issuer), OTHER));

        address[] memory all = registry.getTrustedIssuers();
        assertEq(all.length, 1);
        assertEq(all[0], address(issuer));

        address[] memory forKyc = registry.getTrustedIssuersForClaimTopic(KYC);
        assertEq(forKyc.length, 1);
        assertEq(forKyc[0], address(issuer));

        uint256[] memory topics = registry.getTrustedIssuerClaimTopics(IClaimIssuer(address(issuer)));
        assertEq(topics.length, 1);
        assertEq(topics[0], KYC);
    }

    function test_AddTrustedIssuer_RevertWhen_NoTopics() public {
        vm.expectRevert(bytes("TrustedIssuers: no topics"));
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), new uint256[](0));
    }

    function test_AddTrustedIssuer_RevertWhen_DuplicateIssuer() public {
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(KYC));
        vm.expectRevert(bytes("TrustedIssuers: already trusted"));
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(OTHER));
    }

    function test_AddTrustedIssuer_RevertWhen_DuplicateTopicInSet() public {
        vm.expectRevert(bytes("TrustedIssuers: duplicate topic"));
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(KYC, KYC));
    }

    // Regression (review M2): a codeless issuer (EOA) would make isVerified revert uncatchably.
    function test_AddTrustedIssuer_RevertWhen_IssuerNotAContract() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(bytes("TrustedIssuers: issuer not a contract"));
        registry.addTrustedIssuer(IClaimIssuer(eoa), _topics(KYC));
    }

    function test_AddTrustedIssuer_RevertWhen_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(KYC));
    }

    function test_RemoveTrustedIssuer_ClearsAllBookkeeping() public {
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(KYC, OTHER));
        registry.removeTrustedIssuer(IClaimIssuer(address(issuer)));

        assertFalse(registry.isTrustedIssuer(address(issuer)));
        assertFalse(registry.hasClaimTopic(address(issuer), KYC));
        assertFalse(registry.hasClaimTopic(address(issuer), OTHER));
        assertEq(registry.getTrustedIssuersForClaimTopic(KYC).length, 0);
        assertEq(registry.getTrustedIssuers().length, 0);
    }

    function test_RemoveTrustedIssuer_RevertWhen_NotTrusted() public {
        vm.expectRevert(bytes("TrustedIssuers: not trusted"));
        registry.removeTrustedIssuer(IClaimIssuer(address(issuer)));
    }

    function test_UpdateIssuerClaimTopics_ReplacesSet() public {
        registry.addTrustedIssuer(IClaimIssuer(address(issuer)), _topics(KYC));
        registry.updateIssuerClaimTopics(IClaimIssuer(address(issuer)), _topics(OTHER));

        assertFalse(registry.hasClaimTopic(address(issuer), KYC));
        assertTrue(registry.hasClaimTopic(address(issuer), OTHER));
        assertEq(registry.getTrustedIssuersForClaimTopic(KYC).length, 0);
        assertEq(registry.getTrustedIssuersForClaimTopic(OTHER).length, 1);
    }

    function test_UpdateIssuerClaimTopics_RevertWhen_NotTrusted() public {
        vm.expectRevert(bytes("TrustedIssuers: not trusted"));
        registry.updateIssuerClaimTopics(IClaimIssuer(address(issuer)), _topics(KYC));
    }
}
