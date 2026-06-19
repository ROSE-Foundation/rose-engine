// @rose/price-oracle (FR-24) — a substitutable, read-only `PriceOracle` port + a P0 CSV/replay
// adapter + a mark-to-market service that prices an issued coupled pair from its REAL parameters
// (anchor P₀, leverage, collateral pool, floor). The oracle never writes postings; a mark is never
// fabricated — an absent/stale/implausibly-divergent feed yields an explicit state (NFR-2, NFR-8,
// §15 oracle integrity).

/** Package identifier. */
export const PRICE_ORACLE_PACKAGE_NAME = '@rose/price-oracle' as const;

export * from './price-oracle.js';
export * from './adapters/csv-replay-adapter.js';
export * from './mark-to-market.js';
