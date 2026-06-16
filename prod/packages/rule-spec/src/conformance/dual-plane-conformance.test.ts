import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { generateOffChainPolicy } from '../codegen/generate-off-chain-policy.js';
import { generateOnChainComplianceConfig } from '../codegen/generate-on-chain-config.js';
import { conformanceVectors } from './vectors.js';
import { makeReferenceOffChainAdapter } from './reference-off-chain-adapter.js';
import { makeReferenceOnChainAdapter } from './reference-on-chain-adapter.js';
import { assertAllConform, runConformance } from './harness.js';

// Both planes derive from the SAME single source (`ruleSpecV1`) via their respective emitters.
const offChainAdapter = makeReferenceOffChainAdapter(generateOffChainPolicy(ruleSpecV1));
const onChainAdapter = makeReferenceOnChainAdapter(generateOnChainComplianceConfig(ruleSpecV1));

describe('dual-plane conformance — on-chain plane passes the SHARED vectors', () => {
  it('every shared vector is exercised on-chain and conforms (none skipped)', () => {
    const results = runConformance(onChainAdapter, conformanceVectors);
    // Every vector is tagged for BOTH planes, so the on-chain adapter runs all of them.
    expect(results.length).toBe(conformanceVectors.length);
    expect(() => assertAllConform(onChainAdapter, results)).not.toThrow();
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it.each(conformanceVectors.map((v) => [v.id, v] as const))(
    'on-chain vector %s conforms to the expected outcome',
    (_id, vector) => {
      expect(onChainAdapter.evaluate(vector.scenario, vector.env)).toBe(vector.expected);
    },
  );
});

describe('dual-plane EQUIVALENCE — off-chain and on-chain decide identically (FR-19, SM-4)', () => {
  it.each(conformanceVectors.map((v) => [v.id, v] as const))(
    'vector %s: off-chain decision == on-chain decision',
    (_id, vector) => {
      const off = offChainAdapter.evaluate(vector.scenario, vector.env);
      const on = onChainAdapter.evaluate(vector.scenario, vector.env);
      expect(on).toBe(off);
      // ...and both equal the single shared expectation (the planes cannot silently diverge).
      expect(on).toBe(vector.expected);
    },
  );

  it('the on-chain adapter declares the ON_CHAIN plane (harness routes the shared vectors to it)', () => {
    expect(onChainAdapter.plane).toBe('ON_CHAIN');
    expect(offChainAdapter.plane).toBe('OFF_CHAIN');
  });
});
