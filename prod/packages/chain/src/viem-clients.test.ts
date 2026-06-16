import { describe, expect, it } from 'vitest';
import {
  custom,
  encodeFunctionResult,
  toFunctionSelector,
  type Address,
  type EIP1193RequestFn,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { roseTokenAbi } from './abis/rose-token-abi.js';
import type { ChainConfig } from './chain-config.js';
import { createRoseChainClients, readTokenBalance, readTotalSupply } from './viem-clients.js';

const TOKEN: Address = '0x2222222222222222222222222222222222222222';
const HOLDER: Address = '0x5555555555555555555555555555555555555555';

// Function selectors (first 4 bytes of calldata) used to route mock eth_call responses.
const SEL_BALANCE_OF = toFunctionSelector('balanceOf(address)');
const SEL_TOTAL_SUPPLY = toFunctionSelector('totalSupply()');

/**
 * A fake EIP-1193 provider — answers exactly the JSON-RPC methods the public client issues for a
 * `readContract`, with deterministic, ABI-encoded results. NO network, NO Sepolia. This exercises
 * viem's REAL encode/decode path so the test proves typed `bigint` results with ABI inference.
 */
function mockProvider(balances: { balanceOf?: bigint; totalSupply?: bigint }): {
  request: EIP1193RequestFn;
} {
  const request = (async ({ method, params }) => {
    if (method === 'eth_chainId') return `0x${sepolia.id.toString(16)}` as Hex;
    if (method === 'eth_call') {
      const call = (params as [{ data: Hex }, unknown])[0];
      const selector = call.data.slice(0, 10) as Hex;
      if (selector === SEL_BALANCE_OF) {
        return encodeFunctionResult({
          abi: roseTokenAbi,
          functionName: 'balanceOf',
          result: balances.balanceOf ?? 0n,
        });
      }
      if (selector === SEL_TOTAL_SUPPLY) {
        return encodeFunctionResult({
          abi: roseTokenAbi,
          functionName: 'totalSupply',
          result: balances.totalSupply ?? 0n,
        });
      }
      throw new Error(`unexpected eth_call selector ${selector}`);
    }
    throw new Error(`unexpected RPC method ${method}`);
  }) as EIP1193RequestFn;
  return { request };
}

function chainConfig(): ChainConfig {
  return {
    sepoliaRpcUrl: 'http://127.0.0.1:8545',
    pairAddress: '0x1111111111111111111111111111111111111111',
    lTokenAddress: TOKEN,
    sTokenAddress: '0x3333333333333333333333333333333333333333',
    identityRegistryAddress: '0x4444444444444444444444444444444444444444',
  };
}

function clientsWith(balances: { balanceOf?: bigint; totalSupply?: bigint }) {
  return createRoseChainClients(chainConfig(), {
    transport: custom(mockProvider(balances)),
  });
}

describe('createRoseChainClients (AC-1)', () => {
  it('builds a public client on the Sepolia chain with the injected transport', () => {
    const clients = clientsWith({});
    expect(clients.publicClient.chain?.id).toBe(sepolia.id);
    expect(typeof clients.getWalletClient).toBe('function');
    expect(clients.config.lTokenAddress).toBe(TOKEN);
  });
});

describe('typed reads with ABI inference (AC-1, NFR-2 bigint)', () => {
  it('readTokenBalance returns the typed bigint balance', async () => {
    const clients = clientsWith({ balanceOf: 1_000_000_000_000_000_000n });
    const balance = await readTokenBalance(clients, TOKEN, HOLDER);
    expect(balance).toBe(1_000_000_000_000_000_000n);
    expect(typeof balance).toBe('bigint');
  });

  it('readTotalSupply returns the typed bigint supply', async () => {
    const clients = clientsWith({ totalSupply: 42n });
    const supply = await readTotalSupply(clients, TOKEN);
    expect(supply).toBe(42n);
    expect(typeof supply).toBe('bigint');
  });

  it('reads zero without coercing to a JS number', async () => {
    const clients = clientsWith({ balanceOf: 0n });
    const balance = await readTokenBalance(clients, TOKEN, HOLDER);
    expect(balance).toBe(0n);
    expect(typeof balance).toBe('bigint');
  });
});
