import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { ruleSpecSchema, type RuleSpec } from '../spec/rule-spec-schema.js';
import { generateOnChainSolidityConfig } from './generate-on-chain-solidity.js';

describe('generateOnChainSolidityConfig — generated library source', () => {
  it('is deterministic (byte-identical across regenerations)', () => {
    expect(generateOnChainSolidityConfig(ruleSpecV1)).toBe(
      generateOnChainSolidityConfig(ruleSpecV1),
    );
  });

  it('materializes the P0 topic as a keccak-derived constant + seeding helper', () => {
    const sol = generateOnChainSolidityConfig(ruleSpecV1);
    expect(sol).toContain(
      'uint256 internal constant ONCHAINID_KYC = uint256(keccak256("ONCHAINID_KYC"));',
    );
    expect(sol).toContain('topics = new uint256[](1);');
    expect(sol).toContain('topics[0] = ONCHAINID_KYC;');
    expect(sol).toContain('function seedClaimTopics(ClaimTopicsRegistry registry) internal');
    expect(sol).toContain('bool internal constant REQUIRE_ALLOWLIST = true;');
  });

  // Coverage lock (review, Edge-Case): the multi-topic path (N>1 constants + an N-element array
  // with N assignments) is not reachable from the P0 spec, so guard it against a future second
  // required topic. Uses an EVM-identifier-safe second label.
  it('emits one constant + one assignment per required topic, with a correctly sized array (N>1)', () => {
    const twoTopics: RuleSpec = ruleSpecSchema.parse({
      ...ruleSpecV1,
      eligibility: {
        requireAllowlist: true,
        requiredClaimTopics: ['ONCHAINID_KYC', 'ACCREDITED_INVESTOR'],
      },
    });
    const sol = generateOnChainSolidityConfig(twoTopics);

    expect(sol).toContain(
      'uint256 internal constant ONCHAINID_KYC = uint256(keccak256("ONCHAINID_KYC"));',
    );
    expect(sol).toContain(
      'uint256 internal constant ACCREDITED_INVESTOR = uint256(keccak256("ACCREDITED_INVESTOR"));',
    );
    expect(sol).toContain('topics = new uint256[](2);');
    expect(sol).toContain('topics[0] = ONCHAINID_KYC;');
    expect(sol).toContain('topics[1] = ACCREDITED_INVESTOR;');
  });

  it('throws on a claim-topic label that is not EVM-identifier-safe', () => {
    const bad: RuleSpec = ruleSpecSchema.parse({
      ...ruleSpecV1,
      eligibility: { requireAllowlist: true, requiredClaimTopics: ['lower_case'] },
    });
    expect(() => generateOnChainSolidityConfig(bad)).toThrow(/EVM-identifier-safe/);
  });
});
