// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title ClaimFixtures — shared helpers for producing real ECDSA-signed ONCHAINID claims.
/// @dev Reproduces, in test code, exactly what an off-chain claim-issuer operator would sign:
///      `toEthSignedMessageHash(keccak256(abi.encode(identity, topic, data)))`.
abstract contract ClaimFixtures is Test {
    /// @dev Private key of the issuer's CLAIM signing key used across the suite.
    uint256 internal constant CLAIM_SIGNER_PK = 0xA11CE;

    /// @notice Address derived from {CLAIM_SIGNER_PK}; register it as a CLAIM key on the issuer.
    function _claimSignerAddr() internal pure returns (address) {
        return vm.addr(CLAIM_SIGNER_PK);
    }

    /// @notice The ERC-734 key hash for an address (how keys are referenced on an Identity).
    function _keyHash(address account) internal pure returns (bytes32) {
        return keccak256(abi.encode(account));
    }

    /// @notice Produce a valid claim signature over (identity, topic, data) using `pk`.
    function _signClaim(uint256 pk, address identityAddr, uint256 topic, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 dataHash = keccak256(abi.encode(identityAddr, topic, data));
        bytes32 prefixed = MessageHashUtils.toEthSignedMessageHash(dataHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, prefixed);
        return abi.encodePacked(r, s, v);
    }
}
