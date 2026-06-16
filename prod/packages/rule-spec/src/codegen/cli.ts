// @rose/rule-spec — codegen CLI (Story 3.1). Run with `pnpm --filter @rose/rule-spec generate`.
//
// Emits the off-chain policy artifact to `generated/off-chain-policy.generated.json`. This is
// the consumable hand-off to Story 3.4 (off-chain provider) and the analogue Epic 4 will add
// for the on-chain plane. The file is GENERATED — never hand-edit it; a drift test re-derives
// it from the spec and fails on any divergence (AC-2: rules are not hand-edited per-plane).
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ruleSpecV1 } from '../spec/rule-spec.v1.js';
import { generateOffChainPolicy, serializeArtifact } from './generate-off-chain-policy.js';
import { GENERATED_OFF_CHAIN_POLICY_PATH } from './paths.js';

/** Generate the artifact and write it to disk. */
export function emitOffChainPolicy(): void {
  const artifact = generateOffChainPolicy(ruleSpecV1);
  writeFileSync(GENERATED_OFF_CHAIN_POLICY_PATH, serializeArtifact(artifact), 'utf8');
  console.log(`Generated off-chain policy artifact -> ${GENERATED_OFF_CHAIN_POLICY_PATH}`);
}

// Run only when invoked directly as a script (not when imported).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  emitOffChainPolicy();
}
