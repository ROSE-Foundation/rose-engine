import { describe, expect, it, vi } from 'vitest';
import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type EIP1193RequestFn,
  type Hex,
  type RpcLog,
} from 'viem';
import { sepolia } from 'viem/chains';
import { coupledPairAbi } from './abis/coupled-pair-abi.js';
import { roseTokenAbi } from './abis/rose-token-abi.js';
import type { ChainConfig } from './chain-config.js';
import { createRoseChainClients } from './viem-clients.js';
import {
  getPastPairEvents,
  watchPairEvents,
  watchTokenTransfers,
  type PairBurnedEvent,
  type PairMintedEvent,
  type TransferEvent,
} from './watchers.js';

const PAIR: Address = '0x1111111111111111111111111111111111111111';
const TOKEN: Address = '0x2222222222222222222222222222222222222222';
const ALICE: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BOB: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const TX: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000def';
const BLOCK_HASH: Hex = '0xdeadbeef00000000000000000000000000000000000000000000000000000000';

/** Builds a raw RPC log (hex-encoded) for an event, as a node would return from eth_getLogs. */
function rawLog(params: {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
}): RpcLog {
  return {
    address: params.address,
    topics: params.topics as [Hex, ...Hex[]],
    data: params.data,
    blockHash: BLOCK_HASH,
    blockNumber: `0x${params.blockNumber.toString(16)}`,
    transactionHash: TX,
    transactionIndex: '0x0',
    logIndex: `0x${params.logIndex.toString(16)}`,
    removed: false,
  };
}

function pairMintedLog(lTo: Address, sTo: Address, amount: bigint, logIndex = 0): RpcLog {
  const topics = encodeEventTopics({
    abi: coupledPairAbi,
    eventName: 'PairMinted',
    args: { lTo, sTo },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount]);
  return rawLog({ address: PAIR, topics, data, blockNumber: 101n, logIndex });
}

function pairBurnedLog(lFrom: Address, sFrom: Address, amount: bigint, logIndex = 0): RpcLog {
  const topics = encodeEventTopics({
    abi: coupledPairAbi,
    eventName: 'PairBurned',
    args: { lFrom, sFrom },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount]);
  return rawLog({ address: PAIR, topics, data, blockNumber: 101n, logIndex });
}

function transferLog(from: Address, to: Address, value: bigint, logIndex = 0): RpcLog {
  const topics = encodeEventTopics({
    abi: roseTokenAbi,
    eventName: 'Transfer',
    args: { from, to },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: 'uint256' }], [value]);
  return rawLog({ address: TOKEN, topics, data, blockNumber: 101n, logIndex });
}

/**
 * A fake EIP-1193 provider for the poll-based watcher path: `eth_newFilter` is unsupported, so
 * viem falls back to `eth_getLogs` polling between advancing block numbers. The provided logs are
 * delivered exactly once. NO network, NO Sepolia.
 */
function mockLogProvider(logs: RpcLog[]): { request: EIP1193RequestFn } {
  let block = 100n;
  let delivered = false;
  const request = (async ({ method }) => {
    if (method === 'eth_chainId') return `0x${sepolia.id.toString(16)}` as Hex;
    if (method === 'eth_newFilter' || method === 'eth_newBlockFilter') {
      throw new Error('the method eth_newFilter does not exist/is not available');
    }
    if (method === 'eth_uninstallFilter') return true;
    if (method === 'eth_blockNumber') {
      block += 1n;
      return `0x${block.toString(16)}` as Hex;
    }
    if (method === 'eth_getLogs') {
      if (delivered) return [];
      delivered = true;
      return logs;
    }
    throw new Error(`unexpected RPC method ${method}`);
  }) as EIP1193RequestFn;
  return { request };
}

function chainConfig(): ChainConfig {
  return {
    sepoliaRpcUrl: 'http://127.0.0.1:8545',
    pairAddress: PAIR,
    lTokenAddress: TOKEN,
    sTokenAddress: '0x3333333333333333333333333333333333333333',
    identityRegistryAddress: '0x4444444444444444444444444444444444444444',
  };
}

function clientsWith(logs: RpcLog[]) {
  return createRoseChainClients(chainConfig(), {
    transport: custom(mockLogProvider(logs)),
    pollingInterval: 5,
  });
}

describe('watchPairEvents (AC-2)', () => {
  it('delivers a typed, decoded PairMinted envelope to the callback', async () => {
    const clients = clientsWith([pairMintedLog(ALICE, BOB, 5n)]);
    const received: PairMintedEvent[] = [];
    const unwatch = watchPairEvents(clients, {
      pairAddress: PAIR,
      onPairMinted: (e) => received.push(e),
    });
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000, interval: 10 });
    unwatch();

    const e = received[0]!;
    expect(e.eventName).toBe('PairMinted');
    expect(e.args.lTo.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(e.args.sTo.toLowerCase()).toBe(BOB.toLowerCase());
    expect(e.args.amount).toBe(5n);
    expect(typeof e.args.amount).toBe('bigint');
    expect(e.transactionHash).toBe(TX);
    expect(e.blockNumber).toBe(101n);
    expect(e.logIndex).toBe(0);
    expect(e.address.toLowerCase()).toBe(PAIR.toLowerCase());
  });

  it('delivers a typed, decoded PairBurned envelope to the callback', async () => {
    const clients = clientsWith([pairBurnedLog(ALICE, BOB, 7n)]);
    const received: PairBurnedEvent[] = [];
    const unwatch = watchPairEvents(clients, {
      pairAddress: PAIR,
      onPairBurned: (e) => received.push(e),
    });
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000, interval: 10 });
    unwatch();

    const e = received[0]!;
    expect(e.eventName).toBe('PairBurned');
    expect(e.args.lFrom.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(e.args.sFrom.toLowerCase()).toBe(BOB.toLowerCase());
    expect(e.args.amount).toBe(7n);
  });

  it('returns a teardown that stops watching', async () => {
    const clients = clientsWith([]);
    const unwatch = watchPairEvents(clients, { pairAddress: PAIR, onPairMinted: () => {} });
    expect(typeof unwatch).toBe('function');
    expect(() => unwatch()).not.toThrow();
  });
});

describe('watchTokenTransfers (AC-2)', () => {
  it('delivers a typed, decoded Transfer envelope to the callback', async () => {
    const clients = clientsWith([transferLog(ALICE, BOB, 1_000n)]);
    const received: TransferEvent[] = [];
    const unwatch = watchTokenTransfers(clients, {
      tokenAddress: TOKEN,
      onTransfer: (e) => received.push(e),
    });
    await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 2000, interval: 10 });
    unwatch();

    const e = received[0]!;
    expect(e.eventName).toBe('Transfer');
    expect(e.args.from.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(e.args.to.toLowerCase()).toBe(BOB.toLowerCase());
    expect(e.args.value).toBe(1_000n);
  });
});

describe('getPastPairEvents (AC-2 backfill)', () => {
  it('returns typed envelopes for past PairMinted/PairBurned logs', async () => {
    const clients = clientsWith([
      pairMintedLog(ALICE, BOB, 5n, 0),
      pairBurnedLog(ALICE, BOB, 3n, 1),
    ]);
    const events = await getPastPairEvents(clients, {
      pairAddress: PAIR,
      fromBlock: 0n,
      toBlock: 200n,
    });
    expect(events.map((e) => e.eventName)).toEqual(['PairMinted', 'PairBurned']);
    expect(events[0]!.args.amount).toBe(5n);
    expect(events[1]!.args.amount).toBe(3n);
  });
});

describe('confirmed-log filtering + address checksum (review patches)', () => {
  // A PairMinted raw log with field overrides, used to forge pending / reorg-removed / mixed-case
  // address logs the way a node would return them.
  function pairMintedRaw(overrides: Partial<RpcLog> = {}): RpcLog {
    const base = pairMintedLog(ALICE, BOB, 5n, 0);
    return { ...base, ...overrides };
  }

  it('skips a pending log (blockNumber null) — not a confirmed event', async () => {
    const clients = clientsWith([pairMintedRaw({ blockNumber: null })]);
    const events = await getPastPairEvents(clients, {
      pairAddress: PAIR,
      fromBlock: 0n,
      toBlock: 200n,
    });
    expect(events).toEqual([]);
  });

  it('skips a reorg-removed log (removed true) — not a confirmed event', async () => {
    const clients = clientsWith([pairMintedRaw({ removed: true })]);
    const events = await getPastPairEvents(clients, {
      pairAddress: PAIR,
      fromBlock: 0n,
      toBlock: 200n,
    });
    expect(events).toEqual([]);
  });

  it('normalizes the envelope address to EIP-55 (matches a checksummed config address)', async () => {
    // The node returns log addresses lowercased; the envelope must checksum them so that a 5.2
    // `event.address === config.pairAddress` comparison succeeds. Use a letter-bearing address.
    const lowerPair = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;
    const clients = clientsWith([pairMintedRaw({ address: lowerPair })]);
    const events = await getPastPairEvents(clients, {
      pairAddress: PAIR,
      fromBlock: 0n,
      toBlock: 200n,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.address).toBe(getAddress(lowerPair));
    expect(events[0]!.address).not.toBe(lowerPair);
  });
});
