import { describe, expect, it } from 'vitest';
import * as ruleSpec from './index.js';

// Guards the public surface so Story 3.4 / Epic 4 consumers have a complete barrel.
describe('@rose/rule-spec public surface', () => {
  it('exports the package identifier', () => {
    expect(ruleSpec.RULE_SPEC_PACKAGE_NAME).toBe('@rose/rule-spec');
  });

  it('exports the spec, loader, and refusal error', () => {
    expect(ruleSpec.ruleSpecV1).toBeDefined();
    expect(typeof ruleSpec.loadRuleSpec).toBe('function');
    expect(ruleSpec.RuleSpecValidationError).toBeDefined();
    expect(ruleSpec.RULE_SPEC_VERSION).toBe('1.0.0');
  });

  it('exports the codegen entry point (consumers generate in-memory, not via a file path)', () => {
    expect(typeof ruleSpec.generateOffChainPolicy).toBe('function');
    expect(typeof ruleSpec.serializeArtifact).toBe('function');
    // The generated-artifact file PATH is intentionally NOT part of the public surface — it
    // resolves relative to the running module and is not copied into dist by tsc.
    expect('GENERATED_OFF_CHAIN_POLICY_PATH' in ruleSpec).toBe(false);
  });

  it('exports the conformance harness, vectors, and reference adapter', () => {
    expect(Array.isArray(ruleSpec.conformanceVectors)).toBe(true);
    expect(typeof ruleSpec.runConformance).toBe('function');
    expect(typeof ruleSpec.assertAllConform).toBe('function');
    expect(typeof ruleSpec.makeReferenceOffChainAdapter).toBe('function');
    expect(ruleSpec.ConformanceFailureError).toBeDefined();
  });

  it('the exported spec passes its own loader and conformance baseline', () => {
    const spec = ruleSpec.loadRuleSpec(ruleSpec.ruleSpecV1);
    const adapter = ruleSpec.makeReferenceOffChainAdapter(ruleSpec.generateOffChainPolicy(spec));
    const results = ruleSpec.runConformance(adapter, ruleSpec.conformanceVectors);
    expect(() => ruleSpec.assertAllConform(adapter, results)).not.toThrow();
  });
});
