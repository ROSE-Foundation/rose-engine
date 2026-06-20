// Paper-mode LIVE replay oracle (infrastructure, NOT a BMAD story). Replays a deterministic, looping
// synthetic price series around each issued pair's anchor P₀ so the deployed paper app shows a MOVING
// live mark and live directional P&L (the LONG leg gains as the reference rises, the SHORT mirror loses,
// delta-neutral) — instead of the flat anchor-replay. Built ON the Story-8.1 `CsvReplayPriceOracle`
// (the substitutable replay adapter, NFR-8): per asset, an in-memory looping tick series; a wall-clock-
// mapped replay clock advances through it. Read-only — it writes NO postings.
//
// The oscillation `amplitude` and `periodSeconds` are read from the injected simulation-settings store
// (tuned live from the Simulation screen). A small amplitude keeps the leveraged deviation |L·r| < 1 so
// the mark is a valid OK state; pushing amplitude past the trust band is allowed on purpose so an
// operator can demonstrate the DIVERGENT state. Each observation is stamped with the current wall clock
// (so it is fresh, not STALE) — the replay supplies the price MOVEMENT, freshness is genuine. An unknown
// asset ⇒ `null` (the honest no-feed state — never a fabricated price).
import type { RoseDb } from '@rose/ledger';
import {
  buildDirectionalChangeSeries,
  CsvReplayPriceOracle,
  type PriceOracle,
  type PriceQuote,
  type ReplayTick,
} from '@rose/price-oracle';
import { DEFAULT_SIMULATION_SETTINGS, type SimulationFeedMode } from './simulation-settings.js';

/** Number of ticks in one full oscillation cycle (resolution of the synthetic series). */
const STEPS = 120;

/** The oracle / provenance source label. */
export const PAPER_LIVE_REPLAY_SOURCE = 'paper-live-replay';

/** The feed parameters the oracle reads on each quote (supplied by the simulation-settings store). */
interface ReplayParams {
  readonly amplitude: number;
  readonly periodSeconds: number;
  /** The feed shape: clock-based `sine` (default) or intrinsic-time `directional-change`. */
  readonly mode: SimulationFeedMode;
  /** The δ directional-change threshold (fraction); only used when `mode === 'directional-change'`. */
  readonly dcThreshold: number;
  /** Monotonic version — when it changes, the cached per-asset tick series is rebuilt. */
  readonly version: number;
}

/** Deterministic 32-bit hash of the asset name (seeds both the sine phase and the DC walk). */
function hashAsset(asset: string): number {
  let h = 0;
  for (let i = 0; i < asset.length; i++) {
    h = (h * 31 + asset.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Deterministic per-asset phase offset (so distinct markets oscillate on distinct phases). */
function phaseOf(asset: string): number {
  return hashAsset(asset) % STEPS;
}

/**
 * Build one looping cycle of replay ticks around `anchor`: the price oscillates ±`amplitude` as a smooth
 * sine over `periodMs`. `asOf` is the tick's position in the cycle (index × stepMs); the live wrapper
 * rewrites it to the wall clock on read. Price is an exact decimal STRING at 8 dp (NFR-2 — the
 * mark-to-market service does exact rational math on it; this is a market-data observation).
 */
function buildCycle(
  anchor: number,
  asset: string,
  amplitude: number,
  periodMs: number,
): readonly ReplayTick[] {
  const phase = phaseOf(asset);
  const stepMs = periodMs / STEPS;
  const ticks: ReplayTick[] = [];
  for (let i = 0; i < STEPS; i++) {
    const angle = (2 * Math.PI * ((i + phase) % STEPS)) / STEPS;
    const price = anchor * (1 + amplitude * Math.sin(angle));
    ticks.push({ asOf: new Date(i * stepMs), price: price.toFixed(8) });
  }
  return ticks;
}

/**
 * Build one looping cycle of replay ticks around `anchor` as a DIRECTIONAL-CHANGE (intrinsic-time) path
 * instead of a sine: a δ-threshold random walk with overshoots (see `@rose/price-oracle`
 * `buildDirectionalChangeSeries`), seeded off the asset name so distinct markets get distinct (but
 * reproducible) paths. The series is bounded within ±`amplitude` and laid out so it loops with no jump;
 * here we only stamp each generated price with its position in the cycle (rewritten to the wall clock on
 * read, exactly like the sine path). Price is an exact 8-dp decimal STRING (NFR-2).
 */
function buildDcCycle(
  anchor: number,
  asset: string,
  amplitude: number,
  dcThreshold: number,
  periodMs: number,
): readonly ReplayTick[] {
  const stepMs = periodMs / STEPS;
  const series = buildDirectionalChangeSeries({
    anchor,
    steps: STEPS,
    amplitude,
    dcThreshold,
    seed: hashAsset(asset),
  });
  return series.map((point, i) => ({ asOf: new Date(i * stepMs), price: point.price }));
}

/**
 * Builds the paper LIVE replay oracle. Per reference asset it lazily reads the issued pair's anchor P₀
 * (the same DB lookup the flat anchor-replay used) and builds a looping `CsvReplayPriceOracle` series
 * around it using the CURRENT simulation settings; `getPrice` maps the wall clock into the cycle, reads
 * the replayed tick, and stamps it with the current time so the mark is fresh. The cached series is
 * rebuilt only when the settings `version` changes. Both the clock (`now`) and the `settings` provider
 * are injected for deterministic tests; `settings` defaults to the parked defaults.
 */
export function makePaperReplayOracle(
  db: RoseDb,
  options: {
    readonly now?: () => Date;
    readonly settings?: () => ReplayParams;
  } = {},
): PriceOracle {
  const now = options.now ?? ((): Date => new Date());
  const readParams =
    options.settings ?? ((): ReplayParams => ({ ...DEFAULT_SIMULATION_SETTINGS, version: 0 }));

  const perAsset = new Map<string, CsvReplayPriceOracle>();
  let cachedVersion = -1;

  async function oracleFor(
    asset: string,
    params: ReplayParams,
  ): Promise<CsvReplayPriceOracle | null> {
    if (params.version !== cachedVersion) {
      perAsset.clear(); // a parameter changed — drop the stale tick series
      cachedVersion = params.version;
    }
    const cached = perAsset.get(asset);
    if (cached !== undefined) return cached;
    const pair = await db.query.coupledPairs.findFirst({
      where: (p, { eq }) => eq(p.referenceAsset, asset),
    });
    if (pair === undefined) return null;
    const anchor = Number(pair.anchorPrice);
    const periodMs = params.periodSeconds * 1000;
    // `sine` keeps today's exact clock-based oscillation; `directional-change` replays the intrinsic-time
    // δ-threshold path. Same wall-clock→cycle mapping, freshness stamping, and version-keyed cache either way.
    const cycle =
      params.mode === 'directional-change'
        ? buildDcCycle(anchor, asset, params.amplitude, params.dcThreshold, periodMs)
        : buildCycle(anchor, asset, params.amplitude, periodMs);
    const built = new CsvReplayPriceOracle(
      { [asset]: cycle },
      { source: PAPER_LIVE_REPLAY_SOURCE },
    );
    perAsset.set(asset, built);
    return built;
  }

  return {
    source: PAPER_LIVE_REPLAY_SOURCE,
    async getPrice(referenceAsset: string): Promise<PriceQuote | null> {
      const params = readParams();
      const inner = await oracleFor(referenceAsset, params);
      if (inner === null) return null; // unknown asset ⇒ honest no-feed (never fabricated)
      // Map the wall clock into the looping cycle, then read the replayed tick at that point.
      const periodMs = params.periodSeconds * 1000;
      const phaseMs = now().getTime() % periodMs;
      inner.setNow(new Date(phaseMs));
      const quote = await inner.getPrice(referenceAsset);
      if (quote === null) return null;
      // The demo feed is LIVE: stamp the observation with the current wall clock so the mark is fresh
      // (the replay series supplies the price movement; the freshness is genuine, not back-dated).
      return { ...quote, asOf: now(), source: PAPER_LIVE_REPLAY_SOURCE };
    },
  };
}
