// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC734} from "./IERC734.sol";
import {IERC735} from "./IERC735.sol";

/// @title IIdentity — ONCHAINID identity (ERC-734 keys + ERC-735 claims)
/// @notice The combined ONCHAINID surface a holder identity exposes. Story 4.1 (FR-19).
interface IIdentity is IERC734, IERC735 {}
