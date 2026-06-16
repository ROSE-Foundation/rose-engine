// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClaimFixtures} from "../identity/ClaimFixtures.sol";
import {DeployRoseSuite} from "../../script/DeployRoseSuite.s.sol";
import {ClaimTopicsRegistry} from "../../src/identity/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "../../src/identity/TrustedIssuersRegistry.sol";
import {IdentityRegistry} from "../../src/identity/IdentityRegistry.sol";
import {CoupledPair} from "../../src/token/CoupledPair.sol";
import {CoupledLeg} from "../../src/token/CoupledLeg.sol";
import {Identity} from "../../src/identity/Identity.sol";
import {IIdentity} from "../../src/identity/interface/IIdentity.sol";
import {GeneratedComplianceConfig} from "../../src/generated/GeneratedComplianceConfig.sol";
import {ClaimTopics} from "../../src/identity/ClaimTopics.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DeployRoseSuite LOCAL proof (Story 4.6, AC-4).
/// @notice Exercises the deploy script's pure `deploy(...)` on forge's in-process EVM — the local
///         chain — with NO `--broadcast` and NO Sepolia. Proves the suite is wired in the validated
///         order: topics seeded from the GENERATED config, the claim issuer trusted, the transfer-
///         agent granted on both legs, the identity agent set, ownership handed to the final owner,
///         and an end-to-end eligibility + paired-mint flow on the deployed contracts.
/// @dev    The test calls `script.deploy(cfg)` directly, so the script is the transient owner of the
///         setup calls ⇒ `cfg.setupOwner = address(script)`. (Under a real broadcast `run()` uses
///         `vm.addr(pk)` instead — see DeployRoseSuite NatSpec.)
contract DeployRoseSuiteTest is ClaimFixtures {
    DeployRoseSuite internal script;

    address internal finalOwner = makeAddr("finalOwner");
    address internal transferAgent = makeAddr("transferAgent");
    address internal identityAgent = makeAddr("identityAgent");
    address internal holder = makeAddr("holder");
    address internal counterparty = makeAddr("counterparty");

    uint256 internal constant KYC = ClaimTopics.ONCHAINID_KYC;
    bytes internal constant DATA = bytes("kyc:passed");

    function _config() internal view returns (DeployRoseSuite.DeployConfig memory) {
        return DeployRoseSuite.DeployConfig({
            setupOwner: address(script), // the script is the caller of the owner-gated setup calls
            finalOwner: finalOwner,
            transferAgent: transferAgent,
            identityAgent: identityAgent,
            claimSigner: _claimSignerAddr() // ClaimFixtures CLAIM_SIGNER_PK
        });
    }

    function setUp() public {
        script = new DeployRoseSuite();
    }

    function test_Deploy_SeedsGeneratedTopics() public {
        DeployRoseSuite.DeployedAddresses memory a = script.deploy(_config());
        uint256[] memory got = ClaimTopicsRegistry(a.topicsRegistry).getClaimTopics();
        uint256[] memory want = GeneratedComplianceConfig.requiredClaimTopics();
        assertEq(got.length, want.length);
        assertGt(got.length, 0);
        for (uint256 i = 0; i < want.length; i++) {
            assertEq(got[i], want[i]);
        }
    }

    function test_Deploy_TrustsClaimIssuer() public {
        DeployRoseSuite.DeployedAddresses memory a = script.deploy(_config());
        assertTrue(TrustedIssuersRegistry(a.issuersRegistry).isTrustedIssuer(a.claimIssuer));
    }

    function test_Deploy_GrantsTransferAgentOnBothLegs() public {
        DeployRoseSuite.DeployedAddresses memory a = script.deploy(_config());
        assertTrue(CoupledLeg(a.lToken).isAgent(transferAgent));
        assertTrue(CoupledLeg(a.sToken).isAgent(transferAgent));
    }

    function test_Deploy_GrantsIdentityAgent() public {
        DeployRoseSuite.DeployedAddresses memory a = script.deploy(_config());
        assertTrue(IdentityRegistry(a.identityRegistry).isAgent(identityAgent));
    }

    function test_Deploy_HandsOwnershipToFinalOwner() public {
        DeployRoseSuite.DeployedAddresses memory a = script.deploy(_config());
        assertEq(Ownable(a.topicsRegistry).owner(), finalOwner);
        assertEq(Ownable(a.issuersRegistry).owner(), finalOwner);
        assertEq(Ownable(a.identityRegistry).owner(), finalOwner);
        assertEq(Ownable(a.pair).owner(), finalOwner);
    }

    function test_Deploy_EndToEnd_EligibilityAndPairedMint() public {
        DeployRoseSuite.DeployedAddresses memory a = script.deploy(_config());
        IdentityRegistry idReg = IdentityRegistry(a.identityRegistry);

        // Register + claim a holder against the deployed allowlist (agent-gated, signed by the
        // configured claim signer) and prove on-chain eligibility.
        _registerVerified(idReg, a.claimIssuer, holder);
        _registerVerified(idReg, a.claimIssuer, counterparty);
        assertTrue(idReg.isVerified(holder));

        // The pair is now finalOwner-owned ⇒ mintPair must be issued by the final owner.
        CoupledPair pair = CoupledPair(a.pair);
        vm.prank(finalOwner);
        pair.mintPair(holder, counterparty, 1_000 ether);
        assertEq(CoupledLeg(a.lToken).balanceOf(holder), 1_000 ether);
        assertEq(CoupledLeg(a.sToken).balanceOf(counterparty), 1_000 ether);
    }

    function _registerVerified(IdentityRegistry idReg, address claimIssuer, address wallet) internal {
        Identity id = new Identity(address(this));
        bytes memory sig = _signClaim(CLAIM_SIGNER_PK, address(id), KYC, DATA);
        id.addClaim(KYC, 1, claimIssuer, sig, DATA, "");
        vm.prank(identityAgent);
        idReg.registerIdentity(wallet, IIdentity(address(id)), 250);
    }

    function test_RevertWhen_Run_NetworkSecretsAbsent() public {
        // No SEPOLIA_RPC_URL / deployer key in the test env ⇒ refuse-if-absent.
        vm.expectRevert();
        script.run();
    }
}
