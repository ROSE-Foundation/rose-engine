// THROWAWAY ("Lever 2", SM-C1 corroboration) — a scaling-law / intrinsic-time derivation of the
// model floor's worst-plausible-gap `g`, as an INDEPENDENT second opinion on the PRE-REGISTERED
// floor (`throwaway/simulator/src/floor-method.ts`, g = 0.30). It NEVER back-fits and NEVER touches
// the pre-registered floor.
//
// SOURCE PARADIGM: Glattfelder / Houweling / Olsen, "A Modern Paradigm for Algorithmic Trading"
// (2025) — INTRINSIC TIME via DIRECTIONAL CHANGE (DC) and the empirical SCALING LAWS (the number of
// directional changes and the average overshoot length scale with the threshold δ as a power law
// f(δ) = C·δ^α). We use a price series' OWN DC/overshoot structure to derive a defensible `g`.
//
// FALSIFIABILITY STANCE (the whole point — do not violate): SM-C1 requires `m`/`g` to be chosen by a
// stated method BEFORE the reset rate is observed, so "EUR/USD never resets" is falsifiable rather
// than tuned. This module therefore:
//   • reads ONLY the price series (ticks). It NEVER calls `simulate`, NEVER reads the reset rate,
//     and NEVER reads/mutates `PRE_REGISTERED_FLOOR` other than to READ `g` for the side-by-side
//     COMPARISON below. The derived `g_scaling` is independent of how many resets ever fire.
//   • reports `g_scaling` next to the pre-registered `g`, with a verdict (CORROBORATES vs DIVERGES).
//     It is a REPORTED corroboration, never a new committed floor. The committed floor stays 0.30.
//
// REGIME: /throwaway. Reuses the exact-Rational core for the (deterministic, decimal-string-safe) DC
// decomposition; binary floats are used ONLY for the log-log statistics + the reported g_scaling
// (NFR-2 binds /prod only, and this is a reporting artifact — never on the money/price path).
import {
  type Rational,
  ONE,
  abs,
  add,
  cmp,
  div,
  mul,
  parseDecimal,
  sub,
  toApproxString,
} from '../../coupled-math/src/index.js';
import { PRE_REGISTERED_FLOOR } from './floor-method.js';
import { type Tick } from './ticks.js';

// ───────────────────────────── intrinsic-time DC decomposition ─────────────────────────────

/** Direction of a confirmed directional-change event. */
export type DcDirection = 'up' | 'down';

/** One confirmed directional-change event + the overshoot of the trend it terminates. */
export interface DcEvent {
  /** Index (in the price series) of the tick that CONFIRMED the reversal. */
  readonly index: number;
  /** Direction of the confirmed reversal. */
  readonly direction: DcDirection;
  /**
   * Overshoot of the just-ended trend = |extreme − previousConfirmation| / previousConfirmation,
   * the relative continuation BEYOND the prior reversal point up to the local extreme. Decimal
   * string (reporting); ≥ 0 by construction.
   */
  readonly overshoot: string;
}

/** The directional-change decomposition of a price series at a single threshold δ. */
export interface DcDecomposition {
  /** The threshold δ (relative), as a decimal string. */
  readonly delta: string;
  /** Number of confirmed directional changes N_dc(δ). */
  readonly nDc: number;
  /** The confirmed DC events, in order. */
  readonly events: DcEvent[];
  /** Average overshoot length ⟨ω(δ)⟩ over the confirmed events, decimal string ('0' if none). */
  readonly meanOvershoot: string;
}

/**
 * Decomposes a price series into directional-change events + overshoots at threshold `delta`
 * (the directional-change intrinsic-time operator). A DC registers when the price reverses by
 * ≥ δ (relative) from the last local extreme; between DC confirmations the continuation to the
 * next extreme is the overshoot.
 *
 * Initialisation follows the canonical Tsang/Olsen convention: we begin tracking an UP trend from
 * the first price (`mode = 'up'`, extreme = price[0]), so the first confirmed reversal is a
 * downturn unless the series first runs up. Pure + deterministic; all comparisons are EXACT
 * Rationals (no binary float on the price path).
 */
export function decomposeDirectionalChanges(
  prices: readonly string[],
  delta: string,
): DcDecomposition {
  const deltaR = parseDecimal(delta);
  if (cmp(deltaR, { n: 0n, d: 1n }) <= 0) {
    throw new RangeError(`Directional-change threshold δ must be strictly positive: '${delta}'.`);
  }
  const upFactor = add(ONE, deltaR); // 1 + δ  (upturn confirmation multiple)
  const downFactor = sub(ONE, deltaR); // 1 − δ  (downturn confirmation multiple)

  const events: DcEvent[] = [];
  if (prices.length < 2) {
    return { delta, nDc: 0, events, meanOvershoot: '0' };
  }

  let mode: DcDirection = 'up'; // canonical start: tracking an up trend, watching for a downturn
  let extreme = parseDecimal(prices[0]!); // running local extreme (high in 'up', low in 'down')
  let lastConfirmation = extreme; // price of the previous reversal confirmation (start = first price)

  for (let i = 1; i < prices.length; i++) {
    const p = parseDecimal(prices[i]!);
    if (mode === 'up') {
      // Downturn confirmed when price falls δ below the running high.
      if (cmp(p, mul(extreme, downFactor)) <= 0) {
        events.push({
          index: i,
          direction: 'down',
          overshoot: relativeMove(extreme, lastConfirmation),
        });
        mode = 'down';
        extreme = p;
        lastConfirmation = p;
      } else if (cmp(p, extreme) > 0) {
        extreme = p; // extend the up overshoot (new high)
      }
    } else {
      // Upturn confirmed when price rises δ above the running low.
      if (cmp(p, mul(extreme, upFactor)) >= 0) {
        events.push({
          index: i,
          direction: 'up',
          overshoot: relativeMove(extreme, lastConfirmation),
        });
        mode = 'up';
        extreme = p;
        lastConfirmation = p;
      } else if (cmp(p, extreme) < 0) {
        extreme = p; // extend the down overshoot (new low)
      }
    }
  }

  const meanOvershoot =
    events.length === 0
      ? '0'
      : toApproxString(
          div(
            events.reduce<Rational>((acc, e) => add(acc, parseDecimal(e.overshoot)), {
              n: 0n,
              d: 1n,
            }),
            { n: BigInt(events.length), d: 1n },
          ),
        );

  return { delta, nDc: events.length, events, meanOvershoot };
}

/** |a − b| / b as an exact Rational rendered to a decimal string (b must be > 0). */
function relativeMove(a: Rational, b: Rational): string {
  return toApproxString(div(abs(sub(a, b)), b));
}

// ──────────────────────────────────── scaling-law fit ──────────────────────────────────────

/** A fitted power law f(δ) = C·δ^α over a set of (δ, value) samples. */
export interface PowerLawFit {
  /** Prefactor C. */
  readonly c: number;
  /** Exponent α. */
  readonly alpha: number;
  /** Goodness of fit R² in log-log space (1 ⇒ perfect, clamped ≥ 0). */
  readonly r2: number;
  /** Number of (δ, value>0) samples used by the fit. */
  readonly samples: number;
}

/** One (δ, value) sample for the power-law fit. */
export interface ScalingSample {
  readonly delta: number;
  readonly value: number;
}

/**
 * Fits f(δ) = C·δ^α by ordinary least squares in log-log space: ln(value) = ln(C) + α·ln(δ).
 * Only samples with δ > 0 and value > 0 contribute (log undefined otherwise). Requires ≥ 2 such
 * samples with distinct δ; otherwise it cannot identify a slope and returns a flagged degenerate
 * fit (alpha = 0, r2 = 0). This is the empirical scaling law the source paradigm describes.
 */
export function fitPowerLaw(samples: readonly ScalingSample[]): PowerLawFit {
  const usable = samples.filter((s) => s.delta > 0 && s.value > 0 && Number.isFinite(s.value));
  const n = usable.length;
  if (n < 2) {
    // Not enough signal to identify a slope: report a degenerate, clearly-flagged fit.
    return { c: n === 1 ? usable[0]!.value : Number.NaN, alpha: 0, r2: 0, samples: n };
  }
  const xs = usable.map((s) => Math.log(s.delta));
  const ys = usable.map((s) => Math.log(s.value));
  const xBar = mean(xs);
  const yBar = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xBar;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - yBar);
  }
  if (sxx === 0) {
    // All δ identical — slope unidentifiable.
    return { c: Math.exp(yBar), alpha: 0, r2: 0, samples: n };
  }
  const alpha = sxy / sxx;
  const lnC = yBar - alpha * xBar;
  const c = Math.exp(lnC);
  // R² in log space.
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = lnC + alpha * xs[i]!;
    ssRes += (ys[i]! - predicted) ** 2;
    ssTot += (ys[i]! - yBar) ** 2;
  }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);
  return { c, alpha, r2, samples: n };
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) {
    s += x;
  }
  return s / xs.length;
}

// ───────────────────────── derive g from the scaling law + corroboration ────────────────────

/** The committed pre-registered worst-plausible-gap `g` we corroborate against (read-only). */
export const PRE_REGISTERED_G = PRE_REGISTERED_FLOOR.g;

/** The corroboration verdict for one asset's derived g vs the pre-registered g. */
export type ScalingVerdict = 'CORROBORATES' | 'DIVERGES';

/** A full per-asset scaling-law corroboration report. */
export interface ScalingLawReport {
  /** Asset label (e.g. "EUR/USD", "BTC/USD"). */
  readonly asset: string;
  /** The probe thresholds {δ_i} (decimal strings), coarse → calibrated to the series' own scale. */
  readonly thresholds: string[];
  /** The DC decomposition at each δ_i. */
  readonly decompositions: DcDecomposition[];
  /** Fit of N_dc(δ) = C·δ^α (the directional-change-count scaling law). */
  readonly nDcFit: PowerLawFit;
  /** Fit of ⟨ω(δ)⟩ = C·δ^α (the overshoot-length scaling law) — the law g_scaling is derived from. */
  readonly overshootFit: PowerLawFit;
  /** The stress threshold δ* (= the asset's worst single-tick move) the gap is protected against. */
  readonly stressThreshold: string;
  /** The scaling-law-derived worst plausible gap g_scaling (decimal string). */
  readonly gScaling: string;
  /** The pre-registered g (0.30), for side-by-side comparison (read-only). */
  readonly gPreRegistered: string;
  /** CORROBORATES when the pre-registered g ≥ g_scaling (floor is conservative); else DIVERGES. */
  readonly verdict: ScalingVerdict;
  /** Human-readable rationale of the verdict. */
  readonly rationale: string;
}

const GRID_POINTS = 6; // number of probe thresholds in the geometric grid
const GAP_DIGITS = 8; // decimal places for reported gaps/thresholds

/** Extracts the ordered decimal-string prices from a tick series. */
export function pricesOf(ticks: readonly Tick[]): string[] {
  return ticks.map((t) => t.price);
}

/**
 * Builds a geometric grid of probe thresholds {δ_i} self-calibrated to the series: from R_max/16 to
 * R_max/2, where R_max is the largest single-tick relative move the series produced. Each δ_i is a
 * fraction of the asset's OWN demonstrated tick-scale, so the same code probes EUR/USD (sub-1%) and
 * BTC (tens-of-%) at comparable structural resolutions. Returns `{ thresholds, rMax }`.
 */
export function thresholdGrid(prices: readonly string[]): { thresholds: string[]; rMax: number } {
  let rMax = 0;
  for (let i = 1; i < prices.length; i++) {
    const prev = parseDecimal(prices[i - 1]!);
    const cur = parseDecimal(prices[i]!);
    // exact relative move magnitude, lowered to a float only to size the (arbitrary) probe grid
    const move = Number(toApproxString(div(abs(sub(cur, prev)), prev), 12));
    if (move > rMax) {
      rMax = move;
    }
  }
  if (rMax <= 0) {
    return { thresholds: [], rMax: 0 };
  }
  const lo = rMax / 16;
  const hi = rMax / 2;
  const ratio = (hi / lo) ** (1 / (GRID_POINTS - 1));
  const thresholds: string[] = [];
  for (let k = 0; k < GRID_POINTS; k++) {
    thresholds.push((lo * ratio ** k).toFixed(GAP_DIGITS));
  }
  return { thresholds, rMax };
}

/**
 * STATED METHOD for `g_scaling` (mirrors floor-method.ts's discipline — what extreme we protect
 * against and why):
 *
 *   The model floor must cover the "worst plausible gap over the reaction window" — the largest
 *   adverse excursion before a reset can re-anchor. We characterise an excursion via directional
 *   change: a confirmed trend's total move = its confirmation threshold δ PLUS the overshoot ω that
 *   the series statistically adds beyond it. We protect against a FLASH reversal whose confirmation
 *   threshold equals the asset's OWN worst single-tick move δ* = R_max (the most violent step the
 *   series has demonstrated), continued by the overshoot the fitted scaling law ⟨ω(δ)⟩ = C·δ^α
 *   predicts at that threshold:
 *
 *        g_scaling = δ*  +  C·(δ*)^α            (DC component + extrapolated overshoot)
 *
 *   This reads ONLY the price series' own structure — never the reset rate. For a calm series
 *   (EUR/USD) δ* and ω are sub-1%, so g_scaling ≪ 0.30 and the pre-registered floor is shown to be
 *   conservative (CORROBORATES). For a violent series (BTC) δ* alone is tens of %, so g_scaling can
 *   exceed 0.30 (DIVERGES) — correctly flagging the stress asset for review.
 */
export function deriveGapFromScaling(overshootFit: PowerLawFit, stressThreshold: string): string {
  const deltaStar = Number(stressThreshold);
  const predictedOvershoot = overshootFit.c * deltaStar ** overshootFit.alpha;
  const overshoot =
    Number.isFinite(predictedOvershoot) && predictedOvershoot > 0 ? predictedOvershoot : 0;
  const g = deltaStar + overshoot;
  return g.toFixed(GAP_DIGITS);
}

/**
 * Builds the full scaling-law corroboration report for one asset, reading ONLY its tick prices.
 * NEVER calls `simulate`, reads the reset rate, or mutates `PRE_REGISTERED_FLOOR`.
 */
export function buildScalingLawReport(asset: string, ticks: readonly Tick[]): ScalingLawReport {
  const prices = pricesOf(ticks);
  const { thresholds, rMax } = thresholdGrid(prices);
  const decompositions = thresholds.map((d) => decomposeDirectionalChanges(prices, d));

  const nDcFit = fitPowerLaw(
    decompositions.map((d) => ({ delta: Number(d.delta), value: d.nDc })),
  );
  const overshootFit = fitPowerLaw(
    decompositions.map((d) => ({ delta: Number(d.delta), value: Number(d.meanOvershoot) })),
  );

  const stressThreshold = rMax > 0 ? rMax.toFixed(GAP_DIGITS) : '0';
  const gScaling = rMax > 0 ? deriveGapFromScaling(overshootFit, stressThreshold) : '0';
  const gPreRegistered = PRE_REGISTERED_G;

  // EXACT comparison (decimal strings → Rationals): CORROBORATES iff pre-registered g ≥ g_scaling.
  const corroborates = cmp(parseDecimal(gPreRegistered), parseDecimal(gScaling)) >= 0;
  const verdict: ScalingVerdict = corroborates ? 'CORROBORATES' : 'DIVERGES';
  const rationale = corroborates
    ? `pre-registered g=${gPreRegistered} ≥ scaling-law g_scaling=${gScaling} (δ*=${stressThreshold}): ` +
      `the committed floor conservatively covers the worst plausible gap derived from ${asset}'s own ` +
      `DC/overshoot structure — independent corroboration of SM-C1's pre-registered floor.`
    : `scaling-law g_scaling=${gScaling} > pre-registered g=${gPreRegistered} (δ*=${stressThreshold}): ` +
      `${asset}'s own DC/overshoot structure implies worse plausible gaps than the committed floor ` +
      `covers — FLAGGED FOR REVIEW (the committed floor is NOT changed here; this is a reported ` +
      `second opinion). Expected for the high-volatility stress asset.`;

  return {
    asset,
    thresholds,
    decompositions,
    nDcFit,
    overshootFit,
    stressThreshold,
    gScaling,
    gPreRegistered,
    verdict,
    rationale,
  };
}

/** Deterministic JSON serialization of a scaling-law report (mirrors the trial/report conventions). */
export function scalingLawReportToJson(report: ScalingLawReport): string {
  return JSON.stringify(report, null, 2);
}

/** A one-line human summary for a run entrypoint (does NOT affect any pass/fail logic). */
export function scalingLawSummaryLine(report: ScalingLawReport): string {
  return (
    `[scaling-law/Lever2] ${report.asset}: δ*=${report.stressThreshold} ` +
    `g_scaling=${report.gScaling} vs pre-registered g=${report.gPreRegistered} ` +
    `(overshoot fit C=${report.overshootFit.c.toPrecision(4)} α=${report.overshootFit.alpha.toPrecision(
      4,
    )} R²=${report.overshootFit.r2.toFixed(4)}) ⇒ ${report.verdict}`
  );
}
