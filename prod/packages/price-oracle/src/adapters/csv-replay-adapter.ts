// @rose/price-oracle — P0 CSV/replay adapter (FR-24, §14).
//
// The P0 `PriceOracle` adapter replays historical `timestamp,price` ticks — NOT a live OANDA/LMAX
// feed (real venues are a gated, post-P0 money-boundary switch, §11.3/§14). It is read-only: it
// only reads the latest tick at or before a caller-supplied `now`; it never writes anything.
//
// CSV format mirrors the throwaway tick fixtures (`timestamp,price`): a header row, blank lines,
// and `#`-comment lines are tolerated; every data row must be `timestamp,price` with a strictly-
// positive decimal price (NFR-2) — a malformed row is a hard error (fail loud, never silently
// dropped). Prices stay decimal STRINGS end-to-end (no binary float).
import type { PriceOracle, PriceQuote } from '../price-oracle.js';

/** One replay tick: an ISO-8601 timestamp and a strictly-positive decimal-string price. */
export interface ReplayTick {
  readonly asOf: Date;
  readonly price: string;
}

// A strictly-positive decimal: no leading '-', at least one non-zero digit.
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

function isPositiveDecimal(value: string): boolean {
  const t = value.trim();
  return POSITIVE_DECIMAL.test(t) && /[1-9]/.test(t);
}

/**
 * Parses CSV text in the `timestamp,price` format into ordered `ReplayTick`s.
 *
 * - Blank lines and `#`-comment lines are skipped.
 * - An optional header row is tolerated ONLY when its price column is a non-numeric LABEL (e.g.
 *   `timestamp,price`); a first row whose price has digits but is not a valid positive decimal is
 *   treated as corrupt data and fails loud (a malformed tick is never silently dropped).
 * - Every data row MUST be `timestamp,price`; the timestamp must be a parseable date and the
 *   price a strictly-positive decimal string (NFR-2).
 */
export function parseReplayCsv(csv: string): ReplayTick[] {
  if (typeof csv !== 'string') {
    throw new TypeError('parseReplayCsv expects CSV text as a string.');
  }
  const ticks: ReplayTick[] = [];
  const lines = csv.split(/\r?\n/);
  let seenData = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const comma = line.indexOf(',');
    if (comma < 0) {
      throw new SyntaxError(`Tick line ${i + 1} is not 'timestamp,price': '${raw}'.`);
    }
    const timestamp = line.slice(0, comma).trim();
    const price = line.slice(comma + 1).trim();
    if (!seenData) {
      seenData = true;
      // Tolerate a header row ONLY when the price column is a pure non-numeric label (no digits).
      if (!isPositiveDecimal(price) && !/[0-9]/.test(price)) {
        continue;
      }
    }
    if (!isPositiveDecimal(price)) {
      throw new SyntaxError(
        `Tick line ${i + 1} has an invalid price '${price}' — must be a strictly-positive decimal string (NFR-2).`,
      );
    }
    const asOf = new Date(timestamp);
    if (Number.isNaN(asOf.getTime())) {
      throw new SyntaxError(`Tick line ${i + 1} has an unparseable timestamp '${timestamp}'.`);
    }
    ticks.push({ asOf, price });
  }
  return ticks;
}

/**
 * A read-only `PriceOracle` that replays in-memory ticks per reference asset. `getPrice` returns
 * the latest tick at or before the adapter's current clock (`now`), or `null` when the asset is
 * unknown or has no tick at/before `now` (an explicit no-feed — never a fabricated price).
 *
 * The clock is injected (`setNow`/constructor) so replay is deterministic and never wall-clock
 * driven; capital/money decisions must never depend on an ambient clock.
 */
export class CsvReplayPriceOracle implements PriceOracle {
  readonly source: string;
  private readonly ticksByAsset: ReadonlyMap<string, readonly ReplayTick[]>;
  private now: Date;

  constructor(
    feeds: Record<string, readonly ReplayTick[]>,
    options: { readonly source?: string; readonly now?: Date } = {},
  ) {
    this.source = options.source ?? 'csv-replay';
    const map = new Map<string, readonly ReplayTick[]>();
    for (const [asset, ticks] of Object.entries(feeds)) {
      // Sort ascending by asOf so the latest-at-or-before lookup is well defined regardless of
      // input ordering.
      const sorted = [...ticks].sort((a, b) => a.asOf.getTime() - b.asOf.getTime());
      map.set(asset, sorted);
    }
    this.ticksByAsset = map;
    this.now = options.now ?? new Date(0);
  }

  /** Build an oracle from raw CSV text for a single reference asset. */
  static fromCsv(
    referenceAsset: string,
    csv: string,
    options: { readonly source?: string; readonly now?: Date } = {},
  ): CsvReplayPriceOracle {
    return new CsvReplayPriceOracle({ [referenceAsset]: parseReplayCsv(csv) }, options);
  }

  /** Advance (or rewind) the replay clock. Deterministic — never reads the wall clock. */
  setNow(now: Date): void {
    this.now = now;
  }

  getPrice(referenceAsset: string): Promise<PriceQuote | null> {
    const ticks = this.ticksByAsset.get(referenceAsset);
    if (ticks === undefined || ticks.length === 0) {
      return Promise.resolve(null); // unknown asset / empty feed ⇒ explicit no-feed
    }
    const cutoff = this.now.getTime();
    let latest: ReplayTick | undefined;
    let index = -1;
    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i]!;
      if (tick.asOf.getTime() <= cutoff) {
        latest = tick;
        index = i;
      } else {
        break; // ticks are sorted ascending; the rest are all in the future
      }
    }
    if (latest === undefined) {
      return Promise.resolve(null); // no tick at/before now ⇒ no feed yet
    }
    return Promise.resolve({
      referenceAsset,
      price: latest.price,
      asOf: latest.asOf,
      source: this.source,
      sequence: index,
    });
  }
}
