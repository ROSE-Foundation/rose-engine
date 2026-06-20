// Paper-mode LIVE replay oracle (infrastructure, NOT a BMAD story). Replays a deterministic, looping
// synthetic price series around each issued pair's anchor P₀ so the deployed paper app shows a MOVING
// live mark and live directional P&L (the LONG leg gains as the reference rises, the SHORT mirror loses,
// delta-neutral) — instead of the flat anchor-replay. Built ON the Story-8.1 `CsvReplayPriceOracle`
// (the substitutable replay adapter, NFR-8): per asset, an in-memory looping tick series; a wall-clock-
// mapped replay clock advances through it. Read-only — it writes NO postings.
//
// It stays inside the §15 oracle-trust band on purpose: a small amplitude keeps the leveraged deviation
// |L·r| < 1 (so the mark is a valid OK state, not DIVERGENT) and each observation is stamped with the
// current wall clock (so it is fresh, not STALE) — the replay supplies the price MOVEMENT, freshness is
// genuine. An unknown asset ⇒ `null` (the honest no-feed state — never a fabricated price).
import type { RoseDb } from '@rose/ledger';
import {
  CsvReplayPriceOracle,
  type PriceOracle,
  type PriceQuote,
  type ReplayTick,
} from '@rose/price-oracle';

/** Number of ticks in one full oscillation cycle. */
const STEPS = 120;
/** Wall-clock duration of one full oscillation (a visible move every couple of minutes). */
const PERIOD_MS = 120_000;
/** Per-tick spacing in the synthetic series. */
const STEP_MS = PERIOD_MS / STEPS;

/** The oracle / provenance source label. */
export const PAPER_LIVE_REPLAY_SOURCE = 'paper-live-replay';

/**
 * Deterministic per-asset amplitude (5–9 %) + phase offset, derived from the asset name, so distinct
 * markets oscillate distinctly (and reproducibly). Amplitude is kept small so that for the demo pairs
 * (leverage 3×) the leveraged deviation |L·r| stays well under 1 — the mark is a valid OK state.
 */
function waveParams(asset: string): { amplitude: number; phase: number } {
  let h = 0;
  for (let i = 0; i < asset.length; i++) {
    h = (h * 31 + asset.charCodeAt(i)) >>> 0;
  }
  const amplitude = 0.05 + (h % 5) * 0.01; // 0.05 .. 0.09
  const phase = h % STEPS;
  return { amplitude, phase };
}

/**
 * Build one looping cycle of replay ticks around `anchor`: the price oscillates ±amplitude as a smooth
 * sine. `asOf` is the tick's position in the cycle (index × STEP_MS); the live wrapper rewrites it to
 * the wall clock on read. Price is an exact decimal STRING at 8 dp (NFR-2 — the mark-to-market service
 * does exact rational math on it; this is a market-data observation, not money arithmetic).
 */
function buildCycle(anchor: number, asset: string): readonly ReplayTick[] {
  const { amplitude, phase } = waveParams(asset);
  const ticks: ReplayTick[] = [];
  for (let i = 0; i < STEPS; i++) {
    const angle = (2 * Math.PI * ((i + phase) % STEPS)) / STEPS;
    const price = anchor * (1 + amplitude * Math.sin(angle));
    ticks.push({ asOf: new Date(i * STEP_MS), price: price.toFixed(8) });
  }
  return ticks;
}

/**
 * Builds the paper LIVE replay oracle. Per reference asset it lazily reads the issued pair's anchor P₀
 * (the same DB lookup the flat anchor-replay used) and builds a looping `CsvReplayPriceOracle` series
 * around it; `getPrice` maps the wall clock into the cycle, reads the replayed tick, and stamps it with
 * the current time so the mark is fresh. The clock is injected (`now`) for deterministic tests.
 */
export function makePaperReplayOracle(
  db: RoseDb,
  options: { readonly now?: () => Date } = {},
): PriceOracle {
  const now = options.now ?? ((): Date => new Date());
  const perAsset = new Map<string, CsvReplayPriceOracle>();

  async function oracleFor(asset: string): Promise<CsvReplayPriceOracle | null> {
    const cached = perAsset.get(asset);
    if (cached !== undefined) return cached;
    const pair = await db.query.coupledPairs.findFirst({
      where: (p, { eq }) => eq(p.referenceAsset, asset),
    });
    if (pair === undefined) return null;
    const anchor = Number(pair.anchorPrice);
    const built = new CsvReplayPriceOracle(
      { [asset]: buildCycle(anchor, asset) },
      { source: PAPER_LIVE_REPLAY_SOURCE },
    );
    perAsset.set(asset, built);
    return built;
  }

  return {
    source: PAPER_LIVE_REPLAY_SOURCE,
    async getPrice(referenceAsset: string): Promise<PriceQuote | null> {
      const inner = await oracleFor(referenceAsset);
      if (inner === null) return null; // unknown asset ⇒ honest no-feed (never fabricated)
      // Map the wall clock into the looping cycle, then read the replayed tick at that point.
      const phaseMs = now().getTime() % PERIOD_MS;
      inner.setNow(new Date(phaseMs));
      const quote = await inner.getPrice(referenceAsset);
      if (quote === null) return null;
      // The demo feed is LIVE: stamp the observation with the current wall clock so the mark is fresh
      // (the replay series supplies the price movement; the freshness is genuine, not back-dated).
      return { ...quote, asOf: now(), source: PAPER_LIVE_REPLAY_SOURCE };
    },
  };
}
