import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { generateOffChainPolicy } from '../codegen/generate-off-chain-policy.js';
import { accountTypeCodeSchema } from '../spec/rule-spec-schema.js';
import { conformanceVectors } from './vectors.js';
import { makeReferenceOffChainAdapter } from './reference-off-chain-adapter.js';
import { assertAllConform, runConformance } from './harness.js';

const policy = generateOffChainPolicy(ruleSpecV1);
const adapter = makeReferenceOffChainAdapter(policy);

describe('single-source conformance — reference off-chain adapter', () => {
  it('the generated off-chain policy satisfies EVERY shared vector', () => {
    const results = runConformance(adapter, conformanceVectors);
    // Every off-chain-tagged vector was actually exercised.
    expect(results.length).toBe(conformanceVectors.length);
    expect(() => assertAllConform(adapter, results)).not.toThrow();
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it.each(conformanceVectors.map((v) => [v.id, v] as const))(
    'vector %s conforms',
    (_id, vector) => {
      expect(adapter.evaluate(vector.scenario, vector.env)).toBe(vector.expected);
    },
  );
});

describe('conformance vector-set integrity', () => {
  it('defines at least 10 vectors', () => {
    expect(conformanceVectors.length).toBeGreaterThanOrEqual(10);
  });

  it('represents all three outcomes (ALLOW, DENY, REFUSE)', () => {
    const outcomes = new Set(conformanceVectors.map((v) => v.expected));
    expect(outcomes.has('ALLOW')).toBe(true);
    expect(outcomes.has('DENY')).toBe(true);
    expect(outcomes.has('REFUSE')).toBe(true);
  });

  it('tags every vector for BOTH planes (off-chain and on-chain cannot diverge)', () => {
    for (const vector of conformanceVectors) {
      expect(vector.planes).toContain('OFF_CHAIN');
      expect(vector.planes).toContain('ON_CHAIN');
    }
  });

  it('every vector references in-vocabulary account-type codes', () => {
    for (const vector of conformanceVectors) {
      expect(() => accountTypeCodeSchema.parse(vector.scenario.from)).not.toThrow();
    }
  });

  it('every vector id is unique', () => {
    const ids = conformanceVectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('harness — plane filtering and failure reporting', () => {
  it('skips vectors not tagged for the adapter plane', () => {
    const onChainOnly = [
      {
        id: 'on-chain-only',
        description: 'on-chain only',
        scenario: {
          from: 'FEE_INCOME' as const,
          classification: 'NONE' as const,
          to: 'TREASURY' as const,
          assetKind: 'VALUE' as const,
        },
        env: {},
        expected: 'ALLOW' as const,
        planes: ['ON_CHAIN'] as const,
      },
    ];
    expect(runConformance(adapter, onChainOnly).length).toBe(0);
  });

  it('assertAllConform throws ConformanceFailureError on a mismatch', () => {
    const wrongVector = [
      {
        id: 'deliberately-wrong',
        description: 'expects the wrong answer',
        scenario: {
          from: 'DEPLOYED_CAPITAL' as const,
          classification: 'NONE' as const,
          to: 'EXTERNAL' as const,
          assetKind: 'VALUE' as const,
        },
        env: {},
        // Default-deny would DENY this; asserting ALLOW must fail.
        expected: 'ALLOW' as const,
        planes: ['OFF_CHAIN'] as const,
      },
    ];
    const results = runConformance(adapter, wrongVector);
    expect(() => assertAllConform(adapter, results)).toThrow(/conformance vector/);
  });
});

// Defensive reference-adapter semantics (review regressions). These are adapter UNIT cases, not
// shared cross-plane vectors, so they do not impose reference-modeling artifacts on the on-chain plane.
describe('reference adapter — fail-closed semantics (review regressions)', () => {
  it('an uncovered BACKING_FLOAT flow defaults to DENY, not a floor REFUSE (floor scoped to its rule)', () => {
    // BACKING_FLOAT → TREASURY has no allow-rule; absent floor must not leak REFUSE.
    const effect = adapter.evaluate(
      { from: 'BACKING_FLOAT', classification: 'NONE', to: 'TREASURY', assetKind: 'VALUE' },
      {},
    );
    expect(effect).toBe('DENY');
  });

  it('an absolute prohibition wins over a floor-absent REFUSE (prohibition is unconditional)', () => {
    // BACKING_FLOAT token routed through VCC with the floor config absent ⇒ DENY (not REFUSE).
    const effect = adapter.evaluate(
      {
        from: 'BACKING_FLOAT',
        classification: 'NONE',
        to: 'TREASURY',
        assetKind: 'TOKEN',
        throughVcc: true,
      },
      {},
    );
    expect(effect).toBe('DENY');
  });

  it('a floor-guarded egress with the floor present but breach UNKNOWN is denied (fail-closed)', () => {
    // Floor present, postBalanceBelowFloor undefined ⇒ not proven safe ⇒ DENY (no fail-open).
    const effect = adapter.evaluate(
      { from: 'BACKING_FLOAT', classification: 'NONE', to: 'EXTERNAL', assetKind: 'VALUE' },
      { backingFloatFloor: 1_000n },
    );
    expect(effect).toBe('DENY');
  });

  it('a floor-guarded egress proven at/above the floor is allowed', () => {
    const effect = adapter.evaluate(
      { from: 'BACKING_FLOAT', classification: 'NONE', to: 'EXTERNAL', assetKind: 'VALUE' },
      { backingFloatFloor: 1_000n, postBalanceBelowFloor: false },
    );
    expect(effect).toBe('ALLOW');
  });
});
