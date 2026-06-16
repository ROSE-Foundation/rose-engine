// Typed chain-event watchers for the ROSE contracts (Story 5.1, NFR-9 foundation).
// These observe the epic-4 contract events and hand each confirmed, decoded event to a callback
// as a stable typed `ChainEvent` envelope. That envelope (event name + decoded args + block /
// tx-hash / log-index coordinates) is exactly what Story 5.2 will persist into `outbox_events`
// and what reconcile (5.6) consumes — the on-chain tx hash is carried for the journal entry
// (NFR-3). This story delivers ONLY the watcher + typed surface; it does NOT persist anything.
//
// Amounts are `uint256` → `bigint` (NFR-2). Watching uses viem's `watchContractEvent` against the
// public client built by `createRoseChainClients`, so it works identically against real Sepolia,
// Anvil, or a mock EIP-1193 transport (local tests).

import { getAddress, type Address, type Hex, type Log } from 'viem';
import { coupledPairAbi } from './abis/coupled-pair-abi.js';
import { roseTokenAbi } from './abis/rose-token-abi.js';
import type { RoseChainClients } from './viem-clients.js';

/** Decoded `PairMinted(address indexed lTo, address indexed sTo, uint256 amount)` args. */
export interface PairMintedArgs {
  readonly lTo: Address;
  readonly sTo: Address;
  readonly amount: bigint;
}

/** Decoded `PairBurned(address indexed lFrom, address indexed sFrom, uint256 amount)` args. */
export interface PairBurnedArgs {
  readonly lFrom: Address;
  readonly sFrom: Address;
  readonly amount: bigint;
}

/** Decoded ERC-20/3643 `Transfer(address indexed from, address indexed to, uint256 value)` args. */
export interface TransferArgs {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
}

/**
 * Stable, typed envelope for a confirmed on-chain event. The block/tx coordinates let 5.2 build an
 * idempotency key and record the tx hash on the related journal entry (NFR-3). The live watchers
 * (`watchPairEvents`/`watchTokenTransfers`) and the backfill read only ever emit MINED, non-removed
 * logs (see `isConfirmedLog`), so for events produced by this package these coordinates are always
 * non-null; the `| null` types remain only to match viem's `Log` shape. Confirmation-DEPTH
 * thresholds and reorg re-derivation beyond `removed` are deferred to Stories 5.2/5.6.
 */
export interface ChainEvent<TName extends string, TArgs> {
  readonly eventName: TName;
  readonly args: TArgs;
  readonly address: Address;
  readonly blockNumber: bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: number | null;
}

export type PairMintedEvent = ChainEvent<'PairMinted', PairMintedArgs>;
export type PairBurnedEvent = ChainEvent<'PairBurned', PairBurnedArgs>;
export type TransferEvent = ChainEvent<'Transfer', TransferArgs>;

/** A no-arg teardown that stops the underlying viem subscription(s). */
export type Unwatch = () => void;

// A log is a CONFIRMED event only if it is mined (`blockNumber` present) and not a reorg-removed
// log (`removed`). Pending and removed logs must never be surfaced as confirmed events: 5.2 builds
// its idempotency key from the block/tx/logIndex coordinates, and a null coordinate or a since-
// removed log would yield a malformed/colliding key. (Confirmation DEPTH is a 5.2/5.6 concern.)
function isConfirmedLog(log: Pick<Log, 'removed' | 'blockNumber'>): boolean {
  return log.removed !== true && log.blockNumber !== null;
}

// Maps a viem decoded log to our envelope. The decoded `args` shape is validated by the caller's
// type guard, and the log is confirmed (`isConfirmedLog`), before this is invoked. The `address` is
// normalized to its EIP-55 checksum so it compares equal to the checksummed addresses returned by
// `loadChainConfig` (5.2 routes events by `event.address === config.pairAddress`).
function toEnvelope<TName extends string, TArgs>(
  eventName: TName,
  args: TArgs,
  log: Pick<Log, 'address' | 'blockNumber' | 'transactionHash' | 'logIndex'>,
): ChainEvent<TName, TArgs> {
  return {
    eventName,
    args,
    address: getAddress(log.address),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

function isPairMintedArgs(a: unknown): a is PairMintedArgs {
  const x = a as Partial<PairMintedArgs> | undefined;
  return (
    !!x && typeof x.lTo === 'string' && typeof x.sTo === 'string' && typeof x.amount === 'bigint'
  );
}

function isPairBurnedArgs(a: unknown): a is PairBurnedArgs {
  const x = a as Partial<PairBurnedArgs> | undefined;
  return (
    !!x &&
    typeof x.lFrom === 'string' &&
    typeof x.sFrom === 'string' &&
    typeof x.amount === 'bigint'
  );
}

function isTransferArgs(a: unknown): a is TransferArgs {
  const x = a as Partial<TransferArgs> | undefined;
  return (
    !!x && typeof x.from === 'string' && typeof x.to === 'string' && typeof x.value === 'bigint'
  );
}

/** Parameters for {@link watchPairEvents}. */
export interface WatchPairEventsParams {
  readonly pairAddress: Address;
  readonly onPairMinted?: (event: PairMintedEvent) => void;
  readonly onPairBurned?: (event: PairBurnedEvent) => void;
  /** Optional error sink for transport/decoding errors raised by the subscription. */
  readonly onError?: (error: Error) => void;
}

/**
 * Watches `PairMinted` / `PairBurned` on the deployed `CoupledPair`. Returns a single, idempotent,
 * failure-isolated teardown that stops every underlying subscription. Callbacks receive fully-typed
 * envelopes; pending/reorg-removed logs (`!isConfirmedLog`) and logs whose args fail to decode to
 * the expected shape are skipped.
 */
export function watchPairEvents(clients: RoseChainClients, params: WatchPairEventsParams): Unwatch {
  const { pairAddress, onPairMinted, onPairBurned, onError } = params;
  const unwatchers: Unwatch[] = [];

  if (onPairMinted) {
    unwatchers.push(
      clients.publicClient.watchContractEvent({
        address: pairAddress,
        abi: coupledPairAbi,
        eventName: 'PairMinted',
        onError,
        onLogs: (logs) => {
          for (const log of logs) {
            if (isConfirmedLog(log) && isPairMintedArgs(log.args)) {
              onPairMinted(toEnvelope('PairMinted', log.args, log));
            }
          }
        },
      }),
    );
  }

  if (onPairBurned) {
    unwatchers.push(
      clients.publicClient.watchContractEvent({
        address: pairAddress,
        abi: coupledPairAbi,
        eventName: 'PairBurned',
        onError,
        onLogs: (logs) => {
          for (const log of logs) {
            if (isConfirmedLog(log) && isPairBurnedArgs(log.args)) {
              onPairBurned(toEnvelope('PairBurned', log.args, log));
            }
          }
        },
      }),
    );
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    // Best-effort: a throw from one underlying unwatch must not strand the others.
    for (const unwatch of unwatchers) {
      try {
        unwatch();
      } catch {
        /* best-effort teardown */
      }
    }
  };
}

/** Parameters for {@link watchTokenTransfers}. */
export interface WatchTokenTransfersParams {
  readonly tokenAddress: Address;
  readonly onTransfer: (event: TransferEvent) => void;
  readonly onError?: (error: Error) => void;
}

/**
 * Watches ERC-3643 `Transfer` events on a deployed leg token. Returns a teardown function.
 */
export function watchTokenTransfers(
  clients: RoseChainClients,
  params: WatchTokenTransfersParams,
): Unwatch {
  const { tokenAddress, onTransfer, onError } = params;
  return clients.publicClient.watchContractEvent({
    address: tokenAddress,
    abi: roseTokenAbi,
    eventName: 'Transfer',
    onError,
    onLogs: (logs) => {
      for (const log of logs) {
        if (isConfirmedLog(log) && isTransferArgs(log.args)) {
          onTransfer(toEnvelope('Transfer', log.args, log));
        }
      }
    },
  });
}

/** Parameters for {@link getPastPairEvents}. */
export interface GetPastPairEventsParams {
  readonly pairAddress: Address;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
}

/**
 * Backfill read: returns past `PairMinted`/`PairBurned` events in `[fromBlock, toBlock]` as typed
 * envelopes (same shape as the live watcher), for catch-up/reconciliation. Defaults to the full
 * range when bounds are omitted — callers SHOULD pass explicit bounds against a real provider, as
 * public Sepolia RPCs cap `eth_getLogs` block-span/result size. Range chunking and finality-aware
 * backfill policy are owned by the reconcile story (5.6); this is the typed seam it builds on.
 */
export async function getPastPairEvents(
  clients: RoseChainClients,
  params: GetPastPairEventsParams,
): Promise<Array<PairMintedEvent | PairBurnedEvent>> {
  const { pairAddress, fromBlock, toBlock } = params;
  const logs = await clients.publicClient.getContractEvents({
    address: pairAddress,
    abi: coupledPairAbi,
    fromBlock: fromBlock ?? 'earliest',
    toBlock: toBlock ?? 'latest',
  });

  const events: Array<PairMintedEvent | PairBurnedEvent> = [];
  for (const log of logs) {
    if (!isConfirmedLog(log)) continue;
    if (log.eventName === 'PairMinted' && isPairMintedArgs(log.args)) {
      events.push(toEnvelope('PairMinted', log.args, log));
    } else if (log.eventName === 'PairBurned' && isPairBurnedArgs(log.args)) {
      events.push(toEnvelope('PairBurned', log.args, log));
    }
  }
  return events;
}
