// The on-chain supply data contract for the read-only group-view divergence signal (Story 5.5,
// FR-9 / NFR-9, D3 — chain authoritative).
//
// DECOUPLING (the codebase's injected-port precedent): `@rose/chain` avoided importing
// `@rose/authorization` by taking an injected gate; `@rose/reconcile` likewise does NOT import
// `@rose/chain`. The on-chain token supplies enter the group view as an INJECTED `ChainSupplySnapshot`
// — plain data (per-token `totalSupply` as `bigint`, NFR-2). This keeps the package edge minimal,
// makes the group view a pure function of (ledger, snapshot), and lets the whole thing run LOCALLY
// with NO RPC, NO key, NO secret. The Epic-6 / Story-5.6 composition layer wires the real
// `@rose/chain` `readTotalSupply` into the `ChainSupplyReader` below (the deferred-ops seam).

import { assertNotFloat } from '@rose/shared';

/** One token's on-chain quantity: its asset label + decimal scale + integer `totalSupply` (NFR-2). */
export interface ChainTokenSupply {
  /** The ledger asset label this on-chain token maps to (e.g. 'ROSE_L'). */
  readonly asset: string;
  /** The token's decimal scale (its `decimals()`), used to format the quantity exactly. */
  readonly scale: number;
  /** The on-chain `totalSupply` as an integer in smallest units. Never a float (NFR-2). */
  readonly totalSupply: bigint;
}

/**
 * A snapshot of on-chain token supplies the group view compares the ledger against. `source` is
 * always `ledger+chain` — its presence is what flips the group view from a `ledger-only` read to a
 * chain-aggregated one (D3: the source is made explicit in the rendered view).
 */
export interface ChainSupplySnapshot {
  readonly source: 'ledger+chain';
  readonly tokens: ReadonlyArray<ChainTokenSupply>;
}

/** A token descriptor for the supply reader: the ledger asset/scale + the on-chain token address. */
export interface ChainTokenDescriptor {
  readonly asset: string;
  readonly scale: number;
  /** Opaque to reconcile — the reader (Epic-6 composition) maps it to an on-chain read. */
  readonly address: string;
}

/**
 * The injected port that reads a token's on-chain `totalSupply`. The Epic-6 / 5.6 composition wires
 * this to `@rose/chain` `readTotalSupply(clients, address)`; tests inject a synthetic reader. This
 * package never opens a chain connection itself (no `viem`, no RPC, no key).
 */
export type ChainSupplyReader = (token: ChainTokenDescriptor) => Promise<bigint>;

/**
 * Builds a `ChainSupplySnapshot` by mapping the injected `reader` over `tokens` (the deferred-ops
 * seam — the real read happens inside `reader`). Validates each returned supply is an integer
 * `bigint` (NFR-2). Pure orchestration: it adds no network code to this package.
 */
export async function loadChainSupplySnapshot(
  reader: ChainSupplyReader,
  tokens: ReadonlyArray<ChainTokenDescriptor>,
): Promise<ChainSupplySnapshot> {
  const supplies: ChainTokenSupply[] = [];
  for (const token of tokens) {
    const totalSupply = await reader(token);
    assertNotFloat(totalSupply);
    if (typeof totalSupply !== 'bigint') {
      throw new TypeError(
        `On-chain totalSupply for asset '${token.asset}' must be a bigint in smallest units (NFR-2).`,
      );
    }
    supplies.push({ asset: token.asset, scale: token.scale, totalSupply });
  }
  return Object.freeze({ source: 'ledger+chain', tokens: supplies });
}
