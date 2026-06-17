// THROWAWAY (Story 7.2, FR-16) — historical tick ingestion (CSV `timestamp,price`).
//
// Ticks arrive as CSV lines `timestamp,price`. Prices are decimal STRINGS (never JS `number`,
// NFR-2) so they flow straight into the exact @throwaway/coupled-math model without any binary
// float on the money/price path. A header row, blank lines, and `#` comment lines are tolerated.
//
// REGIME: this file lives under /throwaway. It uses only the Node stdlib + local types.
import { readFileSync } from 'node:fs';

/** One historical tick: an opaque timestamp string and a decimal-string price. */
export interface Tick {
  /** Opaque timestamp (ISO-8601, epoch, or any non-empty token). NEVER used by the reset logic. */
  readonly timestamp: string;
  /** Price as a strictly-positive decimal string (never JS `number` — NFR-2). */
  readonly price: string;
}

// A strictly-positive decimal: no leading '-', at least one non-zero digit.
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

function isPositiveDecimal(value: string): boolean {
  const t = value.trim();
  return POSITIVE_DECIMAL.test(t) && /[1-9]/.test(t);
}

/**
 * Parses CSV text in the `timestamp,price` format into ordered `Tick`s.
 *
 * - Blank lines and `#`-comment lines are skipped.
 * - An optional header row is tolerated: if the FIRST data line's price field is not a valid
 *   positive decimal, that line is treated as a header and skipped (e.g. `timestamp,price`).
 * - Every subsequent line MUST be `timestamp,price` with a strictly-positive decimal price;
 *   anything else is a hard error (fail loud — a malformed tick must not be silently dropped).
 */
export function parseTicks(csv: string): Tick[] {
  if (typeof csv !== 'string') {
    throw new TypeError('parseTicks expects CSV text as a string.');
  }
  const ticks: Tick[] = [];
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
      // Optional header row: tolerated ONLY when the price column is a non-numeric LABEL (no
      // digits, e.g. "price"). A first row whose price HAS digits but is not a valid positive
      // decimal (e.g. "-5", "0", "1.2.3", "1,000") is CORRUPT data — fall through to the strict
      // validation below and fail loud (a malformed tick is NEVER silently dropped, even on row 1).
      if (!isPositiveDecimal(price) && !/[0-9]/.test(price)) {
        continue;
      }
    }
    if (timestamp.length === 0) {
      throw new SyntaxError(`Tick line ${i + 1} has an empty timestamp: '${raw}'.`);
    }
    if (!isPositiveDecimal(price)) {
      throw new SyntaxError(
        `Tick line ${i + 1} has an invalid price '${price}' (expected a positive decimal string, ` +
          `never a JS number — NFR-2): '${raw}'.`,
      );
    }
    ticks.push({ timestamp, price });
  }
  return ticks;
}

/** Reads a fixture CSV file and parses it into ordered `Tick`s. */
export function loadTicksFromFile(path: string): Tick[] {
  return parseTicks(readFileSync(path, 'utf8'));
}
