// THROWAWAY — Delta Engine PoC (docs/alpha_engine_poc_v1.pdf), §4 init + §7 threshold scaling.
//
// Draws Pareto capital per side, rescales each side to sum K/2, sets opening balances from the
// home fraction f and starting price x0, and assigns the carry-pressure firing threshold
// d_i = d_base·(K0_i / K0_min).
//
// REGIME: lives under /throwaway, Node stdlib only.
import type { Agent, Side } from './agent.js';
import type { Params } from './params.js';
import type { Rng } from './rng.js';
import { paretoSample } from './rng.js';

/** The global minimum initial capital across ALL agents (K0_min) — drives d_i scaling (§7). */
export function k0Min(agents: readonly Agent[]): number {
  let min = Infinity;
  for (const a of agents) {
    if (a.K0 < min) min = a.K0;
  }
  return min;
}

/**
 * Builds the 2n initial agents (§4, §7).
 *
 * Per side: draw n Pareto(xMin, alpha) raw capitals, then rescale so the side sums to K/2 in EUR
 * terms. Opening balances from the home fraction f and price x0:
 *   LONG  (EUR-heavy): eur = K0·f,        btc = K0·(1-f)/x0
 *   SHORT (BTC-heavy): btc = K0·f/x0,     eur = K0·(1-f)
 * so that eur + btc·x0 = K0 for both sides. Then d_i = d_base·(K0_i / K0_min) over all agents.
 */
export function initAgents(params: Params, rng: Rng): Agent[] {
  const { n, K, x0, alpha, xMin, f, dBase } = params;

  const drawSide = (side: Side, idStart: number): { id: number; side: Side; K0: number }[] => {
    const raws: number[] = [];
    for (let i = 0; i < n; i++) raws.push(paretoSample(xMin, alpha, rng()));
    const sum = raws.reduce((s, v) => s + v, 0);
    const scale = K / 2 / sum; // rescale this side to sum exactly K/2 in EUR terms
    return raws.map((r, i) => ({ id: idStart + i, side, K0: r * scale }));
  };

  const raw = [...drawSide('LONG', 0), ...drawSide('SHORT', n)];

  // K0_min over the WHOLE population (both sides) — the §7 scaling base.
  let min = Infinity;
  for (const r of raw) if (r.K0 < min) min = r.K0;

  return raw.map(({ id, side, K0 }): Agent => {
    let eur: number;
    let btc: number;
    if (side === 'LONG') {
      eur = K0 * f;
      btc = (K0 * (1 - f)) / x0;
    } else {
      btc = (K0 * f) / x0;
      eur = K0 * (1 - f);
    }
    return {
      id,
      side,
      eur,
      btc,
      K: eur + btc * x0,
      K0,
      phi: 0,
      d: dBase * (K0 / min),
      alive: true,
    };
  });
}
