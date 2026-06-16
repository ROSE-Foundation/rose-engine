// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRoseToken} from "./IRoseToken.sol";

/// @title ICoupledPair — the on-chain coupling primitive (atomic paired mint/burn)
/// @notice Coordinates the two legs of a coupled pair (L-Token / S-Token) so that they are
///         minted and burned ONLY together, atomically, at equal notional — the on-chain
///         analogue of the "never a single leg" rule (FR-6, FR-19 coupling). The coupler is the
///         sole minter/burner of both legs; a single-leg mint or burn is structurally impossible.
/// @dev    L/S are directional/separate in HOLDING (legs transfer independently, subject to 4.2
///         eligibility) but their EMISSION stays paired (delta-neutral at issuance, D1). Hence
///         coupling is enforced on mint/burn, not on transfer. Story 4.3.
interface ICoupledPair {
    /// @notice Emitted once, at construction, when both legs are deployed.
    event PairDeployed(address indexed lToken, address indexed sToken);
    /// @notice Emitted when `amount` of each leg is minted (to `lTo` / `sTo`) as one pair.
    event PairMinted(address indexed lTo, address indexed sTo, uint256 amount);
    /// @notice Emitted when `amount` of each leg is burned (from `lFrom` / `sFrom`) as one pair.
    event PairBurned(address indexed lFrom, address indexed sFrom, uint256 amount);
    /// @notice Emitted when `agent` is granted the transfer-agent role on BOTH legs (Story 4.6).
    event LegAgentAdded(address indexed agent);
    /// @notice Emitted when `agent`'s transfer-agent role is revoked on BOTH legs (Story 4.6).
    event LegAgentRemoved(address indexed agent);

    /// @notice The L-Token leg.
    function lToken() external view returns (IRoseToken);

    /// @notice The S-Token leg.
    function sToken() external view returns (IRoseToken);

    /// @notice True only while a paired mint/burn is in flight — the single signal the legs
    ///         consult to authorize their (otherwise impossible) single-leg emission.
    function pairingInProgress() external view returns (bool);

    /// @notice Mint `amount` of L to `lTo` and `amount` of S to `sTo` atomically (both-or-neither),
    ///         at equal notional. Reverts (and reverts BOTH legs) if either recipient is ineligible.
    function mintPair(address lTo, address sTo, uint256 amount) external;

    /// @notice Burn `amount` of L from `lFrom` and `amount` of S from `sFrom` atomically.
    function burnPair(address lFrom, address sFrom, uint256 amount) external;

    /// @notice Grant `agent` the ERC-3643 transfer-agent role on BOTH legs (Story 4.6). The legs
    ///         are owned by the pair, so this owner-gated forwarder is the only path to the legs'
    ///         `onlyOwner` `addAgent`. The agent then calls the per-call powers (forcedTransfer,
    ///         recoveryAddress, freeze, pause) directly on each leg.
    function addLegAgent(address agent) external;

    /// @notice Revoke `agent`'s transfer-agent role on BOTH legs (Story 4.6). Owner-gated forwarder.
    function removeLegAgent(address agent) external;
}
