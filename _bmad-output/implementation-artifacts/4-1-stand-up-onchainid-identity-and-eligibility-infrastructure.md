---
baseline_commit: NO_VCS
---

# Story 4.1: Stand up ONCHAINID identity and eligibility infrastructure

Status: done

## Story

As a claim issuer operator,
I want ONCHAINID identities, a trusted claim issuer, and the supporting registries,
so that only curated, allowlist-eligible holders carry the on-chain eligibility claim (FR-19 foundation).

## Acceptance Criteria

**AC-1 — Register an ONCHAINID and issue an eligibility claim from the trusted claim issuer; the three registries record the eligible holder against the curated allowlist**
**Given** the Foundry contracts suite (OpenZeppelin 5.6.x base, ONCHAINID ERC-734/735 patterns)
**When** I register an ONCHAINID and issue an eligibility claim from the trusted claim issuer
**Then** the identity registry, claim-topics registry, and trusted-issuers registry record the eligible holder against the curated allowlist

**AC-2 — Foundry tests cover identity registration and claim issuance**
**Given** the identity/eligibility suite
**When** the Foundry test suite runs
**Then** tests cover identity registration and claim issuance (incl. the end-to-end "is this holder eligible?" verification path), and `forge test` is green

## Tasks / Subtasks

- [x] **Task 1 — ONCHAINID identity primitive (ERC-734 keys + ERC-735 claims) (AC: 1, 2)**
  - [x] `prod/contracts/src/identity/interface/IERC734.sol` — KeyHolder interface: `Key{purposes[],keyType,key}`, `addKey`, `removeKey`, `getKey`, `getKeysByPurpose`, `keyHasPurpose`, events.
  - [x] `prod/contracts/src/identity/interface/IERC735.sol` — ClaimHolder interface: `Claim{topic,scheme,issuer,signature,data,uri}`, `addClaim`, `removeClaim`, `getClaim`, `getClaimIdsByTopic`, events.
  - [x] `prod/contracts/src/identity/interface/IIdentity.sol` — `is IERC734, IERC735` (ONCHAINID identity surface).
  - [x] `prod/contracts/src/identity/Identity.sol` — concrete ONCHAINID: purpose constants `MANAGEMENT=1`, `ACTION=2`, `CLAIM=3`; the management key bootstrapped to the deployer/owner address; `addClaim` gated to a `CLAIM` (or `MANAGEMENT`) key; deterministic `claimId = keccak256(abi.encode(issuer, topic))`; per-topic claim id index. Solidity `0.8.28`, `pragma ^0.8.28`, SPDX `MIT`.
- [x] **Task 2 — Trusted claim issuer (ERC-735 issuer with revocation + signature validity) (AC: 1, 2)**
  - [x] `prod/contracts/src/identity/interface/IClaimIssuer.sol` — `is IIdentity`; adds `revokeClaimBySignature`, `isClaimRevoked`, `isClaimValid(identity, topic, signature, data)`.
  - [x] `prod/contracts/src/identity/ClaimIssuer.sol` — `is Identity, IClaimIssuer`. `isClaimValid` recovers the signer over `keccak256(abi.encode(identity, topic, data))` (EIP-191 `toEthSignedMessageHash`) via OZ `ECDSA`, requires the recovered address to hold a `CLAIM` key on the issuer, and requires the claim signature not be revoked. `revokeClaimBySignature` is owner/management-gated.
- [x] **Task 3 — Claim-topics registry + trusted-issuers registry (AC: 1, 2)**
  - [x] `prod/contracts/src/identity/interface/IClaimTopicsRegistry.sol` and `ClaimTopicsRegistry.sol` (`is Ownable`): `addClaimTopic`, `removeClaimTopic`, `getClaimTopics`; reject duplicates; cap topic count to bound `isVerified` loops.
  - [x] `prod/contracts/src/identity/interface/ITrustedIssuersRegistry.sol` and `TrustedIssuersRegistry.sol` (`is Ownable`): `addTrustedIssuer(IClaimIssuer, uint256[] topics)`, `removeTrustedIssuer`, `updateIssuerClaimTopics`, `getTrustedIssuers`, `getTrustedIssuersForClaimTopic(topic)`, `isTrustedIssuer(addr)`, `hasClaimTopic(issuer, topic)`. Reject empty topic sets and duplicate issuers.
- [x] **Task 4 — Identity registry = curated allowlist + eligibility verification (AC: 1, 2)**
  - [x] `prod/contracts/src/identity/AgentRole.sol` — `is Ownable`; `addAgent`/`removeAgent`/`isAgent`/`onlyAgent` (mirrors ERC-3643 `AgentRole`; registration is the **curated allowlist gate**).
  - [x] `prod/contracts/src/identity/interface/IIdentityRegistry.sol` and `IdentityRegistry.sol` (`is AgentRole`): constructor wires the claim-topics and trusted-issuers registries; `registerIdentity(userAddress, IIdentity, uint16 country)` / `updateIdentity` / `updateCountry` / `deleteIdentity` are `onlyAgent` (curated allowlist); `contains(addr)`, `identity(addr)`, `investorCountry(addr)`; **`isVerified(addr)`** returns true iff the address is registered AND, for **every** required claim topic, the holder's identity carries at least one non-revoked claim from an issuer trusted for that topic whose `isClaimValid` passes. Emit `IdentityRegistered`/`IdentityRemoved`/`IdentityUpdated`/`CountryUpdated`.
- [x] **Task 5 — Pin the on-chain claim-topic vocabulary to the rule-spec (AC: 1)**
  - [x] `prod/contracts/src/identity/ClaimTopics.sol` — `library ClaimTopics` exposing `uint256 internal constant ONCHAINID_KYC = uint256(keccak256("ONCHAINID_KYC"))`, with a doc comment binding it to `@rose/rule-spec` `eligibility.requiredClaimTopics = ['ONCHAINID_KYC']` and flagging Story 4.5 as the place that will DERIVE (codegen) this mapping rather than hand-pin it.
- [x] **Task 6 — Foundry tests (unit + fuzz) (AC: 2)**
  - [x] `test/identity/Identity.t.sol` — key bootstrap, `addKey`/`keyHasPurpose`/`getKeysByPurpose`, only-management gating, `addClaim`/`getClaim`/`getClaimIdsByTopic`/`removeClaim`, deterministic `claimId`.
  - [x] `test/identity/ClaimIssuer.t.sol` — issue a valid signed `ONCHAINID_KYC` claim; `isClaimValid` true for a good signature, false for a wrong-topic/tampered-data/wrong-signer/revoked claim; revocation flips validity.
  - [x] `test/identity/ClaimTopicsRegistry.t.sol` and `test/identity/TrustedIssuersRegistry.t.sol` — add/remove/duplicate-reject, owner gating, `getTrustedIssuersForClaimTopic`, `hasClaimTopic`.
  - [x] `test/identity/IdentityRegistry.t.sol` — `registerIdentity` only-agent (curated allowlist); the **end-to-end** path: register holder + issue KYC claim ⇒ `isVerified == true`; not-registered ⇒ false; registered but no claim ⇒ false; claim revoked ⇒ false; claim from a non-trusted issuer ⇒ false; a **fuzz** test over random non-agent callers proving they cannot register, and/or over random unregistered addresses proving `isVerified == false`.

## Dev Notes

### Scope discipline (what 4.1 IS and IS NOT)

- **IN scope:** the ONCHAINID identity primitive (ERC-734/735), a trusted **claim issuer**, the **claim-topics** and **trusted-issuers** registries, and the **identity registry** that doubles as the **curated allowlist** with an `isVerified` eligibility predicate. [Source: epics.md#Story 4.1; architecture.md#On-Chain Architecture "Identity/eligibility infrastructure"]
- **OUT of scope (do NOT pull forward):** enforcing eligibility on **token transfers** (Story 4.2 — there is no ERC-20/ERC-3643 token in this story), pair-coupling (4.3), Model-A principal/yield on-chain (4.4), rule-spec→on-chain **codegen/dual-plane conformance** (4.5 — 4.1 only *pins* the `ONCHAINID_KYC` topic value and documents that 4.5 will generate it), and agent powers / Sepolia **deployment** (4.6 — no `forge script` deploy in this story). [Source: epics.md#Stories 4.2–4.6]

### Architecture constraints

- **Stack (D2):** custom ERC-3643-compatible suite on **OpenZeppelin Contracts 5.6.x**, referencing **Tokeny T-REX / ERC-3643** and **ONCHAINID (ERC-734/735)** patterns; **Foundry** toolchain; target chain **Sepolia** (deploy deferred to 4.6). [Source: architecture.md#On-Chain Architecture; architecture.md#Selected Approach]
- **Foundry config is already pinned:** `prod/contracts/foundry.toml` sets `solc = "0.8.28"`, `evm_version = "cancun"`, optimizer on (200 runs). New Solidity MUST compile under `0.8.28`; use `pragma solidity ^0.8.28;`. [Source: prod/contracts/foundry.toml]
- **OZ remapping is already wired:** `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/` (OZ **5.6.1** installed) and `forge-std/=lib/forge-std/src/`. Reuse `access/Ownable.sol`, `utils/cryptography/ECDSA.sol`, `utils/cryptography/MessageHashUtils.sol`, `utils/structs/EnumerableSet.sol` — do NOT vendor your own. [Source: prod/contracts/remappings.txt; lib/openzeppelin-contracts]
- **Regime boundary:** these are PROD contracts under `prod/contracts/`. Never reference `/throwaway`. Solidity is outside the pnpm workspace and outside `tsc -b`, so no TS package wiring is needed. [Source: pnpm-workspace.yaml; architecture.md#Project Structure]
- **No money/precision surface in this story:** identities, claims, topics, and registries carry no token amounts. Where a numeric country code is stored it is a `uint16` ISO-style code, not a money value — NFR-2 (no float) is not engaged here but keep all on-chain integers as `uint*`. [Source: architecture.md#Data Architecture]
- **Default-deny posture (NFR-4) mirrored on-chain:** `isVerified` must be **fail-closed** — an unregistered address, a missing required claim, an untrusted issuer, or a revoked/invalid signature all yield `false`. No path may return `true` without a non-revoked, validly-signed claim from a trusted issuer for *every* required topic. [Source: architecture.md#Authentication & Security; rule-spec.v1.ts `defaultEffect: 'DENY'`]

### Single-source alignment with the rule-spec (load-bearing for Epic 4)

- `@rose/rule-spec` `ruleSpecV1.eligibility` is **already frozen** as the single source: `{ requireAllowlist: true, requiredClaimTopics: ['ONCHAINID_KYC'] }`. This story models the on-chain side to MATCH it: the curated allowlist == `IdentityRegistry` agent-gated registration; the required claim topic label `'ONCHAINID_KYC'` is pinned on-chain in `ClaimTopics.ONCHAINID_KYC = uint256(keccak256("ONCHAINID_KYC"))`. [Source: prod/packages/rule-spec/src/spec/rule-spec.v1.ts; prod/packages/rule-spec/src/spec/rule-spec-schema.ts `eligibilitySchema`]
- **Do NOT edit `@rose/rule-spec`** (Epic 3 is `done`). 4.1 consumes/mirrors it; **Story 4.5** is the story that introduces the rule-spec → on-chain **codegen** and the dual-plane conformance vectors. Leave a clear doc comment in `ClaimTopics.sol` so 4.5 replaces the hand-pinned constant with a generated one without ambiguity. [Source: sprint-status.yaml epic-3 done, 4-5 backlog; epics.md#Story 4.5]

### Prior-art / patterns to mirror (so you don't reinvent T-REX)

- **ONCHAINID `Identity`**: keys are stored by `bytes32 keyHash = keccak256(abi.encode(addressOrKey))` → `Key{ uint256[] purposes, uint256 keyType, bytes32 key }`. Purposes: `1 MANAGEMENT`, `2 ACTION`, `3 CLAIM`. The constructor bootstraps the owner address as a `MANAGEMENT` key. `addKey`/`removeKey` are management-gated. Claims: `claimId = keccak256(abi.encode(issuer, topic))` (so one claim per (issuer,topic)); `addClaim` requires the caller to hold a `CLAIM` key on this identity (self-managed identities may use the management key). [Source: architecture.md#On-Chain Architecture ERC-734/735 reference]
- **`ClaimIssuer.isClaimValid(identity, topic, sig, data)`** (canonical ERC-3643): `dataHash = keccak256(abi.encode(identity, topic, data))`; recover signer from the EIP-191 prefixed hash; require `keyHasPurpose(keccak256(abi.encode(signer)), CLAIM)` on the issuer AND `!isClaimRevoked(sig)`. Use OZ `ECDSA.recover` + `MessageHashUtils.toEthSignedMessageHash`. Revocation is keyed by the signature bytes (`keccak256(sig)`).
- **`IdentityRegistry.isVerified`** (canonical ERC-3643): for each topic in the claim-topics registry, scan the holder identity's `getClaimIdsByTopic(topic)`; a topic is satisfied by the FIRST claim whose issuer `isTrustedIssuer` + `hasClaimTopic(issuer,topic)` + `IClaimIssuer(issuer).isClaimValid(identity, topic, sig, data) == true`. If any required topic is unsatisfied → `false`.
- **`AgentRole`** (T-REX): `Ownable` + `mapping(address=>bool) agents` + `onlyAgent`. The registry owner adds the claim-issuer-operator address as an agent; only agents register identities — this IS the curated allowlist gate (registration presupposes off-chain KYC/AML passed). [Source: architecture.md#Authentication & Security "curated allowlist materialized as ERC-3643 ONCHAINID claims"]

### Testing standards

- **Solidity tests** live in `prod/contracts/test/**/*.t.sol`, run by `forge test` (incl. **fuzz/invariant** — NFR-6 test-first on invariants). Existing examples: `test/OpenZeppelinResolves.t.sol`, `test/Counter.t.sol`. Naming: `test_*` for unit, `testFuzz_*` for fuzz, `test_RevertWhen_*`/`vm.expectRevert` for negative paths. [Source: architecture.md#On-Chain Architecture "Solidity-native tests with fuzzing and invariant testing"; prod/contracts/test]
- **Write tests first** for the load-bearing invariant: *no `isVerified == true` without a valid trusted claim*, and *only an agent can extend the curated allowlist*. Cover the negative (fail-closed) paths explicitly — they are the security contract.
- Use forge cheatcodes: `vm.prank`/`vm.startPrank` for caller identity, `vm.expectRevert` for gated calls, and `vm.sign(privKey, hash)` with `vm.addr(privKey)` to produce real ECDSA claim signatures from a "claim issuer signing key" registered as a `CLAIM` key.
- Baseline before this story: **forge 3/3**, **Vitest 263/263**. This story adds Solidity only; the TS gates must stay 263 green and unchanged.

### Project Structure Notes

- New tree under `prod/contracts/src/identity/` (impl) and `prod/contracts/src/identity/interface/` (interfaces), tests under `prod/contracts/test/identity/`. This matches architecture's `contracts/src` ("custom ERC-3643-compatible token, compliance modules, ONCHAINID integ") and `contracts/test` ("*.t.sol — unit + fuzz + invariant"). [Source: architecture.md#Complete Project Directory Structure]
- Run `forge fmt prod/contracts/src/identity prod/contracts/test/identity` before finishing; root `prettier` does NOT cover `.sol` (its globs are ts/tsx/mjs/json/md/yml/yaml), so Solidity formatting is owned by `forge fmt`. The root `bmad-pipeline-report.md` IS prettier-checked — keep any appended markdown prettier-clean. [Source: package.json `format`/`format:check` globs]

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 / Story 4.1]
- [Source: _bmad-output/planning-artifacts/architecture.md#On-Chain Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security]
- [Source: _bmad-output/planning-artifacts/architecture.md#Off-Chain ↔ On-Chain Rule Equivalence]
- [Source: _bmad-output/planning-artifacts/architecture.md#Complete Project Directory Structure]
- [Source: prod/packages/rule-spec/src/spec/rule-spec.v1.ts (eligibility.requiredClaimTopics)]
- [Source: prod/contracts/foundry.toml; prod/contracts/remappings.txt]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- `forge build` initially failed on two NatSpec issues: `@inheritdoc IERC734/IERC735` could not resolve until `IERC734`/`IERC735` were imported into `Identity.sol` (the interface must be in scope), and the token `@rose/...` in a `///` comment was parsed as an invalid NatSpec tag — reworded to `rose/...`.
- `Identity.t.sol` first run: 3 failures (`test_AddKey_RevertWhen_*`, `test_RemoveKey_RevertWhen_*`). Root cause was a Foundry cheatcode subtlety, not a contract bug: an external getter call (`identity.CLAIM_SIGNER_KEY()`) used as a call argument consumes the immediately-preceding `vm.prank`/`vm.expectRevert`. Fixed by caching the purpose/key-type constants in `setUp` (`MGMT`/`CLAIM`/`ECDSA`) so the cheatcode applies to the intended `addKey`/`removeKey` call.
- Final: `forge test` 53/53 (3 pre-existing + 50 new); `forge fmt --check` clean on the new tree.

### Completion Notes List

- Delivered the full ONCHAINID/ERC-3643 identity + eligibility foundation under `prod/contracts/src/identity/` (7 interfaces, 6 implementation contracts incl. a `ClaimTopics` library) plus 5 Foundry test files (50 tests, incl. 2 fuzz).
- **AC-1 (register + issue claim recorded across the three registries against the curated allowlist):** met — `IdentityRegistryTest.test_RegisterIdentity_ByAgent` and `test_IsVerified_True_EndToEnd` register an ONCHAINID via the agent-gated allowlist, issue a trusted-issuer `ONCHAINID_KYC` claim, and verify the identity/claim-topics/trusted-issuers registries together yield `isVerified == true`.
- **AC-2 (Foundry tests cover registration + claim issuance, forge green):** met — registration, claim issuance/validity/revocation, both registries' CRUD + owner-gating, and the end-to-end verification path are covered; `forge test` is green.
- **Fail-closed posture (NFR-4 mirrored on-chain):** every negative branch of `isVerified` is proven false — not registered, registered-without-claim, revoked claim, untrusted issuer, issuer-not-trusted-for-topic — plus a fuzz test over random unregistered addresses and random non-agent callers.
- **Single-source alignment:** the required topic is pinned in `ClaimTopics.ONCHAINID_KYC = uint256(keccak256("ONCHAINID_KYC"))`, matching `@rose/rule-spec` `eligibility.requiredClaimTopics = ['ONCHAINID_KYC']`; a derivation note marks Story 4.5 as the owner of the rule-spec→on-chain codegen. `@rose/rule-spec` was NOT modified.
- **Scope held:** no token contract, no transfer enforcement, no pair-coupling/Model-A, no codegen, no Sepolia deploy script (all later stories). TS packages untouched — Vitest stays 263/263.

### File List

**New — Solidity contracts (`prod/contracts/src/identity/`):**

- `interface/IERC734.sol`, `interface/IERC735.sol`, `interface/IIdentity.sol`, `interface/IClaimIssuer.sol`, `interface/IClaimTopicsRegistry.sol`, `interface/ITrustedIssuersRegistry.sol`, `interface/IIdentityRegistry.sol`
- `Identity.sol`, `ClaimIssuer.sol`, `ClaimTopicsRegistry.sol`, `TrustedIssuersRegistry.sol`, `AgentRole.sol`, `IdentityRegistry.sol`, `ClaimTopics.sol`

**New — Foundry tests (`prod/contracts/test/identity/`):**

- `ClaimFixtures.sol` (shared signing helper), `Identity.t.sol`, `ClaimIssuer.t.sol`, `ClaimTopicsRegistry.t.sol`, `TrustedIssuersRegistry.t.sol`, `IdentityRegistry.t.sol`

**Modified:**

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions; epic-4 → in-progress)

## Change Log

| Date       | Version | Description                                                                                                       | Author |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-16 | 0.1     | Story drafted (create-story), ready-for-dev                                                                       | Amelia |
| 2026-06-16 | 0.2     | Implemented ONCHAINID identity + eligibility suite (13 contracts/interfaces + 6 test files, 50 forge tests); gate green; status → review | Amelia |
| 2026-06-16 | 0.3     | Code review (3 adversarial layers); patched 4 findings (+7 regression tests → 60 forge); 3 deferred, 2 dismissed; gate green; status → done    | Amelia |

## Senior Developer Review (AI)

**Reviewer:** Amelia (claude-opus-4-8[1m]) · **Date:** 2026-06-16 · **Outcome:** Approve (all High/Med resolved)

Three parallel adversarial layers were run against the diff: **Blind Hunter** (correctness, diff-only), **Edge-Case Hunter** (branch/boundary, repo read access), **Acceptance Auditor** (vs spec/epic/architecture/rule-spec). The Acceptance Auditor returned **PASS** on every AC with no scope creep and confirmed the rule-spec was left unmodified. The two adversarial layers **disagreed on a load-bearing fact** (whether OZ 5.6 `ECDSA.tryRecover(bytes32,bytes)` accepts 64-byte EIP-2098 compact signatures); this was resolved by reading the installed `lib/openzeppelin-contracts/.../ECDSA.sol` directly — it rejects any non-65-byte signature (`InvalidSignatureLength`), so the alleged revocation bypass does not exist.

### Action Items

- [x] **[High] Last-management-key brick** — `Identity.removeKey` could remove the sole MANAGEMENT key, permanently locking every management-gated method. Added a guard (`require(_keysByPurpose[MANAGEMENT_KEY].length > 1)`), matching the ONCHAINID reference. [`Identity.sol`] (+2 regression tests)
- [x] **[Med] `isVerified` not truly total** — only the issuer call was wrapped in try/catch; the holder-identity `getClaimIdsByTopic`/`getClaim` calls were not, so a hostile/buggy registered identity could make `isVerified` revert (DoS) instead of returning `false`. Wrapped all holder-identity external calls so the predicate always returns a bool. [`IdentityRegistry.sol`] (+1 regression test: reverting-identity mock)
- [x] **[Med] EOA trusted issuer** — `addTrustedIssuer` accepted a codeless address; an EOA issuer would make `isVerified` revert uncatchably. Added `require(address(issuer).code.length > 0)`. [`TrustedIssuersRegistry.sol`] (+1 regression test)
- [x] **[Low] `addKey` event/storage divergence** — for an already-registered key the stored `keyType` is kept, but the `KeyAdded` event emitted the (ignored) argument; now emits the stored type. [`Identity.sol`] (+1 regression test with `expectEmit`)
- [x] **[Coverage] Multiple competing claims for one topic** — added a test proving the valid claim is found among an untrusted one. [`IdentityRegistry.t.sol`]

### Review Findings

- [x] [Review][Defer] Empty required-topics ⇒ verified (ERC-3643 semantics) — deferred to Story 4.5 (topics seeded from rule-spec `.min(1)`); documented + behavior test pinned.
- [x] [Review][Defer] Unbounded claims-per-topic (self-griefing OOG) — deferred; revisit when `isVerified` gates transfers in 4.2; matches ERC-3643.
- [x] [Review][Defer] No EIP-1271 contract-signer issuers — fail-closed; P0 uses EOA signing key.
- [x] [Review][Dismiss] EIP-2098 revocation-bypass (Edge-Case Hunter H1) — false positive: OZ 5.6 `ECDSA.tryRecover(bytes32,bytes)` rejects non-65-byte sigs (verified in installed source).
- [x] [Review][Dismiss] `keyHasPurpose` management-implies-all vs partial purpose removal (Edge-Case Hunter M3) — by-design ONCHAINID key hierarchy.
