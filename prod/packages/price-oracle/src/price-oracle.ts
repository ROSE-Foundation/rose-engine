// @rose/price-oracle — the substitutable `PriceOracle` port (FR-24, NFR-8).
//
// The port supplies the reference-asset price for the mark-to-market service. It is the seam the
// rest of the position layer codes against: swapping the P0 CSV/replay adapter for a testnet feed
// (or a fake in a test) changes NO caller (NFR-8). The port is **read-only market data** — it has
// no method that writes postings or mutates ledger state; capital movement stays exclusively on
// the `postTransfer` chokepoint, never here.
//
// A missing/unknown price is an EXPLICIT absence (`null`), never a fabricated number — the
// mark-to-market service turns a `null` quote into an explicit "no price feed" state.

/**
 * A single price observation for a reference asset, carrying provenance (`source`, `asOf`) so a
 * downstream mark can be attributed and freshness-checked. The price is an exact decimal STRING
 * (never a JS `number` — NFR-2).
 */
export interface PriceQuote {
  /** The underlying reference (e.g. 'EUR/USD', 'BTC') this quote prices. */
  readonly referenceAsset: string;
  /** The observed price as a strictly-positive decimal string (NFR-2). */
  readonly price: string;
  /** When the price was observed (provenance + the input to the freshness/staleness check). */
  readonly asOf: Date;
  /** Provenance: an opaque identifier of the feed/adapter that produced this quote. */
  readonly source: string;
  /** Optional monotonic replay/stream sequence for provenance/audit. */
  readonly sequence?: number;
}

/**
 * The substitutable price-oracle port (NFR-8). Implementations are read-only market-data sources:
 * the ONLY capability is reading the latest quote. There is deliberately no write/post method —
 * an oracle never writes postings.
 *
 * `getPrice` resolves to the latest `PriceQuote` for the asset, or `null` when there is no feed /
 * no data for it (an explicit absence — never a fabricated price).
 */
export interface PriceOracle {
  /** Provenance: an identifier of this oracle implementation/source. */
  readonly source: string;
  /** Latest quote for `referenceAsset`, or `null` if the feed is absent / has no data for it. */
  getPrice(referenceAsset: string): Promise<PriceQuote | null>;
}
