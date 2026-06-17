// PAPER-MODE chain adapter (infrastructure). Proves the promoted seam works END-TO-END through a REAL
// viem local-account `writeContract` with NO network: the mock transport answers the JSON-RPC and
// resolves a tx hash, and successive broadcasts resolve UNIQUE synthetic hashes (so the 5.2 saga, which
// keys the commit point on the tx hash, never collides). NO Sepolia, NO secret.
import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import {
  coupledPairAbi,
  createPaperChainClients,
  makePaperAccount,
  makePaperChainConfig,
  PAPER_PAIR_ADDRESS,
} from '../index.js';

const HOLDER: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

describe('paper transport — network-free local-account writes with unique synthetic tx hashes', () => {
  it('resolves a 32-byte tx hash and never repeats it across broadcasts', async () => {
    const clients = createPaperChainClients();
    const account = makePaperAccount();
    const wallet = clients.getWalletClient(account);

    const write = (): Promise<`0x${string}`> =>
      wallet.writeContract({
        address: PAPER_PAIR_ADDRESS,
        abi: coupledPairAbi,
        functionName: 'mintPair',
        args: [HOLDER, HOLDER, 1_000n],
        account,
        chain: sepolia,
      });

    const h1 = await write();
    const h2 = await write(); // byte-identical calldata must STILL yield a distinct hash
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h2).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
  });

  it('exposes the simulated (non-network) chain config with checksummed addresses', () => {
    const config = makePaperChainConfig();
    expect(config.pairAddress).toBe(PAPER_PAIR_ADDRESS);
    expect(config.sepoliaRpcUrl).toContain('paper.invalid');
  });
});
