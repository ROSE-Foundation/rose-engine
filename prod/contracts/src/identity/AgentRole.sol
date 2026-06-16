// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentRole — owner-managed agent set
/// @notice An `Ownable` base that lets the owner grant/revoke an "agent" role. In the
///         IdentityRegistry, agents are the only callers allowed to mutate the curated
///         allowlist (registration presupposes off-chain KYC/AML). Mirrors the ERC-3643
///         AgentRole. Story 4.1 (FR-19; the broader transfer-agent powers arrive in 4.6).
abstract contract AgentRole is Ownable {
    mapping(address => bool) private _agents;

    /// @notice Emitted when `agent` is granted the agent role.
    event AgentAdded(address indexed agent);
    /// @notice Emitted when `agent` has the agent role revoked.
    event AgentRemoved(address indexed agent);

    /// @dev Restrict to addresses holding the agent role.
    modifier onlyAgent() {
        require(_agents[msg.sender], "AgentRole: caller is not an agent");
        _;
    }

    /// @notice Grant `agent` the agent role. Owner-only.
    function addAgent(address agent) external onlyOwner {
        require(agent != address(0), "AgentRole: zero agent");
        require(!_agents[agent], "AgentRole: already an agent");
        _agents[agent] = true;
        emit AgentAdded(agent);
    }

    /// @notice Revoke `agent`'s agent role. Owner-only.
    function removeAgent(address agent) external onlyOwner {
        require(_agents[agent], "AgentRole: not an agent");
        _agents[agent] = false;
        emit AgentRemoved(agent);
    }

    /// @notice True iff `agent` holds the agent role.
    function isAgent(address agent) external view returns (bool) {
        return _agents[agent];
    }
}
