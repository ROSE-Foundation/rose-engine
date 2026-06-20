// THROWAWAY — Delta Engine PoC (docs/alpha_engine_poc_v1.pdf), Part VIII §17 parameter table.
//
// Encodes the simulation's global parameters. Binary floats are intentional and permitted here
// (NFR-2 binds /prod only — this package is disposable R&D, never imported by /prod).
//
// REGIME: lives under /throwaway, Node stdlib only.

/** Global simulation parameters (PoC §17 "Complete Parameter Table"). */
export interface Params {
  /** Number of agents per side (total agents = 2n). */
  readonly n: number;
  /** Total initial capital in EUR terms, split K/2 per side. */
  readonly K: number;
  /** Initial EUR/BTC price — used for initialisation and as p_int(0). */
  readonly x0: number;
  /** Pareto exponent for the capital distribution. */
  readonly alpha: number;
  /** Pareto minimum capital in EUR terms (baseline size). Derived: K / (n * 10). */
  readonly xMin: number;
  /** Home-currency fraction at initialisation (e.g. 0.9 → agents start 90% home-heavy). */
  readonly f: number;
  /** Carry cost rate per tick. Serves BOTH pressure accrual (phi += c) and capital drain (-= c·home). */
  readonly c: number;
  /** Firing threshold for the smallest agent (the d_i = d_base·K0_i/K0_min base). */
  readonly dBase: number;
  /** Order-size denominator: above-baseline agents trade home/q each firing. */
  readonly q: number;
  /** Clearing window in ticks: orders older than W ticks expire from the queue. */
  readonly W: number;
  /** Bankruptcy threshold in EUR terms. Derived: 0.01 * xMin. */
  readonly epsilon: number;
  /** Maximum simulation ticks. */
  readonly T: number;
}

/**
 * Builds the Part VIII default parameters, deriving `xMin = K/(n*10)` and `epsilon = 0.01*xMin`
 * exactly as the spec's §17 table states (rather than hard-coding the derived numbers).
 */
export function makeDefaultParams(): Params {
  const n = 50;
  const K = 1_000_000;
  const xMin = K / (n * 10); // = 2000
  return {
    n,
    K,
    x0: 1.0,
    alpha: 1.5,
    xMin,
    f: 0.9,
    c: 0.001,
    dBase: 1.0,
    q: 16,
    W: 5,
    epsilon: 0.01 * xMin, // = 20
    T: 10_000,
  };
}

/** The shipped Part VIII defaults. */
export const DEFAULT_PARAMS: Params = makeDefaultParams();

/**
 * Validates the parameters that, if non-positive, would propagate NaN/Infinity through the model
 * (Pareto draw, price init, order sizing). Throws a clear Error rather than running a poisoned sim.
 * Called at the `runSimulation` entry point before any agent is initialised.
 */
export function validateParams(params: Params): void {
  const bad: string[] = [];
  if (!(params.x0 > 0)) bad.push(`x0=${params.x0}`);
  if (!(params.xMin > 0)) bad.push(`xMin=${params.xMin}`);
  if (!(params.alpha > 0)) bad.push(`alpha=${params.alpha}`);
  if (!(params.q > 0)) bad.push(`q=${params.q}`);
  if (bad.length > 0) {
    throw new Error(`Invalid params (must be > 0): ${bad.join(', ')}`);
  }
}
