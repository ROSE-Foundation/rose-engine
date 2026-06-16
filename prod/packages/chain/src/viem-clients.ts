// Typed viem clients for the ROSE chain boundary (Story 5.1, NFR-9 foundation, viem 2.52).
// This is the ONLY module that opens a connection to Sepolia (architecture "Chain boundary": the
// `chain` package is the only module talking to Sepolia). It provides a typed public client for
// reads + a wallet-client factory SEAM for the mint/burn writes of Stories 5.3/5.4 (no signing,
// no private key handling here). All on-chain amounts are `uint256` → TS `bigint` (NFR-2: never
// `number`/float).

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { roseTokenAbi } from './abis/rose-token-abi.js';
import type { ChainConfig } from './chain-config.js';

/**
 * Optional overrides — primarily an injectable `transport` so tests run LOCALLY against a mock
 * EIP-1193 provider (or Anvil) instead of real Sepolia. In production the default `http(rpcUrl)`
 * transport is used and no override is supplied.
 */
export interface RoseChainClientOptions {
  /** Injected transport for local tests (mock EIP-1193 / Anvil). Defaults to `http(rpcUrl)`. */
  readonly transport?: Transport;
  /**
   * Event-watch polling interval in ms. Defaults to viem's chain default. Exposed so local tests
   * can poll quickly against a mock transport; production leaves it at the default.
   */
  readonly pollingInterval?: number;
}

/**
 * The typed clients bundle for the ROSE chain boundary.
 * - `publicClient` — reads + event watching (Sepolia chain, typed via the contract ABIs).
 * - `getWalletClient(account)` — factory seam for write txs (5.3/5.4). The caller supplies the
 *   `Account`; this package never holds or derives a private key.
 * - `config` — the validated chain config the clients were built from (addresses for callers).
 */
export interface RoseChainClients {
  readonly publicClient: PublicClient;
  readonly getWalletClient: (account: Account) => WalletClient;
  readonly config: ChainConfig;
}

/**
 * Builds the typed viem clients from a validated `ChainConfig`. The transport defaults to
 * `http(config.sepoliaRpcUrl)`; pass `opts.transport` to inject a local/mock transport in tests.
 * Refuse-if-absent is enforced upstream by `loadChainConfig` — by the time a `ChainConfig` exists,
 * the RPC URL and addresses are present and valid.
 */
export function createRoseChainClients(
  config: ChainConfig,
  opts: RoseChainClientOptions = {},
): RoseChainClients {
  const transport = opts.transport ?? http(config.sepoliaRpcUrl);

  const publicClient = createPublicClient({
    chain: sepolia,
    transport,
    ...(opts.pollingInterval !== undefined ? { pollingInterval: opts.pollingInterval } : {}),
  });

  const getWalletClient = (account: Account): WalletClient =>
    createWalletClient({ account, chain: sepolia, transport });

  return Object.freeze({ publicClient, getWalletClient, config });
}

/**
 * Reads an ERC-3643 token balance for `account`. Returns the raw integer balance as `bigint`
 * (NFR-2). Typed via the `roseTokenAbi` (ABI inference → `bigint` return).
 */
export async function readTokenBalance(
  clients: RoseChainClients,
  tokenAddress: Address,
  account: Address,
): Promise<bigint> {
  return clients.publicClient.readContract({
    address: tokenAddress,
    abi: roseTokenAbi,
    functionName: 'balanceOf',
    args: [account],
  });
}

/** Reads a token's total supply as `bigint` (NFR-2). Typed via the `roseTokenAbi`. */
export async function readTotalSupply(
  clients: RoseChainClients,
  tokenAddress: Address,
): Promise<bigint> {
  return clients.publicClient.readContract({
    address: tokenAddress,
    abi: roseTokenAbi,
    functionName: 'totalSupply',
    args: [],
  });
}
