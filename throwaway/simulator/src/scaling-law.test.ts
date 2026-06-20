// THROWAWAY ("Lever 2", SM-C1 corroboration) — tests for the scaling-law / intrinsic-time
// derivation of the worst-plausible-gap `g`, as an INDEPENDENT corroboration of the pre-registered
// floor. Asserts: the DC decomposition, δ-monotonicity, power-law recovery, the derived-g
// corroboration on the real EUR/USD + BTC fixtures, and — critically — that the derivation is
// INDEPENDENT of the reset rate and NEVER mutates the pre-registered floor (SM-C1 falsifiability).
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { type FloorParams } from '../../coupled-math/src/index.js';
import {
  PRE_REGISTERED_FLOOR,
  buildScalingLawReport,
  decomposeDirectionalChanges,
  deriveGapFromScaling,
  fitPowerLaw,
  loadTicksFromFile,
  pricesOf,
  scalingLawReportToJson,
  simulate,
  thresholdGrid,
} from './index.js';

const EURUSD = fileURLToPath(new URL('../fixtures/eurusd.csv', import.meta.url));
const BTC = fileURLToPath(new URL('../fixtures/btc.csv', import.meta.url));

// A hand-built series with KNOWN reversals at δ = 0.10:
//   100 →110 (high) →105 →99   : downturn confirmed at i=3 (99 ≤ 110·0.9), up-overshoot = (110−100)/100 = 0.10
//          →90 (low) →108       : upturn confirmed at i=5 (108 ≥ 90·1.1),  down-overshoot = |90−99|/99 = 9/99
//          →120                 : extends the up trend (no further confirmation)
const KNOWN = ['100', '110', '105', '99', '90', '108', '120'];

describe('intrinsic-time directional-change decomposition', () => {
  it('finds the expected N_dc, event directions/indices and overshoot lengths at a known δ', () => {
    const d = decomposeDirectionalChanges(KNOWN, '0.10');
    expect(d.nDc).toBe(2);
    expect(d.events.map((e) => e.index)).toEqual([3, 5]);
    expect(d.events.map((e) => e.direction)).toEqual(['down', 'up']);
    // up-overshoot (110−100)/100 = 0.10 ; down-overshoot |90−99|/99 = 9/99 = 0.09090909…
    expect(d.events[0]!.overshoot).toBe('0.10000000');
    expect(d.events[1]!.overshoot).toBe('0.09090909');
    // ⟨ω⟩ = (1/10 + 1/11)/2 = 21/220 = 0.09545454…
    expect(d.meanOvershoot).toBe('0.09545454');
  });

  it('is monotone in δ: a larger threshold yields no more directional changes', () => {
    const fine = decomposeDirectionalChanges(KNOWN, '0.05').nDc;
    const mid = decomposeDirectionalChanges(KNOWN, '0.10').nDc;
    const coarse = decomposeDirectionalChanges(KNOWN, '0.20').nDc;
    expect(fine).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThanOrEqual(coarse);
    expect(coarse).toBe(0); // a 20% reversal never occurs in this series
  });

  it('rejects a non-positive threshold (fail-loud) and tolerates a degenerate series', () => {
    expect(() => decomposeDirectionalChanges(KNOWN, '0')).toThrow(RangeError);
    expect(decomposeDirectionalChanges(['100'], '0.1')).toMatchObject({ nDc: 0, meanOvershoot: '0' });
  });
});

describe('scaling-law power-law fit f(δ)=C·δ^α', () => {
  it('recovers C and α on synthetic power-law data with R² ≈ 1', () => {
    const C = 2.5;
    const ALPHA = -1.5;
    const samples = [0.01, 0.02, 0.04, 0.08, 0.16].map((delta) => ({
      delta,
      value: C * delta ** ALPHA,
    }));
    const fit = fitPowerLaw(samples);
    expect(fit.alpha).toBeCloseTo(ALPHA, 8);
    expect(fit.c).toBeCloseTo(C, 6);
    expect(fit.r2).toBeGreaterThan(0.999999);
    expect(fit.samples).toBe(5);
  });

  it('returns a flagged degenerate fit when there is too little signal (< 2 usable samples)', () => {
    expect(fitPowerLaw([])).toMatchObject({ alpha: 0, r2: 0, samples: 0 });
    expect(fitPowerLaw([{ delta: 0.1, value: 3 }])).toMatchObject({ c: 3, alpha: 0, samples: 1 });
  });
});

describe('derive g from the scaling law + corroborate the pre-registered floor', () => {
  const eur = buildScalingLawReport('EUR/USD', loadTicksFromFile(EURUSD));
  const btc = buildScalingLawReport('BTC/USD', loadTicksFromFile(BTC));

  it('derives a finite, positive g_scaling for EUR/USD that CORROBORATES the pre-registered 0.30', () => {
    const g = Number(eur.gScaling);
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeGreaterThan(0);
    // EUR/USD is calm ⇒ small overshoots ⇒ pre-registered 0.30 is conservative.
    expect(g).toBeLessThan(0.3);
    expect(eur.verdict).toBe('CORROBORATES');
    expect(eur.gPreRegistered).toBe('0.30');
  });

  it('derives a LARGER g_scaling for BTC than EUR/USD (higher-vol structure)', () => {
    expect(Number(btc.gScaling)).toBeGreaterThan(Number(eur.gScaling));
    expect(Number(btc.gScaling)).toBeGreaterThan(0);
    // BTC is the stress asset: its own structure implies gaps beyond the committed floor → flagged.
    expect(btc.verdict).toBe('DIVERGES');
  });

  it('produces a deterministic, serializable report (mirrors the trial/report conventions)', () => {
    const json = scalingLawReportToJson(eur);
    expect(JSON.parse(json).asset).toBe('EUR/USD');
    expect(scalingLawReportToJson(eur)).toBe(json); // deterministic
    expect(eur.decompositions.length).toBe(eur.thresholds.length);
    expect(eur.thresholds.length).toBeGreaterThanOrEqual(2);
  });

  it('g_scaling = δ* + extrapolated overshoot from the fitted law (the stated method)', () => {
    const direct = deriveGapFromScaling(eur.overshootFit, eur.stressThreshold);
    expect(direct).toBe(eur.gScaling);
    const deltaStar = Number(eur.stressThreshold);
    const overshoot = eur.overshootFit.c * deltaStar ** eur.overshootFit.alpha;
    expect(Number(eur.gScaling)).toBeCloseTo(deltaStar + Math.max(0, overshoot), 8);
  });
});

describe('SM-C1 falsifiability: the derivation NEVER reads the reset rate or mutates the floor', () => {
  it('the derived g is INDEPENDENT of how many resets the simulator fires on the same series', () => {
    const ticks = loadTicksFromFile(BTC);
    const before = buildScalingLawReport('BTC/USD', ticks);

    // Fire WILDLY different reset counts on the SAME series with two floors — the derivation must
    // not budge, because it reads price structure only (never the reset events / rate).
    const tight: FloorParams = { m: '1', g: '0.05' };
    const wide: FloorParams = { m: '1', g: '0.30' };
    const base = { initialAnchorPrice: pricesOf(ticks)[0]!, leverage: '1', collateralPool: 1000n };
    const tightResets = simulate(ticks, { ...base, floorParams: tight }).resets.length;
    const wideResets = simulate(ticks, { ...base, floorParams: wide }).resets.length;
    expect(tightResets).not.toBe(wideResets); // genuinely different reset regimes

    const after = buildScalingLawReport('BTC/USD', ticks);
    // The full report (g_scaling, fits, decompositions) is byte-for-byte identical regardless.
    expect(scalingLawReportToJson(after)).toBe(scalingLawReportToJson(before));
  });

  it('reads the pre-registered g for COMPARISON only — it never mutates PRE_REGISTERED_FLOOR', () => {
    buildScalingLawReport('EUR/USD', loadTicksFromFile(EURUSD));
    buildScalingLawReport('BTC/USD', loadTicksFromFile(BTC));
    // Pre-registered floor is untouched (and frozen): the committed floor stays 0.30.
    expect(PRE_REGISTERED_FLOOR).toEqual({ m: '1', g: '0.30' });
    expect(Object.isFrozen(PRE_REGISTERED_FLOOR)).toBe(true);
  });

  it('grids thresholds from the series’ own scale: EUR/USD probes are far finer than BTC', () => {
    const eurGrid = thresholdGrid(pricesOf(loadTicksFromFile(EURUSD)));
    const btcGrid = thresholdGrid(pricesOf(loadTicksFromFile(BTC)));
    expect(eurGrid.rMax).toBeLessThan(btcGrid.rMax); // EUR/USD is structurally calmer
    expect(eurGrid.thresholds.length).toBe(btcGrid.thresholds.length);
  });
});
