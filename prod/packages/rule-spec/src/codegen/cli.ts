// @rose/rule-spec — codegen CLI (Story 3.1, extended Story 4.5).
//
// Emits BOTH plane artifacts from the SAME `ruleSpecV1`:
//   - off-chain policy artifact  -> `generated/off-chain-policy.generated.json`        (Story 3.1)
//   - on-chain compliance config -> `generated/on-chain-compliance.generated.json`     (Story 4.5)
//   - on-chain Solidity library  -> `prod/contracts/src/generated/GeneratedComplianceConfig.sol`
// All are GENERATED — never hand-edit them; drift tests re-derive each from the spec and fail on any
// divergence (rules are not hand-edited per-plane; FR-19). Run with `pnpm --filter @rose/rule-spec generate`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { generateOffChainPolicy, serializeArtifact } from './generate-off-chain-policy.js';
import {
  generateOnChainComplianceConfig,
  serializeOnChainConfig,
} from './generate-on-chain-config.js';
import { generateOnChainSolidityConfig } from './generate-on-chain-solidity.js';
import {
  GENERATED_OFF_CHAIN_POLICY_PATH,
  GENERATED_ON_CHAIN_CONFIG_PATH,
  GENERATED_ON_CHAIN_SOLIDITY_PATH,
} from './paths.js';

/** Generate the off-chain policy artifact and write it to disk. */
export function emitOffChainPolicy(): void {
  const artifact = generateOffChainPolicy(ruleSpecV1);
  writeFileSync(GENERATED_OFF_CHAIN_POLICY_PATH, serializeArtifact(artifact), 'utf8');
  console.log(`Generated off-chain policy artifact -> ${GENERATED_OFF_CHAIN_POLICY_PATH}`);
}

/** Generate the on-chain compliance config (JSON) + the generated Solidity library, and write both. */
export function emitOnChainConfig(): void {
  const config = generateOnChainComplianceConfig(ruleSpecV1);
  writeFileSync(GENERATED_ON_CHAIN_CONFIG_PATH, serializeOnChainConfig(config), 'utf8');
  console.log(`Generated on-chain compliance config -> ${GENERATED_ON_CHAIN_CONFIG_PATH}`);

  mkdirSync(dirname(GENERATED_ON_CHAIN_SOLIDITY_PATH), { recursive: true });
  writeFileSync(
    GENERATED_ON_CHAIN_SOLIDITY_PATH,
    generateOnChainSolidityConfig(ruleSpecV1),
    'utf8',
  );
  console.log(`Generated on-chain Solidity library -> ${GENERATED_ON_CHAIN_SOLIDITY_PATH}`);
}

/** Emit every generated artifact for both planes. */
export function emitAll(): void {
  emitOffChainPolicy();
  emitOnChainConfig();
}

// Run only when invoked directly as a script (not when imported).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  emitAll();
}
