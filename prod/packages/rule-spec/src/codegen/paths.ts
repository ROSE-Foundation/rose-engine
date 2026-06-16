// @rose/rule-spec — codegen artifact path (Story 3.1). Side-effect-free so it can be imported
// by both the CLI and the drift test without triggering a file write.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the committed generated off-chain policy artifact. */
export const GENERATED_OFF_CHAIN_POLICY_PATH = join(
  HERE,
  'generated',
  'off-chain-policy.generated.json',
);

/** Absolute path of the committed generated on-chain compliance config artifact (Story 4.5). */
export const GENERATED_ON_CHAIN_CONFIG_PATH = join(
  HERE,
  'generated',
  'on-chain-compliance.generated.json',
);

/**
 * Absolute path of the committed GENERATED Solidity compliance library (Story 4.5). It lives in
 * the Foundry project tree, not this package: from `<...>/rule-spec/{src,dist}/codegen`, four
 * levels up reaches `prod/`, then `contracts/src/generated/GeneratedComplianceConfig.sol`. The
 * `{src,dist}/codegen` depth is identical, so this resolves correctly under both `tsx` and the
 * built `dist`.
 */
export const GENERATED_ON_CHAIN_SOLIDITY_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'src',
  'generated',
  'GeneratedComplianceConfig.sol',
);
