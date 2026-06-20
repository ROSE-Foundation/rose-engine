// THROWAWAY — The DELTA ENGINE trading strategy (Glattfelder/Houweling/Olsen, "A Modern Paradigm
// for Algorithmic Trading", 2025, §5 "The Delta Engine"). A FULL, faithful implementation of all
// six ingredients of §5, as a STRATEGY that trades on a price SERIES.
//
// IMPORTANT — two distinct objects share this package:
//   • the emergent-price MARKET simulator (agent.ts/auction.ts/simulation.ts) is a price GENERATOR;
//   • THIS module is a trading STRATEGY that consumes a price series (a CSV `timestamp,price` tick
//     series, a raw number[] price array, or the emergent simulator's p_int output) and decides
//     trades. They are complementary: the market makes prices, the Delta Engine trades them.
//
// SELF-CONTAINED DC OPERATOR (stated design choice): @throwaway/simulator/src/scaling-law.ts already
// has a directional-change decomposition + power-law fit, and throwaway packages MAY cross-import.
// We deliberately RE-IMPLEMENT a small, self-contained binary-float DC operator here instead, because
// (a) the simulator's operator is built on the EXACT @throwaway/coupled-math Rational/decimal-string
// core (designed for the money/price path, NFR-2) and is batch-only, whereas the Delta Engine runs
// online over binary-float prices (floats are permitted in /throwaway), and (b) this package's ethos
// is "fully self-contained, Node stdlib only". Keeping the operator local avoids dragging coupled-math
// + floor-method into a disposable strategy PoC. The math is the canonical Tsang/Olsen DC convention,
// identical in spirit to the simulator's.
//
// REGIME: lives under /throwaway, Node stdlib only. /prod must NEVER import this.

// ───────────────────────────────────── shared small types ──────────────────────────────────────

/** Direction of a directional-change / breakout: 'up' (rising) or 'down' (falling). */
export type Dir = 'up' | 'down';

/** The opposite direction. */
export function opposite(d: Dir): Dir {
  return d === 'up' ? 'down' : 'up';
}

// ──────────────────────── §5.1 multi-scale intrinsic time (DC operator) ─────────────────────────
//
// One agent per threshold δ_i. At each scale the price series is reduced to its "atoms of activity":
// directional-change events and the overshoots between them (intrinsic time). A DC confirms when the
// price reverses by δ (relative) from the running local extreme; the extreme that the just-ended
// trend reached is an OVERSHOOT EVENT — a PEAK (after an up-trend) or a TROUGH (after a down-trend).

/** A confirmed overshoot extreme (peak after an up-trend, trough after a down-trend). */
export interface Extremum {
  /** Index in the price series where the extreme occurred. */
  readonly index: number;
  /** The extreme price. */
  readonly price: number;
}

/** A confirmed directional-change event emitted by the operator. */
export interface DcEvent {
  /** Index of the tick that CONFIRMED the reversal. */
  readonly confirmIndex: number;
  /** Direction of the confirmed reversal. */
  readonly direction: Dir;
  /** The overshoot extreme of the trend this DC terminated (peak for 'down', trough for 'up'). */
  readonly extreme: Extremum;
  /** Relative overshoot length |extreme − prevConfirmPrice| / prevConfirmPrice (≥ 0). */
  readonly overshoot: number;
}

/** Mutable per-scale directional-change operator state. */
export interface DcState {
  readonly delta: number;
  mode: Dir; // current trend being tracked ('up' ⇒ watching for a downturn)
  extreme: number; // running local extreme (high in 'up', low in 'down')
  extremeIndex: number;
  lastConfirmPrice: number; // price at the previous DC confirmation
}

/** Initialises a DC operator at the first price (canonical: start tracking an up-trend). */
export function createDcState(delta: number, firstPrice: number): DcState {
  if (!(delta > 0)) throw new RangeError(`DC threshold δ must be > 0: ${delta}`);
  return { delta, mode: 'up', extreme: firstPrice, extremeIndex: 0, lastConfirmPrice: firstPrice };
}

/**
 * Advances the operator by one tick. Returns the confirmed `DcEvent` when this tick triggers a
 * directional change, else `null`. Mutates `state`. Canonical Tsang/Olsen convention.
 */
export function stepDc(state: DcState, price: number, index: number): DcEvent | null {
  const { delta } = state;
  if (state.mode === 'up') {
    if (price <= state.extreme * (1 - delta)) {
      // Downturn confirmed: the prior up-trend's PEAK is finalised.
      const extreme: Extremum = { index: state.extremeIndex, price: state.extreme };
      const overshoot = Math.abs(state.extreme - state.lastConfirmPrice) / state.lastConfirmPrice;
      state.mode = 'down';
      state.extreme = price;
      state.extremeIndex = index;
      state.lastConfirmPrice = price;
      return { confirmIndex: index, direction: 'down', extreme, overshoot };
    }
    if (price > state.extreme) {
      state.extreme = price;
      state.extremeIndex = index;
    }
    return null;
  }
  // mode === 'down'
  if (price >= state.extreme * (1 + delta)) {
    // Upturn confirmed: the prior down-trend's TROUGH is finalised.
    const extreme: Extremum = { index: state.extremeIndex, price: state.extreme };
    const overshoot = Math.abs(state.extreme - state.lastConfirmPrice) / state.lastConfirmPrice;
    state.mode = 'up';
    state.extreme = price;
    state.extremeIndex = index;
    state.lastConfirmPrice = price;
    return { confirmIndex: index, direction: 'up', extreme, overshoot };
  }
  if (price < state.extreme) {
    state.extreme = price;
    state.extremeIndex = index;
  }
  return null;
}

/**
 * Batch DC decomposition of a price series at a single threshold (used by tests + reporting). The
 * online `stepDc` above produces exactly this sequence of events.
 */
export function decomposeDc(prices: readonly number[], delta: number): DcEvent[] {
  const events: DcEvent[] = [];
  if (prices.length < 2) return events;
  const st = createDcState(delta, prices[0]!);
  for (let i = 1; i < prices.length; i++) {
    const ev = stepDc(st, prices[i]!, i);
    if (ev) events.push(ev);
  }
  return events;
}

// ──────────────────────────── §5.2 adaptive decision landscapes (line fits) ─────────────────────
//
// "For each threshold and various look-back sizes, resistance and support lines are fitted to the
// upward and downward overshoot events, respectively." We fit a straight line (ordinary least
// squares over (index, price)) to the last `lookback` PEAKS → resistance, and to the last `lookback`
// TROUGHS → support. OLS over recent extrema is the stated, deliberately-simple method.

/** A fitted line y = slope·x + intercept. */
export interface Line {
  readonly slope: number;
  readonly intercept: number;
}

/** OLS line through points (x,y). Returns null for 0 points; a flat line for 1 point. */
export function fitLine(points: readonly Extremum[]): Line | null {
  const n = points.length;
  if (n === 0) return null;
  if (n === 1) return { slope: 0, intercept: points[0]!.price };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.index;
    sy += p.price;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.index - mx;
    sxx += dx * dx;
    sxy += dx * (p.price - my);
  }
  if (sxx === 0) return { slope: 0, intercept: my }; // all extrema at one index — flat
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Evaluates a line at x. */
export function lineAt(line: Line, x: number): number {
  return line.slope * x + line.intercept;
}

// ──────────────────────── §5.5 feedback loop — DC-count volatility & silencing ──────────────────
//
// "The number of directional changes scaling law acts as a volatility measure reflecting the current
// market state. Calibrating to this rhythm, agents can fall out of sync and be temporarily silenced."
//
// Over a rolling window we count each scale's realised DC events N_dc(δ_i). The empirical scaling law
// is N_dc(δ) = C·δ^α — a straight line in log-log space. We fit (lnδ_i, lnN_i) by OLS across the
// scales WITH activity, then SILENCE any scale whose realised activity is "out of sync" with that
// collective rhythm: |ln N_i − (lnC + α·lnδ_i)| > tolerance. A silenced agent does not contribute
// signals this tick. This is the feedback by which the volatility regime fine-tunes which scales act.

/** OLS fit of y = slope·x + intercept; null if <2 points or x has no spread. */
function olsLogFit(xs: readonly number[], ys: readonly number[]): Line | null {
  const m = xs.length;
  if (m < 2) return null;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < m; k++) {
    mx += xs[k]!;
    my += ys[k]!;
  }
  mx /= m;
  my /= m;
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < m; k++) {
    const dx = xs[k]! - mx;
    sxx += dx * dx;
    sxy += dx * (ys[k]! - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * Pure silencing rule (§5.5 feedback loop). Given the per-scale thresholds and their realised DC
 * counts over the window, returns a boolean[] (true ⇒ silenced this tick). A scale is "out of sync"
 * with the collective volatility rhythm when its realised DC count departs from what the OTHER
 * scales' scaling law N_dc(δ)=C·δ^α predicts for it. We use a LEAVE-ONE-OUT log-log fit: for each
 * active scale i we fit the law over the OTHER active scales and silence i when
 * |ln N_i − (lnC + α·lnδ_i)| > tolerance. Leave-one-out is deliberate — an OLS fit over ALL scales
 * lets an outlier drag the line toward itself and mask its own mismatch; comparing each agent to what
 * the others imply is exactly "falling out of sync with the collective". Scales with zero activity
 * are DORMANT (not silenced — absence of events is normal). With fewer than three active scales the
 * law is under-determined for any leave-one-out fit and NOBODY is silenced.
 */
export function computeSilencedFlags(
  thresholds: readonly number[],
  counts: readonly number[],
  tolerance: number,
): boolean[] {
  const n = thresholds.length;
  const flags = new Array<boolean>(n).fill(false);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (counts[i]! > 0 && thresholds[i]! > 0) idx.push(i);
  }
  if (idx.length < 3) return flags; // need ≥2 "others" to fit the law for each leave-one-out
  const lnD = idx.map((i) => Math.log(thresholds[i]!));
  const lnN = idx.map((i) => Math.log(counts[i]!));
  for (let k = 0; k < idx.length; k++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = 0; j < idx.length; j++) {
      if (j === k) continue;
      xs.push(lnD[j]!);
      ys.push(lnN[j]!);
    }
    const fit = olsLogFit(xs, ys);
    if (fit === null) continue; // others' δ all identical — cannot judge
    const predicted = fit.slope * lnD[k]! + fit.intercept;
    if (Math.abs(lnN[k]! - predicted) > tolerance) flags[idx[k]!] = true;
  }
  return flags;
}

// ─────────────────────── §5.4 + §5.6 contrarian aggregation & ±u execution ──────────────────────
//
// "The Delta Engine exclusively trades on contrarian breakout signals. When an initial signal occurs,
// the algorithm executes a long or short trade of size u. Now, only a breakout signal identifying a
// reversal of the initial trend will generate an offsetting trade of size 2u. As a result, the net
// exposure oscillates between +u and −u." There is NO take-profit / stop-loss: positions change ONLY
// on a contrarian reversal breakout, never on a PnL target — execution is decoupled from PnL.
//
// CONTRARIAN sign convention: an UP breakout (price breaches resistance) is FADED ⇒ go SHORT (−u);
// a DOWN breakout (price breaches support) is FADED ⇒ go LONG (+u).

/** The strategy's running execution state. */
export interface ExecState {
  /** Net exposure ∈ {+u, 0, −u}. */
  pos: number;
  /** The breakout direction that OPENED the current position (null when flat). */
  initiatingDir: Dir | null;
}

/** The breakouts available this tick from the ACTIVE (non-silenced) scales. */
export interface ActiveBreakouts {
  /** An up breakout fired on at least one active scale. */
  readonly up: boolean;
  /** A down breakout fired on at least one active scale. */
  readonly down: boolean;
  /** Direction of the breakout on the COARSEST (largest-δ) active scale that fired (tie-break). */
  readonly coarsest: Dir | null;
}

/** One executed trade. */
export interface Trade {
  readonly index: number;
  readonly price: number;
  /** 'BUY' increases net exposure, 'SELL' decreases it. */
  readonly side: 'BUY' | 'SELL';
  /** Magnitude traded: u (opening) or 2u (offsetting reversal). */
  readonly size: number;
  /** The contrarian breakout direction that triggered this trade. */
  readonly breakoutDir: Dir;
  /** 'open' = first u from flat; 'reversal' = 2u offsetting flip. */
  readonly reason: 'open' | 'reversal';
  /** Net exposure AFTER the trade (∈ {+u, −u}). */
  readonly netExposureAfter: number;
}

/** Result of a trade decision (pure). */
export interface TradeDecision {
  /** The executed trade's parameters, or null when nothing trades this tick. */
  readonly exec: {
    readonly dir: Dir;
    readonly side: 'BUY' | 'SELL';
    readonly size: number;
    readonly reason: 'open' | 'reversal';
  } | null;
  /** The next execution state. */
  readonly next: ExecState;
}

/**
 * THE CONTRARIAN ±u RULE (pure, the heart of §5.6). Given the current execution state and the
 * breakouts produced by the active scales this tick:
 *   • flat (pos 0): the coarsest active breakout OPENS a contrarian position of size u
 *     (up ⇒ short −u, down ⇒ long +u). `initiatingDir` records the breakout that opened it.
 *   • positioned: a trade fires ONLY if an active scale produced a breakout in the REVERSAL
 *     direction (opposite to `initiatingDir`) — a contrarian counter-trend signal. That flips the
 *     position with an OFFSETTING trade of size 2u (e.g. +u → −u). A breakout in the SAME direction
 *     as `initiatingDir` is a trend CONTINUATION and is IGNORED (no trade).
 * The net exposure therefore always stays in {+u, 0, −u} and every flip is exactly 2u.
 */
export function decideTrade(st: ExecState, b: ActiveBreakouts, u: number): TradeDecision {
  if (st.pos === 0) {
    const dir = b.coarsest;
    if (dir === null) return { exec: null, next: st };
    const target = dir === 'up' ? -u : u; // contrarian: fade the breakout
    const side: 'BUY' | 'SELL' = target > 0 ? 'BUY' : 'SELL';
    return {
      exec: { dir, side, size: Math.abs(target - 0), reason: 'open' },
      next: { pos: target, initiatingDir: dir },
    };
  }
  // Positioned: only a reversal (contrarian) breakout trades.
  const reversal = opposite(st.initiatingDir!);
  const reversalFired = reversal === 'up' ? b.up : b.down;
  if (!reversalFired) return { exec: null, next: st };
  const target = reversal === 'up' ? -u : u; // fade the reversal breakout
  const side: 'BUY' | 'SELL' = target > st.pos ? 'BUY' : 'SELL';
  return {
    exec: { dir: reversal, side, size: Math.abs(target - st.pos), reason: 'reversal' },
    next: { pos: target, initiatingDir: reversal },
  };
}

// ─────────────────────────────────── configuration & run output ─────────────────────────────────

/** A `timestamp,price` tick (price may arrive as a decimal string from CSV, or a number). */
export interface DeltaTickInput {
  readonly timestamp: string;
  readonly price: number | string;
}

/** Delta Engine configuration. Deliberately MINIMAL (anti-overfit, §5 closing paragraph). */
export interface DeltaConfig {
  /** Raw price series (mutually exclusive with `ticks`). */
  readonly prices?: readonly number[];
  /** `timestamp,price` tick series (mutually exclusive with `prices`). */
  readonly ticks?: readonly DeltaTickInput[];
  /** Intrinsic-time thresholds {δ_1,…,δ_n} — "quintessential" (§5). */
  readonly thresholds?: readonly number[];
  /** Line-fit look-back sizes (number of recent overshoot extrema per fit). */
  readonly lookbacks?: readonly number[];
  /** Unit trade size u. */
  readonly u?: number;
  /** Rolling window (ticks) for the DC-count volatility measure. */
  readonly volWindow?: number;
  /** Log-space residual tolerance beyond which a scale is silenced. */
  readonly silenceTolerance?: number;
  /** Seed used ONLY when neither `prices` nor `ticks` is given (falls back to the emergent market). */
  readonly seed?: number;
}

/** The resolved configuration actually used by a run (defaults applied). */
export interface ResolvedDeltaConfig {
  readonly thresholds: number[];
  readonly lookbacks: number[];
  readonly u: number;
  readonly volWindow: number;
  readonly silenceTolerance: number;
  readonly priceSource: 'prices' | 'ticks' | 'emergent';
  readonly seed: number | null;
}

/** Per-scale state recorded for one tick (intrinsic-time + decision landscape + feedback). */
export interface ScaleTick {
  readonly delta: number;
  /** Current DC trend direction being tracked. */
  readonly mode: Dir;
  /** Realised DC count within the volatility window. */
  readonly dcCount: number;
  /** Representative resistance line value at this tick (longest look-back), or null. */
  readonly resistance: number | null;
  /** Representative support line value at this tick (longest look-back), or null. */
  readonly support: number | null;
  /** This scale's breakout this tick ('up' = broke resistance, 'down' = broke support). */
  readonly breakout: Dir | null;
  /** Whether this agent is silenced (out of sync with the volatility regime) this tick. */
  readonly silenced: boolean;
}

/** One recorded tick of a Delta Engine run. */
export interface DeltaTickRow {
  readonly index: number;
  readonly timestamp: string;
  readonly price: number;
  readonly scales: ScaleTick[];
  /** Count of active (non-silenced) scales this tick. */
  readonly activeScales: number;
  /** Count of silenced scales this tick. */
  readonly silencedScales: number;
  /** Coarsest active breakout this tick, regardless of whether it traded. */
  readonly anyBreakout: Dir | null;
  /** Net exposure after this tick ∈ {+u, 0, −u}. */
  readonly netExposure: number;
  /** Signed size traded this tick (0, ±u, or ±2u). */
  readonly tradeSize: number;
}

/** Summary statistics of a run (reporting only — never feeds the decision logic). */
export interface DeltaSummary {
  readonly ticks: number;
  readonly trades: number;
  readonly reversals: number;
  readonly finalNetExposure: number;
  /** Largest |net exposure| reached — MUST equal u (the ±u invariant). */
  readonly maxAbsExposure: number;
  /** Ticks on which at least one scale was silenced. */
  readonly silencedTickCount: number;
  /** Total confirmed DC events across all scales. */
  readonly dcEvents: number;
  /** Mark-to-market PnL of the strategy at the final price (reporting only). */
  readonly markToMarketPnl: number;
}

/** A confirmed DC event recorded during a run, tagged with the scale it occurred on (for viz). */
export interface RunDcEvent {
  readonly scaleIndex: number;
  readonly delta: number;
  readonly confirmIndex: number;
  readonly direction: Dir;
  /** Index + price of the overshoot extreme finalised by this DC (peak for 'down', trough 'up'). */
  readonly extremeIndex: number;
  readonly extremePrice: number;
}

/** The full outcome of a Delta Engine run. */
export interface DeltaResult {
  readonly config: ResolvedDeltaConfig;
  readonly series: DeltaTickRow[];
  readonly trades: Trade[];
  /** All confirmed DC events across every scale (intrinsic-time atoms), for visualisation. */
  readonly dcEvents: RunDcEvent[];
  readonly summary: DeltaSummary;
}

/** Sensible, documented defaults (a minimal parameter set, §5 anti-overfit). */
export const DEFAULT_DELTA_CONFIG = {
  /** Four geometrically-spaced scales spanning ~0.25%–2% reversals. */
  thresholds: [0.0025, 0.005, 0.01, 0.02] as const,
  /** Two look-back sizes for the trend-line fits. */
  lookbacks: [3, 5] as const,
  u: 1,
  volWindow: 250,
  silenceTolerance: 1.25,
  seed: 12345,
} as const;

// ─────────────────────────────── per-scale runtime (private to the run) ─────────────────────────

interface ScaleRuntime {
  readonly delta: number;
  readonly dc: DcState;
  /** Finalised PEAKS (resistance points), in order. */
  readonly peaks: Extremum[];
  /** Finalised TROUGHS (support points), in order. */
  readonly troughs: Extremum[];
  /** Confirmation indices of DC events (for the rolling volatility count). */
  readonly dcTicks: number[];
  /** Per-look-back edge state: was price above resistance / below support last tick. */
  readonly aboveRes: boolean[];
  readonly belowSup: boolean[];
}

/**
 * Computes a scale's breakout this tick across all look-backs (edge-triggered: fires only on a fresh
 * cross). Updates the per-look-back edge state. Returns the breakout dir, plus the representative
 * (longest look-back) resistance/support values for recording. A scale that fires BOTH an up and a
 * down cross on the same tick is treated as ambiguous (null).
 */
function scaleBreakout(
  rt: ScaleRuntime,
  price: number,
  index: number,
  lookbacks: readonly number[],
): { dir: Dir | null; resistance: number | null; support: number | null } {
  let up = false;
  let down = false;
  let reprRes: number | null = null;
  let reprSup: number | null = null;
  for (let li = 0; li < lookbacks.length; li++) {
    const L = lookbacks[li]!;
    const resLine = fitLine(rt.peaks.slice(-L));
    const supLine = fitLine(rt.troughs.slice(-L));
    const resVal = resLine ? lineAt(resLine, index) : null;
    const supVal = supLine ? lineAt(supLine, index) : null;
    // Representative values come from the LAST (longest) look-back present.
    if (resVal !== null) reprRes = resVal;
    if (supVal !== null) reprSup = supVal;

    const isAbove = resVal !== null && price > resVal;
    const isBelow = supVal !== null && price < supVal;
    if (isAbove && !rt.aboveRes[li]) up = true;
    if (isBelow && !rt.belowSup[li]) down = true;
    rt.aboveRes[li] = isAbove;
    rt.belowSup[li] = isBelow;
  }
  const dir: Dir | null = up && !down ? 'up' : down && !up ? 'down' : null;
  return { dir, resistance: reprRes, support: reprSup };
}

// ──────────────────────────────────────────── the run ───────────────────────────────────────────

/** Resolves the input price series + timestamps from the config (prices | ticks | emergent market). */
function resolvePrices(config: DeltaConfig): {
  prices: number[];
  timestamps: string[];
  source: ResolvedDeltaConfig['priceSource'];
  seed: number | null;
} {
  if (config.prices && config.prices.length > 0) {
    return {
      prices: config.prices.map((p) => Number(p)),
      timestamps: config.prices.map((_, i) => String(i)),
      source: 'prices',
      seed: null,
    };
  }
  if (config.ticks && config.ticks.length > 0) {
    return {
      prices: config.ticks.map((t) => Number(t.price)),
      timestamps: config.ticks.map((t) => t.timestamp),
      source: 'ticks',
      seed: null,
    };
  }
  // No inline series: the caller must supply one. To trade on the emergent market, run the
  // simulator (runSimulation) and pass its p_int as `prices` — see run-delta.ts / gen-asset.ts.
  throw new Error(
    'runDeltaEngine: no price source. Pass { prices } (e.g. the emergent simulator p_int) or { ticks }.',
  );
}

/**
 * Runs the FULL Delta Engine (§5) over a price series. Deterministic: identical config ⇒ identical
 * output. The six §5 ingredients map to code as:
 *   1. multi-scale intrinsic time → one `DcState` per threshold (`stepDc`);
 *   2. adaptive decision landscapes → `fitLine` over recent peaks/troughs per look-back;
 *   3. breakout signal → `scaleBreakout` (edge-triggered breach of a fitted line);
 *   4. contrarian aggregation → `decideTrade` over the active scales' breakouts;
 *   5. feedback / silencing → `computeSilencedFlags` from the rolling DC-count scaling law;
 *   6. ±u contrarian execution decoupled from PnL → `decideTrade`'s open(u)/reversal(2u) flips.
 */
export function runDeltaEngine(config: DeltaConfig): DeltaResult {
  const { prices, timestamps, source, seed } = resolvePrices(config);
  const thresholds = [...(config.thresholds ?? DEFAULT_DELTA_CONFIG.thresholds)];
  const lookbacks = [...(config.lookbacks ?? DEFAULT_DELTA_CONFIG.lookbacks)];
  const u = config.u ?? DEFAULT_DELTA_CONFIG.u;
  const volWindow = config.volWindow ?? DEFAULT_DELTA_CONFIG.volWindow;
  const silenceTolerance = config.silenceTolerance ?? DEFAULT_DELTA_CONFIG.silenceTolerance;
  if (!(u > 0)) throw new RangeError(`u must be > 0: ${u}`);
  if (thresholds.length === 0) throw new RangeError('thresholds must be non-empty');
  if (lookbacks.length === 0) throw new RangeError('lookbacks must be non-empty');

  const resolved: ResolvedDeltaConfig = {
    thresholds,
    lookbacks,
    u,
    volWindow,
    silenceTolerance,
    priceSource: source,
    seed,
  };

  const series: DeltaTickRow[] = [];
  const trades: Trade[] = [];
  const dcEvents: RunDcEvent[] = [];
  if (prices.length === 0) {
    return {
      config: resolved,
      series,
      trades,
      dcEvents,
      summary: {
        ticks: 0,
        trades: 0,
        reversals: 0,
        finalNetExposure: 0,
        maxAbsExposure: 0,
        silencedTickCount: 0,
        dcEvents: 0,
        markToMarketPnl: 0,
      },
    };
  }

  // The coarsest scale (largest δ) drives the flat-open tie-break; sort indices by δ descending.
  const byDeltaDesc = thresholds.map((d, i) => ({ d, i })).sort((a, b) => b.d - a.d);

  const runtimes: ScaleRuntime[] = thresholds.map((delta) => ({
    delta,
    dc: createDcState(delta, prices[0]!),
    peaks: [],
    troughs: [],
    dcTicks: [],
    aboveRes: lookbacks.map(() => false),
    belowSup: lookbacks.map(() => false),
  }));

  let exec: ExecState = { pos: 0, initiatingDir: null };
  let cash = 0; // strategy cash (for mark-to-market PnL reporting only)
  let maxAbsExposure = 0;
  let silencedTickCount = 0;
  let totalDcEvents = 0;

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i]!;

    // 1. + part of 5: advance each scale's DC operator; finalise peaks/troughs + count events.
    if (i > 0) {
      for (let s = 0; s < runtimes.length; s++) {
        const rt = runtimes[s]!;
        const ev = stepDc(rt.dc, price, i);
        if (ev) {
          totalDcEvents++;
          if (ev.direction === 'down') rt.peaks.push(ev.extreme);
          else rt.troughs.push(ev.extreme);
          rt.dcTicks.push(i);
          dcEvents.push({
            scaleIndex: s,
            delta: rt.delta,
            confirmIndex: ev.confirmIndex,
            direction: ev.direction,
            extremeIndex: ev.extreme.index,
            extremePrice: ev.extreme.price,
          });
        }
      }
    }

    // 5. feedback: rolling DC-count per scale over the window ⇒ scaling-law silencing.
    const counts = runtimes.map((rt) => {
      let c = 0;
      for (let k = rt.dcTicks.length - 1; k >= 0; k--) {
        if (rt.dcTicks[k]! > i - volWindow) c++;
        else break;
      }
      return c;
    });
    const silenced = computeSilencedFlags(thresholds, counts, silenceTolerance);

    // 2.+3. decision landscapes + breakout per scale (edge state updates for ALL scales).
    const breakoutDir: (Dir | null)[] = new Array(runtimes.length).fill(null);
    const reprRes: (number | null)[] = new Array(runtimes.length).fill(null);
    const reprSup: (number | null)[] = new Array(runtimes.length).fill(null);
    for (let s = 0; s < runtimes.length; s++) {
      const b = scaleBreakout(runtimes[s]!, price, i, lookbacks);
      breakoutDir[s] = b.dir;
      reprRes[s] = b.resistance;
      reprSup[s] = b.support;
    }

    // 4. aggregate ACTIVE (non-silenced) scales' breakouts.
    let anyUp = false;
    let anyDown = false;
    for (let s = 0; s < runtimes.length; s++) {
      if (silenced[s]) continue;
      if (breakoutDir[s] === 'up') anyUp = true;
      else if (breakoutDir[s] === 'down') anyDown = true;
    }
    let coarsest: Dir | null = null;
    for (const { i: s } of byDeltaDesc) {
      if (silenced[s]) continue;
      if (breakoutDir[s] !== null) {
        coarsest = breakoutDir[s]!;
        break;
      }
    }
    const active: ActiveBreakouts = { up: anyUp, down: anyDown, coarsest };

    // 6. contrarian ±u execution (decoupled from PnL).
    const decision = decideTrade(exec, active, u);
    let tradeSize = 0;
    if (decision.exec) {
      const e = decision.exec;
      const signed = e.side === 'BUY' ? e.size : -e.size;
      cash -= signed * price; // BUY pays cash, SELL receives cash
      tradeSize = signed;
      trades.push({
        index: i,
        price,
        side: e.side,
        size: e.size,
        breakoutDir: e.dir,
        reason: e.reason,
        netExposureAfter: decision.next.pos,
      });
    }
    exec = decision.next;
    if (Math.abs(exec.pos) > maxAbsExposure) maxAbsExposure = Math.abs(exec.pos);

    // record
    let silencedCount = 0;
    const scaleRows: ScaleTick[] = runtimes.map((rt, s) => {
      if (silenced[s]) silencedCount++;
      return {
        delta: rt.delta,
        mode: rt.dc.mode,
        dcCount: counts[s]!,
        resistance: reprRes[s]!,
        support: reprSup[s]!,
        breakout: breakoutDir[s]!,
        silenced: silenced[s]!,
      };
    });
    if (silencedCount > 0) silencedTickCount++;
    series.push({
      index: i,
      timestamp: timestamps[i]!,
      price,
      scales: scaleRows,
      activeScales: runtimes.length - silencedCount,
      silencedScales: silencedCount,
      anyBreakout: coarsest,
      netExposure: exec.pos,
      tradeSize,
    });
  }

  const finalPrice = prices[prices.length - 1]!;
  const summary: DeltaSummary = {
    ticks: prices.length,
    trades: trades.length,
    reversals: trades.filter((t) => t.reason === 'reversal').length,
    finalNetExposure: exec.pos,
    maxAbsExposure,
    silencedTickCount,
    dcEvents: totalDcEvents,
    markToMarketPnl: cash + exec.pos * finalPrice,
  };

  return { config: resolved, series, trades, dcEvents, summary };
}

// ────────────────────────────────────── CSV + JSON serializers ──────────────────────────────────
// Mirrors the emergent simulator's outputs.ts conventions (header row + one row per tick; pretty
// JSON of the whole result).

/** CSV column order for the per-tick Delta Engine series. */
export const DELTA_SERIES_COLUMNS = [
  'index',
  'timestamp',
  'price',
  'net_exposure',
  'trade_size',
  'any_breakout',
  'active_scales',
  'silenced_scales',
] as const;

/** Serialises the per-tick series to CSV text. */
export function deltaToCsv(series: readonly DeltaTickRow[]): string {
  const lines: string[] = [DELTA_SERIES_COLUMNS.join(',')];
  for (const r of series) {
    lines.push(
      [
        r.index,
        r.timestamp,
        r.price,
        r.netExposure,
        r.tradeSize,
        r.anyBreakout ?? '',
        r.activeScales,
        r.silencedScales,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Serialises the full run (config, summary, trades, series) to pretty JSON text. */
export function deltaToJson(result: DeltaResult): string {
  return (
    JSON.stringify(
      {
        config: result.config,
        summary: result.summary,
        trades: result.trades,
        dcEvents: result.dcEvents,
        series: result.series,
      },
      null,
      2,
    ) + '\n'
  );
}
