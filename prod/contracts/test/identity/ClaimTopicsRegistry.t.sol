// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClaimTopicsRegistry} from "../../src/identity/ClaimTopicsRegistry.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";

/// @title ClaimTopicsRegistry unit tests (Story 4.1, AC-1/AC-2).
contract ClaimTopicsRegistryTest is Test {
    ClaimTopicsRegistry internal registry;
    address internal owner = address(this);
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        registry = new ClaimTopicsRegistry(owner);
    }

    function test_AddClaimTopic_PinnedKycTopic() public {
        registry.addClaimTopic(ClaimTopics.ONCHAINID_KYC);
        uint256[] memory topics = registry.getClaimTopics();
        assertEq(topics.length, 1);
        // The on-chain topic is the rule-spec label hashed: keccak256("ONCHAINID_KYC").
        assertEq(topics[0], uint256(keccak256("ONCHAINID_KYC")));
    }

    function test_AddClaimTopic_RevertWhen_Duplicate() public {
        registry.addClaimTopic(ClaimTopics.ONCHAINID_KYC);
        vm.expectRevert(bytes("ClaimTopics: topic already exists"));
        registry.addClaimTopic(ClaimTopics.ONCHAINID_KYC);
    }

    function test_AddClaimTopic_RevertWhen_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.addClaimTopic(ClaimTopics.ONCHAINID_KYC);
    }

    function test_RemoveClaimTopic() public {
        registry.addClaimTopic(ClaimTopics.ONCHAINID_KYC);
        registry.removeClaimTopic(ClaimTopics.ONCHAINID_KYC);
        assertEq(registry.getClaimTopics().length, 0);
    }

    function test_RemoveClaimTopic_RevertWhen_NotFound() public {
        vm.expectRevert(bytes("ClaimTopics: topic not found"));
        registry.removeClaimTopic(ClaimTopics.ONCHAINID_KYC);
    }

    function test_AddClaimTopic_RevertWhen_MaxReached() public {
        uint256 max = registry.MAX_CLAIM_TOPICS();
        for (uint256 i = 0; i < max; i++) {
            registry.addClaimTopic(i + 1);
        }
        vm.expectRevert(bytes("ClaimTopics: max topics reached"));
        registry.addClaimTopic(max + 1);
    }
}
