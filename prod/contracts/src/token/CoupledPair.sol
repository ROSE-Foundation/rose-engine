// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CoupledLeg} from "./CoupledLeg.sol";
import {IRoseToken} from "./interface/IRoseToken.sol";
import {ICoupledPair} from "./interface/ICoupledPair.sol";
import {IIdentityRegistry} from "../identity/interface/IIdentityRegistry.sol";

/// @title CoupledPair — the coupling primitive enforcing atomic paired mint/burn
/// @notice Owns and is the SOLE minter/burner of both legs (L-Token / S-Token), each a
///         Story-4.2 eligibility-gated `CoupledLeg`. `mintPair`/`burnPair` move BOTH legs by the
///         same `amount` in a single transaction, so the coupling invariant
///         `lToken.totalSupply() == sToken.totalSupply()` holds in every reachable state and a
///         single-leg mint/burn is impossible (the legs' owner-gated `mint`/`burn` are callable
///         only here, and their `_update` coupling guard additionally requires `pairingInProgress`).
/// @dev    The pair deploys both legs in its constructor with `initialOwner == coupler == this`,
///         resolving the leg↔coupler cycle. `mintPair`/`burnPair` are `onlyOwner` (issuer /
///         transfer-agent; the role formalization is Story 4.6). Atomicity is intrinsic: if either
///         leg reverts (ineligible recipient, or coupling guard), the whole tx reverts —
///         both-or-neither — and `_pairing` rolls back with it (no stuck flag). Story 4.3 (FR-6,
///         FR-19 coupling).
contract CoupledPair is Ownable, ICoupledPair {
    CoupledLeg private immutable _lToken;
    CoupledLeg private immutable _sToken;

    /// @dev True only for the duration of a `mintPair`/`burnPair` call — the single authorization
    ///      signal the legs consult to permit their (otherwise impossible) single-leg emission.
    bool private _pairing;

    constructor(
        IIdentityRegistry registry_,
        string memory lName,
        string memory lSymbol,
        string memory sName,
        string memory sSymbol,
        address initialOwner
    ) Ownable(initialOwner) {
        require(address(registry_) != address(0), "CoupledPair: zero registry");
        _lToken = new CoupledLeg(lName, lSymbol, registry_, address(this));
        _sToken = new CoupledLeg(sName, sSymbol, registry_, address(this));
        emit PairDeployed(address(_lToken), address(_sToken));
    }

    /// @inheritdoc ICoupledPair
    function lToken() external view override returns (IRoseToken) {
        return _lToken;
    }

    /// @inheritdoc ICoupledPair
    function sToken() external view override returns (IRoseToken) {
        return _sToken;
    }

    /// @inheritdoc ICoupledPair
    function pairingInProgress() external view override returns (bool) {
        return _pairing;
    }

    /// @inheritdoc ICoupledPair
    function mintPair(address lTo, address sTo, uint256 amount) external override onlyOwner {
        _pairing = true;
        _lToken.mint(lTo, amount);
        _sToken.mint(sTo, amount);
        _pairing = false;
        emit PairMinted(lTo, sTo, amount);
    }

    /// @inheritdoc ICoupledPair
    function burnPair(address lFrom, address sFrom, uint256 amount) external override onlyOwner {
        _pairing = true;
        _lToken.burn(lFrom, amount);
        _sToken.burn(sFrom, amount);
        _pairing = false;
        emit PairBurned(lFrom, sFrom, amount);
    }

    /// @notice Carve out `amount` of `holder`'s L-Token balance as segregated principal (Model-A,
    ///         Story 4.4). Owner-gated forwarder: the pair is the sole owner of both legs, so the
    ///         principal primitive is reachable only here, keeping the legs sealed from EOAs.
    /// @dev Does NOT touch `mintPair`/`burnPair` coupling/atomicity; principal designation is a
    ///      separate issuer step. Reverts if `amount` would exceed `holder`'s balance.
    function designateLPrincipal(address holder, uint256 amount) external onlyOwner {
        _lToken.designatePrincipal(holder, amount);
    }

    /// @notice Carve out `amount` of `holder`'s S-Token balance as segregated principal (Model-A,
    ///         Story 4.4). Owner-gated forwarder; see `designateLPrincipal`.
    function designateSPrincipal(address holder, uint256 amount) external onlyOwner {
        _sToken.designatePrincipal(holder, amount);
    }

    /// @inheritdoc ICoupledPair
    /// @dev Owner-gated forwarder (Story 4.6): the legs are owned by THIS pair, so their `onlyOwner`
    ///      `AgentRole.addAgent` is reachable only here. Grants the transfer-agent role on BOTH legs
    ///      so the agent can call forcedTransfer / recoveryAddress / freeze / pause directly on each.
    function addLegAgent(address agent) external override onlyOwner {
        _lToken.addAgent(agent);
        _sToken.addAgent(agent);
        emit LegAgentAdded(agent);
    }

    /// @inheritdoc ICoupledPair
    /// @dev Owner-gated forwarder (Story 4.6): revokes the transfer-agent role on BOTH legs.
    function removeLegAgent(address agent) external override onlyOwner {
        _lToken.removeAgent(agent);
        _sToken.removeAgent(agent);
        emit LegAgentRemoved(agent);
    }
}
