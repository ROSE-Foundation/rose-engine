// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentity} from "./interface/IIdentity.sol";
import {IERC734} from "./interface/IERC734.sol";
import {IERC735} from "./interface/IERC735.sol";

/// @title Identity — ONCHAINID identity (ERC-734 keys + ERC-735 claims)
/// @notice Self-contained ONCHAINID implementation following the Tokeny T-REX / ONCHAINID
///         reference patterns on OpenZeppelin 5.6.x tooling. Keys are referenced by
///         `keccak256(abi.encode(addressOrKey))`; the deployer-supplied address is bootstrapped
///         as the initial MANAGEMENT key. Claims are keyed by `keccak256(abi.encode(issuer,
///         topic))` (one claim per issuer/topic). Story 4.1 (FR-19 foundation).
/// @dev    No token amounts are handled here — only identity/key/claim bookkeeping.
contract Identity is IIdentity {
    /// @notice MANAGEMENT key purpose (1). A MANAGEMENT key satisfies every purpose check.
    uint256 public constant MANAGEMENT_KEY = 1;
    /// @notice ACTION key purpose (2).
    uint256 public constant ACTION_KEY = 2;
    /// @notice CLAIM signer key purpose (3) — required to sign/add claims.
    uint256 public constant CLAIM_SIGNER_KEY = 3;
    /// @notice ECDSA key type (1).
    uint256 public constant ECDSA_TYPE = 1;

    struct Key {
        uint256[] purposes;
        uint256 keyType;
        bytes32 key;
    }

    struct Claim {
        uint256 topic;
        uint256 scheme;
        address issuer;
        bytes signature;
        bytes data;
        string uri;
    }

    mapping(bytes32 => Key) internal _keys;
    mapping(uint256 => bytes32[]) internal _keysByPurpose;
    mapping(bytes32 => Claim) internal _claims;
    mapping(uint256 => bytes32[]) internal _claimsByTopic;

    /// @param initialManagementKey Address bootstrapped as the first MANAGEMENT key.
    constructor(address initialManagementKey) {
        require(initialManagementKey != address(0), "Identity: zero management key");
        bytes32 keyHash = keccak256(abi.encode(initialManagementKey));
        _keys[keyHash].key = keyHash;
        _keys[keyHash].keyType = ECDSA_TYPE;
        _keys[keyHash].purposes.push(MANAGEMENT_KEY);
        _keysByPurpose[MANAGEMENT_KEY].push(keyHash);
        emit KeyAdded(keyHash, MANAGEMENT_KEY, ECDSA_TYPE);
    }

    /// @dev Restrict to the identity itself or a holder of a MANAGEMENT key.
    modifier onlyManager() {
        require(
            msg.sender == address(this) || keyHasPurpose(keccak256(abi.encode(msg.sender)), MANAGEMENT_KEY),
            "Identity: sender lacks management key"
        );
        _;
    }

    /// @inheritdoc IERC734
    function addKey(bytes32 key, uint256 purpose, uint256 keyType) public override onlyManager returns (bool) {
        require(key != bytes32(0), "Identity: zero key");
        if (_keys[key].key == key) {
            uint256[] memory existing = _keys[key].purposes;
            for (uint256 i = 0; i < existing.length; i++) {
                require(existing[i] != purpose, "Identity: key already has purpose");
            }
            _keys[key].purposes.push(purpose);
        } else {
            _keys[key].key = key;
            _keys[key].keyType = keyType;
            _keys[key].purposes.push(purpose);
        }
        _keysByPurpose[purpose].push(key);
        // Emit the STORED key type: for an already-registered key the original type is kept,
        // so the event must mirror storage rather than report the (ignored) `keyType` argument.
        emit KeyAdded(key, purpose, _keys[key].keyType);
        return true;
    }

    /// @inheritdoc IERC734
    function removeKey(bytes32 key, uint256 purpose) public override onlyManager returns (bool) {
        require(_keys[key].key == key, "Identity: key not registered");

        uint256[] storage purposes = _keys[key].purposes;
        uint256 purposeCount = purposes.length;
        bool found;
        for (uint256 i = 0; i < purposeCount; i++) {
            if (purposes[i] == purpose) {
                purposes[i] = purposes[purposeCount - 1];
                purposes.pop();
                found = true;
                break;
            }
        }
        require(found, "Identity: key lacks purpose");
        // Never strand the identity: removing the final MANAGEMENT key would make every
        // management-gated method permanently uncallable (an irrecoverable brick). At this
        // point `_keysByPurpose[MANAGEMENT_KEY]` still contains `key`, so require >1.
        if (purpose == MANAGEMENT_KEY) {
            require(_keysByPurpose[MANAGEMENT_KEY].length > 1, "Identity: cannot remove last management key");
        }

        bytes32[] storage byPurpose = _keysByPurpose[purpose];
        uint256 byPurposeCount = byPurpose.length;
        for (uint256 i = 0; i < byPurposeCount; i++) {
            if (byPurpose[i] == key) {
                byPurpose[i] = byPurpose[byPurposeCount - 1];
                byPurpose.pop();
                break;
            }
        }

        uint256 keyType = _keys[key].keyType;
        if (purposes.length == 0) {
            delete _keys[key];
        }
        emit KeyRemoved(key, purpose, keyType);
        return true;
    }

    /// @inheritdoc IERC734
    function getKey(bytes32 key)
        external
        view
        override
        returns (uint256[] memory purposes, uint256 keyType, bytes32 keyValue)
    {
        return (_keys[key].purposes, _keys[key].keyType, _keys[key].key);
    }

    /// @inheritdoc IERC734
    function getKeyPurposes(bytes32 key) external view override returns (uint256[] memory) {
        return _keys[key].purposes;
    }

    /// @inheritdoc IERC734
    function getKeysByPurpose(uint256 purpose) external view override returns (bytes32[] memory) {
        return _keysByPurpose[purpose];
    }

    /// @inheritdoc IERC734
    function keyHasPurpose(bytes32 key, uint256 purpose) public view override returns (bool) {
        Key storage k = _keys[key];
        if (k.key == bytes32(0)) {
            return false;
        }
        uint256 count = k.purposes.length;
        for (uint256 i = 0; i < count; i++) {
            uint256 held = k.purposes[i];
            // A MANAGEMENT key (purpose 1) implicitly satisfies every purpose check.
            if (held == MANAGEMENT_KEY || held == purpose) {
                return true;
            }
        }
        return false;
    }

    /// @inheritdoc IERC735
    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external override returns (bytes32 claimId) {
        require(issuer != address(0), "Identity: zero issuer");
        if (msg.sender != address(this)) {
            require(
                keyHasPurpose(keccak256(abi.encode(msg.sender)), CLAIM_SIGNER_KEY), "Identity: sender lacks claim key"
            );
        }
        claimId = keccak256(abi.encode(issuer, topic));
        if (_claims[claimId].issuer != issuer) {
            _claimsByTopic[topic].push(claimId);
            _claims[claimId] = Claim(topic, scheme, issuer, signature, data, uri);
            emit ClaimAdded(claimId, topic, scheme, issuer, signature, data, uri);
        } else {
            _claims[claimId] = Claim(topic, scheme, issuer, signature, data, uri);
            emit ClaimChanged(claimId, topic, scheme, issuer, signature, data, uri);
        }
    }

    /// @inheritdoc IERC735
    function removeClaim(bytes32 claimId) external override onlyManager returns (bool) {
        Claim memory claim = _claims[claimId];
        require(claim.issuer != address(0), "Identity: claim not found");

        bytes32[] storage ids = _claimsByTopic[claim.topic];
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; i++) {
            if (ids[i] == claimId) {
                ids[i] = ids[count - 1];
                ids.pop();
                break;
            }
        }
        delete _claims[claimId];
        emit ClaimRemoved(claimId, claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, claim.uri);
        return true;
    }

    /// @inheritdoc IERC735
    function getClaim(bytes32 claimId)
        external
        view
        override
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        )
    {
        Claim storage c = _claims[claimId];
        return (c.topic, c.scheme, c.issuer, c.signature, c.data, c.uri);
    }

    /// @inheritdoc IERC735
    function getClaimIdsByTopic(uint256 topic) external view override returns (bytes32[] memory) {
        return _claimsByTopic[topic];
    }
}
