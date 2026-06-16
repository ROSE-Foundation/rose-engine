// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
// Smoke test (Story 1.1): proves the `@openzeppelin/contracts/` remapping resolves, i.e.
// the OpenZeppelin 5.6.x dependency is installed and usable. No domain logic here — the
// custom ERC-3643-compatible token suite arrives in Epic 4.
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Owned is Ownable {
    constructor(address initialOwner) Ownable(initialOwner) {}
}

contract OpenZeppelinResolvesTest is Test {
    function test_OpenZeppelinDependencyResolvesAndCompiles() public {
        Owned owned = new Owned(address(this));
        assertEq(owned.owner(), address(this));
    }
}
