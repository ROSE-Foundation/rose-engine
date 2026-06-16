// @rose/rule-spec — codegen artifact path (Story 3.1). Side-effect-free so it can be imported
// by both the CLI and the drift test without triggering a file write.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Absolute path of the committed generated off-chain policy artifact. */
export const GENERATED_OFF_CHAIN_POLICY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'generated',
  'off-chain-policy.generated.json',
);
