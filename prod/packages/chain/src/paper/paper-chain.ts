// PAPER-MODE chain adapter (infrastructure, NOT a BMAD story). Promotes the EXACT in-test seam the
// 5.3/5.4/6.2/6.3/6.4 suites already prove — a mock EIP-1193 transport that lets viem's
// `writeContract` "broadcast" a local-account tx and resolve a tx hash WITHOUT any network — from the
// test fakes into a small PROD source module, so a shared live environment can run the write flows
// (subscribe / redeem / strategy) entirely IN-PROCESS with NO Sepolia, NO RPC, NO secret.
//
// What this is NOT: it is NOT a real chain. The transport answers the JSON-RPC viem issues for a
// local-account write with deterministic, simulated values and returns a UNIQUE synthetic tx hash per
// broadcast (so the 5.2 outbox/saga — which keys the commit point on the tx hash — never collides).
// It performs NO signature/nonce verification and NO state. The commit-point `PairMinted`/`PairBurned`
// events are synthesized by the composition layer (`@rose/rose-note` paper mode), NOT here.
//
// SECURITY: the signing `Account` is a FRESH, RANDOM throwaway key generated per process
// (`generatePrivateKey`) — never read from the environment, never persisted, never usable against a
// real network (the paper transport never forwards anything). NO secret, NO `.env`, NO placeholder key.
import {
  custom,
  getAddress,
  keccak256,
  toHex,
  type Account,
  type Address,
  type EIP1193RequestFn,
  type Hex,
  type Transport,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { ChainConfig } from '../chain-config.js';
import { createRoseChainClients, type RoseChainClients } from '../viem-clients.js';

/** A clear, single-line banner logged when paper mode is active — on-chain effects are SIMULATED. */
export const PAPER_MODE_BANNER =
  'PAPER MODE: on-chain effects are simulated, not real (no Sepolia, no network, no secret). ' +
  'Subscriptions / redemptions / strategy resets are confirmed IN-PROCESS via synthetic events.';

// Deterministic, NON-secret synthetic addresses for the simulated suite. These are NOT real deployed
// contracts and never reach a network — they exist only so the typed clients/services have canonical,
// checksummed addresses to carry. (Mirrors the addresses the proven 6.x e2e tests use.)
const PAPER_PAIR = getAddress('0x1111111111111111111111111111111111111111');
const PAPER_L_TOKEN = getAddress('0x2222222222222222222222222222222222222222');
const PAPER_S_TOKEN = getAddress('0x3333333333333333333333333333333333333333');
const PAPER_IDENTITY_REGISTRY = getAddress('0x4444444444444444444444444444444444444444');

/** The deployed-`CoupledPair` address the paper mint/burn writes target (simulated, non-network). */
export const PAPER_PAIR_ADDRESS: Address = PAPER_PAIR;

/**
 * The synthetic `ChainConfig` the paper clients are built from. Carries the simulated addresses and a
 * non-network RPC URL that is NEVER dialed (the injected paper transport answers every request). It
 * deliberately does NOT go through `loadChainConfig` (which is refuse-if-absent for REAL secrets).
 */
export function makePaperChainConfig(): ChainConfig {
  return Object.freeze({
    sepoliaRpcUrl: 'http://paper.invalid/never-dialed',
    pairAddress: PAPER_PAIR,
    lTokenAddress: PAPER_L_TOKEN,
    sTokenAddress: PAPER_S_TOKEN,
    identityRegistryAddress: PAPER_IDENTITY_REGISTRY,
  });
}

/**
 * Builds the mock EIP-1193 transport that lets a viem local-account `writeContract` resolve a tx hash
 * with NO network. Answers exactly the JSON-RPC the 6.x suites prove viem issues for such a write, and
 * returns a UNIQUE synthetic tx hash per `eth_sendRawTransaction` so the outbox/saga commit point —
 * which is keyed on the tx hash — can never collide (even for byte-identical calldata). The nonce is
 * advanced per broadcast so successive serialized txs differ too. NO secret, NO real broadcast.
 */
export function createPaperTransport(): Transport {
  let nonce = 0;
  let counter = 0;
  const request = (async ({ method, params }) => {
    switch (method) {
      case 'eth_chainId':
        return `0x${sepolia.id.toString(16)}` as Hex;
      case 'eth_getTransactionCount':
        return `0x${nonce.toString(16)}` as Hex;
      case 'eth_estimateGas':
        return '0x5208' as Hex;
      case 'eth_gasPrice':
        return '0x3b9aca00' as Hex;
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00' as Hex;
      case 'eth_blockNumber':
        return '0x10' as Hex;
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          baseFeePerGas: '0x3b9aca00',
          gasLimit: '0x1c9c380',
          timestamp: '0x0',
        } as unknown as Hex;
      case 'eth_feeHistory':
        return {
          oldestBlock: '0x1',
          baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
          gasUsedRatio: [0.5],
          reward: [['0x3b9aca00']],
        } as unknown as Hex;
      case 'eth_sendRawTransaction': {
        nonce += 1;
        // Derive a UNIQUE, deterministic 32-byte synthetic hash. We fold a monotonic counter into the
        // signed-tx bytes so even byte-identical calldata (same recipient + amount) never yields the
        // same hash — the saga keys the commit point on this hash and must not collide.
        const raw = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : '0x';
        return keccak256(toHex(`${raw}:${counter++}`));
      }
      default:
        throw new Error(
          `[paper-chain] unexpected RPC method '${String(method)}' — the paper transport only ` +
            `simulates the local-account write path (no real network).`,
        );
    }
  }) as EIP1193RequestFn;
  return custom({ request });
}

/**
 * A FRESH, RANDOM throwaway signing account for the paper write path (generated per call). Never read
 * from the environment, never persisted; the paper transport forwards nothing, so this key cannot act
 * on any real network. Avoids hard-coding any key (including the well-known anvil test key).
 */
export function makePaperAccount(): Account {
  return privateKeyToAccount(generatePrivateKey());
}

/**
 * Builds the typed `RoseChainClients` wired onto the paper transport — a drop-in for
 * `createRoseChainClients(loadChainConfig())` that requires NO Sepolia and NO secret. Used by the
 * `@rose/rose-note` paper composition to construct the 5.3/5.4 dual-writes.
 */
export function createPaperChainClients(): RoseChainClients {
  return createRoseChainClients(makePaperChainConfig(), { transport: createPaperTransport() });
}
