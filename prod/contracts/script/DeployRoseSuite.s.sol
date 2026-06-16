// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ClaimTopicsRegistry} from "../src/identity/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "../src/identity/TrustedIssuersRegistry.sol";
import {IdentityRegistry} from "../src/identity/IdentityRegistry.sol";
import {ClaimIssuer} from "../src/identity/ClaimIssuer.sol";
import {CoupledPair} from "../src/token/CoupledPair.sol";
import {IClaimIssuer} from "../src/identity/interface/IClaimIssuer.sol";
import {IClaimTopicsRegistry} from "../src/identity/interface/IClaimTopicsRegistry.sol";
import {ITrustedIssuersRegistry} from "../src/identity/interface/ITrustedIssuersRegistry.sol";
import {IIdentityRegistry} from "../src/identity/interface/IIdentityRegistry.sol";
import {GeneratedComplianceConfig} from "../src/generated/GeneratedComplianceConfig.sol";

/// @title DeployRoseSuite — `forge script` deploying the ROSE on-chain plane (Story 4.6, FR-22)
/// @notice Deploys the full ERC-3643-compatible suite in the order validated by Stories 4.1–4.5:
///         ClaimTopicsRegistry → TrustedIssuersRegistry → IdentityRegistry → seed topics from the
///         GENERATED rule-spec config (`GeneratedComplianceConfig.seedClaimTopics`, Story 4.5, NOT
///         hand-written) → ClaimIssuer (trusted for `requiredClaimTopics()`) → grant the identity
///         agent → `CoupledPair` → grant the transfer-agent on both legs → hand ownership to the
///         final owner. Compliance parameters come from the generated library, never hand-edited.
/// @dev    `deploy(...)` is the PURE, broadcast-free deployment proven LOCALLY by
///         `test/script/DeployRoseSuite.t.sol` (forge's in-process EVM — no Sepolia needed).
///         `run()` is the broadcast entrypoint for a REAL testnet deploy and follows refuse-if-
///         absent: it reverts cleanly if `SEPOLIA_RPC_URL`, the deployer key, or the role
///         addresses are absent — NO placeholder, NO default secret, NO `.env` is created here.
///         The real Sepolia broadcast is a deferred ops step (see `deferred-work.md`).
///
///         OWNERSHIP GOTCHA: under `vm.startBroadcast(pk)` the script's calls have
///         `msg.sender == vm.addr(pk)`, so `run()` sets `setupOwner = vm.addr(pk)`; in a plain
///         forge test the script's calls have `msg.sender == address(script)`, so the test sets
///         `setupOwner = address(scriptInstance)`. The transient setup owner seeds topics and
///         grants agents, then hands every contract to `finalOwner`.
contract DeployRoseSuite is Script {
    /// @notice Deployment parameters (all addresses; no secrets embedded).
    /// @param setupOwner Transient owner that seeds topics + grants agents (deployer EOA / script).
    /// @param finalOwner Owner the contracts are handed to (the issuer operator).
    /// @param transferAgent ERC-3643 transfer-agent granted on BOTH legs.
    /// @param identityAgent Agent allowed to register holder identities (runtime, Epic 5).
    /// @param claimSigner EOA whose key signs eligibility claims (ClaimIssuer CLAIM_SIGNER_KEY).
    struct DeployConfig {
        address setupOwner;
        address finalOwner;
        address transferAgent;
        address identityAgent;
        address claimSigner;
    }

    /// @notice The addresses of every deployed contract (to be recorded in config, §8 Q4).
    struct DeployedAddresses {
        address topicsRegistry;
        address issuersRegistry;
        address identityRegistry;
        address claimIssuer;
        address pair;
        address lToken;
        address sToken;
    }

    /// @notice Deploy the suite in the validated order. Broadcast-free and side-effect-pure beyond
    ///         the deployments, so it is callable from a forge test AND wrapped by {run} under
    ///         broadcast. Compliance params come from `GeneratedComplianceConfig` (Story 4.5).
    function deploy(DeployConfig memory cfg) public returns (DeployedAddresses memory a) {
        require(cfg.setupOwner != address(0), "Deploy: zero setupOwner");
        require(cfg.finalOwner != address(0), "Deploy: zero finalOwner");
        require(cfg.transferAgent != address(0), "Deploy: zero transferAgent");
        require(cfg.identityAgent != address(0), "Deploy: zero identityAgent");
        require(cfg.claimSigner != address(0), "Deploy: zero claimSigner");

        // 1-3. Registries + identity registry, owned (transiently) by the setup owner so it can
        //      seed topics and add agents below.
        ClaimTopicsRegistry topics = new ClaimTopicsRegistry(cfg.setupOwner);
        TrustedIssuersRegistry issuers = new TrustedIssuersRegistry(cfg.setupOwner);
        IdentityRegistry idReg = new IdentityRegistry(
            cfg.setupOwner, IClaimTopicsRegistry(address(topics)), ITrustedIssuersRegistry(address(issuers))
        );

        // 4. Seed the required claim topics FROM the generated rule-spec config (NOT hand-written).
        GeneratedComplianceConfig.seedClaimTopics(topics);

        // 5. Claim issuer (its own ONCHAINID), trusted for exactly the generated topics. The claim
        //    SIGNER key signs eligibility claims; management starts with the setup owner so it can
        //    add keys, then `finalOwner` is added as a management key (handover).
        ClaimIssuer issuer = new ClaimIssuer(cfg.setupOwner);
        issuer.addKey(keccak256(abi.encode(cfg.claimSigner)), issuer.CLAIM_SIGNER_KEY(), issuer.ECDSA_TYPE());
        issuers.addTrustedIssuer(IClaimIssuer(address(issuer)), GeneratedComplianceConfig.requiredClaimTopics());

        // 6. The identity agent registers holders against the allowlist at runtime (Epic 5).
        idReg.addAgent(cfg.identityAgent);

        // 7. The coupled pair (deploys both legs, owned by the pair).
        CoupledPair pair = new CoupledPair(
            IIdentityRegistry(address(idReg)), "ROSE Long", "ROSE-L", "ROSE Short", "ROSE-S", cfg.setupOwner
        );

        // 8. Grant the transfer-agent role on BOTH legs (the pair forwards the leg `addAgent`).
        pair.addLegAgent(cfg.transferAgent);

        // 9. Handover: add `finalOwner` as a claim-issuer management key, then transfer every
        //    contract's `Ownable` ownership to `finalOwner` (single-step; multisig / deployer-key
        //    rotation are deferred ops — see deferred-work.md).
        issuer.addKey(keccak256(abi.encode(cfg.finalOwner)), issuer.MANAGEMENT_KEY(), issuer.ECDSA_TYPE());
        topics.transferOwnership(cfg.finalOwner);
        issuers.transferOwnership(cfg.finalOwner);
        idReg.transferOwnership(cfg.finalOwner);
        pair.transferOwnership(cfg.finalOwner);

        a = DeployedAddresses({
            topicsRegistry: address(topics),
            issuersRegistry: address(issuers),
            identityRegistry: address(idReg),
            claimIssuer: address(issuer),
            pair: address(pair),
            lToken: address(pair.lToken()),
            sToken: address(pair.sToken())
        });
    }

    /// @notice Broadcast entrypoint for a REAL testnet deploy. Refuse-if-absent on all secrets and
    ///         role addresses. Run with `--rpc-url $SEPOLIA_RPC_URL --broadcast` once secrets are
    ///         provided out-of-band; until then it refuses cleanly. (Deferred ops — see story.)
    function run() external returns (DeployedAddresses memory a) {
        _refuseIfNetworkAbsent();

        // Refuse-if-absent: these REVERT when the env var is missing (no defaults, no placeholders).
        uint256 pk = vm.envUint("ROSE_DEPLOYER_PRIVATE_KEY");
        DeployConfig memory cfg = DeployConfig({
            setupOwner: vm.addr(pk),
            finalOwner: vm.envAddress("ROSE_TOKEN_OWNER"),
            transferAgent: vm.envAddress("ROSE_TRANSFER_AGENT"),
            identityAgent: vm.envAddress("ROSE_IDENTITY_AGENT"),
            claimSigner: vm.envAddress("ROSE_CLAIM_SIGNER")
        });

        vm.startBroadcast(pk);
        a = deploy(cfg);
        vm.stopBroadcast();

        _logAddresses(a);
    }

    /// @dev Refuse-if-absent guard on the network endpoint: NO placeholder RPC, NO default secret.
    function _refuseIfNetworkAbsent() internal view {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        require(
            bytes(rpc).length > 0,
            "DeployRoseSuite: SEPOLIA_RPC_URL absent (refuse-if-absent); provide network secrets out-of-band before broadcast"
        );
    }

    /// @dev Emit the deployed addresses so they can be recorded in config (§8 Q4 placeholders).
    function _logAddresses(DeployedAddresses memory a) internal pure {
        console2.log("ClaimTopicsRegistry  ", a.topicsRegistry);
        console2.log("TrustedIssuersRegistry", a.issuersRegistry);
        console2.log("IdentityRegistry     ", a.identityRegistry);
        console2.log("ClaimIssuer          ", a.claimIssuer);
        console2.log("CoupledPair          ", a.pair);
        console2.log("L-Token (ROSE-L)     ", a.lToken);
        console2.log("S-Token (ROSE-S)     ", a.sToken);
    }
}
