import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { generateOffChainPolicy, serializeArtifact } from './generate-off-chain-policy.js';
import { GENERATED_OFF_CHAIN_POLICY_PATH } from './paths.js';

// AC-2 guard: the committed generated artifact must equal a fresh regeneration from the spec.
// If this fails, re-run `pnpm --filter @rose/rule-spec generate` — NEVER hand-edit the artifact.
describe('generated off-chain policy artifact — drift guard', () => {
  it('committed JSON is byte-identical to regenerating from the spec', () => {
    const onDisk = readFileSync(GENERATED_OFF_CHAIN_POLICY_PATH, 'utf8');
    const regenerated = serializeArtifact(generateOffChainPolicy(ruleSpecV1));
    expect(onDisk).toBe(regenerated);
  });

  it('committed JSON parses to the same object as the in-memory generation', () => {
    const onDisk = JSON.parse(readFileSync(GENERATED_OFF_CHAIN_POLICY_PATH, 'utf8')) as unknown;
    expect(onDisk).toEqual(generateOffChainPolicy(ruleSpecV1));
  });
});
