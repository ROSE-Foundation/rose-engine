// Typed, fail-closed chain configuration (Story 5.1, NFR-4, §11.2, refuse-if-absent).
// Mirrors the `@rose/config` parked-parameter loader pattern: a Zod schema with NO `.default(...)`,
// a refusal error that names EVERY offending key, env keys derived from the schema so they cannot
// drift, and a frozen typed result. These keys are chain-specific (the RPC endpoint + the deployed
// epic-4 contract addresses) and deliberately live here, NOT in the parked-parameter schema.
//
// SECURITY: there is no default RPC URL, no placeholder address, and no private key here. Absence
// is a REFUSAL, never a permissive default. The deployer/transfer-agent keys are handled OUT OF
// BAND (Story 4.6) and never read by this loader.

import { z } from 'zod';
import { isAddress, getAddress, zeroAddress, type Address } from 'viem';

// A non-empty http(s) URL string. No coercion, no default.
const httpUrl = z
  .string()
  .trim()
  .min(1, 'required')
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

// A 20-byte EVM address. viem's `isAddress` rejects malformed/short/non-hex values; the result is
// normalized to its EIP-55 checksum form so downstream comparisons are canonical. The zero address
// is rejected explicitly — it is the canonical "placeholder" address and a deployed ROSE contract
// can never legitimately live there (refuse-if-absent: no placeholder address).
const evmAddress = z
  .string()
  .trim()
  .min(1, 'required')
  .refine(
    (value) => isAddress(value) && value.toLowerCase() !== zeroAddress,
    'must be a non-zero 20-byte EVM address',
  );

const ChainConfigSchema = z.object({
  SEPOLIA_RPC_URL: httpUrl,
  ROSE_PAIR_ADDRESS: evmAddress,
  ROSE_L_TOKEN_ADDRESS: evmAddress,
  ROSE_S_TOKEN_ADDRESS: evmAddress,
  ROSE_IDENTITY_REGISTRY_ADDRESS: evmAddress,
});

/** Env keys for the chain config — derived from the schema so they cannot drift. */
export type ChainConfigKey = keyof z.infer<typeof ChainConfigSchema>;
export const CHAIN_CONFIG_KEYS = Object.keys(ChainConfigSchema.shape) as ChainConfigKey[];

/** The validated, typed chain config consumed by the viem clients/watchers. */
export interface ChainConfig {
  /** Sepolia JSON-RPC endpoint. Required — refuse-if-absent (no default). */
  readonly sepoliaRpcUrl: string;
  /** Deployed `CoupledPair` address (watch source for PairMinted/PairBurned). */
  readonly pairAddress: Address;
  /** Deployed long-leg `RoseToken` address. */
  readonly lTokenAddress: Address;
  /** Deployed short-leg `RoseToken` address. */
  readonly sTokenAddress: Address;
  /** Deployed `IdentityRegistry` address. */
  readonly identityRegistryAddress: Address;
}

// Maps each (schema-derived) env key to its camelCase config field. `Record<ChainConfigKey,…>` is
// exhaustive: adding a key to the schema without mapping it here fails typecheck.
const KEY_TO_FIELD: Record<ChainConfigKey, keyof ChainConfig> = {
  SEPOLIA_RPC_URL: 'sepoliaRpcUrl',
  ROSE_PAIR_ADDRESS: 'pairAddress',
  ROSE_L_TOKEN_ADDRESS: 'lTokenAddress',
  ROSE_S_TOKEN_ADDRESS: 'sTokenAddress',
  ROSE_IDENTITY_REGISTRY_ADDRESS: 'identityRegistryAddress',
};

const ADDRESS_FIELDS = new Set<keyof ChainConfig>([
  'pairAddress',
  'lTokenAddress',
  'sTokenAddress',
  'identityRegistryAddress',
]);

/** Thrown when one or more chain config keys are absent or invalid — fail-closed (NFR-4). */
export class ChainConfigRefusalError extends Error {
  readonly missingOrInvalid: readonly string[];
  constructor(keys: readonly string[]) {
    super(
      `Refusing to start the chain package: missing or invalid configuration key(s): ${keys.join(
        ', ',
      )}. The Sepolia RPC URL and contract addresses must be configured explicitly and are never ` +
        `defaulted (NFR-4, §11.2). No placeholder RPC or address is ever substituted.`,
    );
    this.name = 'ChainConfigRefusalError';
    this.missingOrInvalid = keys;
  }
}

/**
 * Loads and validates the chain configuration from `env` (default `process.env`). Returns a typed,
 * frozen config on success; throws `ChainConfigRefusalError` naming every offending key on any
 * absence/invalidity. Never substitutes a default for an absent value. Addresses are returned in
 * EIP-55 checksum form.
 */
export function loadChainConfig(
  env: Record<string, string | undefined> = process.env,
): ChainConfig {
  if (env === null || typeof env !== 'object') {
    throw new ChainConfigRefusalError([...CHAIN_CONFIG_KEYS].sort());
  }
  const result = ChainConfigSchema.safeParse(env);
  if (!result.success) {
    const named = [
      ...new Set(
        result.error.issues
          .map((issue) => String(issue.path[0]))
          .filter((key) => key !== 'undefined'),
      ),
    ].sort();
    throw new ChainConfigRefusalError(named.length > 0 ? named : [...CHAIN_CONFIG_KEYS].sort());
  }
  const v = result.data;
  const out: Record<string, string> = {};
  for (const key of CHAIN_CONFIG_KEYS) {
    const field = KEY_TO_FIELD[key];
    const raw = v[key].trim();
    // Normalize addresses to their canonical EIP-55 checksum; leave the URL as-is.
    out[field] = ADDRESS_FIELDS.has(field) ? getAddress(raw) : raw;
  }
  return Object.freeze(out) as unknown as ChainConfig;
}
