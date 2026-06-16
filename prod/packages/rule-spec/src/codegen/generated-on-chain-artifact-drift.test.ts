import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import {
  generateOnChainComplianceConfig,
  serializeOnChainConfig,
} from './generate-on-chain-config.js';
import { generateOnChainSolidityConfig } from './generate-on-chain-solidity.js';
import { GENERATED_ON_CHAIN_CONFIG_PATH, GENERATED_ON_CHAIN_SOLIDITY_PATH } from './paths.js';

// AC-1 guard: the committed on-chain artifacts must equal a fresh regeneration from the spec. If
// either fails, re-run `pnpm --filter @rose/rule-spec generate` — NEVER hand-edit the artifacts.
describe('generated on-chain config artifact — drift guard', () => {
  it('committed JSON is byte-identical to regenerating from the spec', () => {
    const onDisk = readFileSync(GENERATED_ON_CHAIN_CONFIG_PATH, 'utf8');
    const regenerated = serializeOnChainConfig(generateOnChainComplianceConfig(ruleSpecV1));
    expect(onDisk).toBe(regenerated);
  });

  it('committed JSON parses to the same object as the in-memory generation', () => {
    const onDisk = JSON.parse(readFileSync(GENERATED_ON_CHAIN_CONFIG_PATH, 'utf8')) as unknown;
    expect(onDisk).toEqual(generateOnChainComplianceConfig(ruleSpecV1));
  });
});

describe('generated on-chain Solidity library — drift guard', () => {
  it('committed GeneratedComplianceConfig.sol is byte-identical to regenerating from the spec', () => {
    const onDisk = readFileSync(GENERATED_ON_CHAIN_SOLIDITY_PATH, 'utf8');
    expect(onDisk).toBe(generateOnChainSolidityConfig(ruleSpecV1));
  });

  it('the generated Solidity materializes the SAME topic labels as the JSON config (one source)', () => {
    const sol = readFileSync(GENERATED_ON_CHAIN_SOLIDITY_PATH, 'utf8');
    const config = generateOnChainComplianceConfig(ruleSpecV1);
    for (const topic of config.eligibility.requiredClaimTopics) {
      // The label is the single-sourced input; the EVM materializes uint256(keccak256(label)).
      expect(sol).toContain(
        `uint256 internal constant ${topic.label} = uint256(keccak256("${topic.label}"));`,
      );
    }
  });
});
