// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Identity} from "./Identity.sol";
import {IClaimIssuer} from "./interface/IClaimIssuer.sol";
import {IIdentity} from "./interface/IIdentity.sol";

/// @title ClaimIssuer — trusted claim issuer (ONCHAINID identity with revocation + validity)
/// @notice An issuer is itself an ONCHAINID `Identity`; its CLAIM keys sign the claims it
///         issues. `isClaimValid` is fail-closed: a claim is valid only if its signature
///         recovers to a CLAIM key on THIS issuer AND the signature has not been revoked.
///         Mirrors the ERC-3643 ClaimIssuer. Story 4.1 (FR-19).
contract ClaimIssuer is Identity, IClaimIssuer {
    /// @dev Revocation set keyed by `keccak256(signature)`.
    mapping(bytes32 => bool) internal _revokedClaims;

    constructor(address initialManagementKey) Identity(initialManagementKey) {}

    /// @inheritdoc IClaimIssuer
    function revokeClaimBySignature(bytes calldata signature) external override onlyManager {
        bytes32 sigHash = keccak256(signature);
        require(!_revokedClaims[sigHash], "ClaimIssuer: already revoked");
        _revokedClaims[sigHash] = true;
        emit ClaimRevoked(signature);
    }

    /// @inheritdoc IClaimIssuer
    function isClaimRevoked(bytes calldata signature) external view override returns (bool) {
        return _revokedClaims[keccak256(signature)];
    }

    /// @inheritdoc IClaimIssuer
    function isClaimValid(IIdentity identity, uint256 topic, bytes memory signature, bytes memory data)
        public
        view
        override
        returns (bool)
    {
        // Recompute the digest the issuer signed: keccak256(abi.encode(identity, topic, data)),
        // EIP-191 prefixed. A malformed signature yields `err != NoError` ⇒ fail closed.
        bytes32 dataHash = keccak256(abi.encode(address(identity), topic, data));
        bytes32 prefixed = MessageHashUtils.toEthSignedMessageHash(dataHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(prefixed, signature);
        if (err != ECDSA.RecoverError.NoError) {
            return false;
        }
        if (_revokedClaims[keccak256(signature)]) {
            return false;
        }
        return keyHasPurpose(keccak256(abi.encode(recovered)), CLAIM_SIGNER_KEY);
    }
}
