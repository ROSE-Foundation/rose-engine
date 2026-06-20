// THROWAWAY — Delta Engine PoC (docs/alpha_engine_poc_v1.pdf), Part VII §16 main loop.
//
// Wires §6 (carry pressure), §8–9 (firing + two-regime order size), §10 (window expiry),
// §11–13 (Dutch auction + zero-sum capital update), §14 (carry drain), §15 (bankruptcy) and the
// §18 series recording.
//
// Per-tick order (matching the spec ## Code Map):
//   1. carry accumulation (φ += c) + recompute K at p_int(t-1)
//   2. firing check (φ ≥ d ⇒ place home-currency order, reset φ = 0)
//   3. queue expiry (drop orders older than W ticks)
//   4. Dutch auction ⇒ p_int(t); apply zero-sum fills
//   5. carry deduction (home -= c·home), the only non-zero-sum leak ("the house")
//   6. recompute K at p_int(t); bankruptcy (K ≤ ε ⇒ dead, purge its orders)
//   7. record the §18 series
//   8. termination (no alive agents ⇒ stop)
//
// REGIME: lives under /throwaway, Node stdlib only.
import type { Agent } from './agent.js';
import type { Order } from './auction.js';
import type { Params } from './params.js';
import type { Rng } from './rng.js';
import { expireOrders, purgeConsumed, runAuction } from './auction.js';
import { initAgents, k0Min } from './init.js';
import { validateParams } from './params.js';

/** One tick of recorded output (the five §18 series, with long/short splits). */
export interface SeriesRow {
  readonly t: number;
  /** p_int(t) — the endogenous Dutch-auction clearing price. */
  readonly pInt: number;
  /** Unmatched LONG orders remaining in the queue. */
  readonly queueDepthLong: number;
  /** Unmatched SHORT orders remaining in the queue. */
  readonly queueDepthShort: number;
  /** Surviving LONG agents. */
  readonly aliveLong: number;
  /** Surviving SHORT agents. */
  readonly aliveShort: number;
  /** Σ K_i over alive agents in EUR terms — the pool-drain curve. */
  readonly totalCapital: number;
  /** EUR volume cleared this tick. */
  readonly matchedVolume: number;
}

/** The full simulation outcome. */
export interface SimResult {
  readonly params: Params;
  readonly series: SeriesRow[];
  /** The last tick executed. */
  readonly finalTick: number;
  /** Why the loop stopped. */
  readonly reason: 'all-dead' | 'max-ticks';
}

/**
 * Runs the §16 loop with the given params and seeded RNG, returning the §18 series.
 * Deterministic: identical `params` + RNG stream ⇒ identical `series`.
 */
export function runSimulation(params: Params, rng: Rng): SimResult {
  validateParams(params); // throw on non-positive x0/xMin/alpha/q before anything can produce NaN
  const { c, q, W, T, epsilon } = params;
  const agents = initAgents(params, rng);
  const agentsById = new Map<number, Agent>(agents.map((a) => [a.id, a]));
  const baselineK0 = k0Min(agents); // §9 regime base: K_i ≥ K0_min ⇒ fractional, else all-in

  let queue: Order[] = [];
  let pInt = params.x0; // p_int(0) = x0
  const series: SeriesRow[] = [];
  let reason: SimResult['reason'] = 'max-ticks';
  let finalTick = 0;

  // Record the initial p_int(0) row (tick 0): no trade yet, full populations, total_capital = K.
  {
    let aliveLong = 0;
    let aliveShort = 0;
    let totalCapital = 0;
    for (const a of agents) {
      a.K = a.eur + a.btc * pInt;
      totalCapital += a.K;
      if (a.side === 'LONG') aliveLong++;
      else aliveShort++;
    }
    series.push({
      t: 0,
      pInt,
      queueDepthLong: 0,
      queueDepthShort: 0,
      aliveLong,
      aliveShort,
      totalCapital,
      matchedVolume: 0,
    });
  }

  for (let t = 1; t <= T; t++) {
    finalTick = t;
    const prevPrice = pInt;

    // 1. CARRY ACCUMULATION (§6) + recompute K at the previous price (used by the firing regime).
    for (const a of agents) {
      if (!a.alive) continue;
      a.phi += c;
      a.K = a.eur + a.btc * prevPrice;
    }

    // 2. FIRING (§8–9): φ ≥ d ⇒ place a home-currency order, then reset pressure to 0.
    for (const a of agents) {
      if (!a.alive || a.phi < a.d) continue;
      const home = a.side === 'LONG' ? a.eur : a.btc;
      // Above baseline ⇒ fractional home/q; below baseline ⇒ all-in (the mortality regime).
      const rawSize = a.K >= baselineK0 ? home / q : home;
      const size = Math.min(rawSize, home); // cap at home inventory (never negative)
      // Reset pressure ONLY when an order is actually placed. If the home balance is empty so
      // nothing is queued, keep the accumulated pressure (do NOT discard it).
      if (size > FIRE_EPSILON) {
        queue.push({ agentId: a.id, side: a.side, size, tickPlaced: t });
        a.phi = 0;
      }
    }

    // 3. QUEUE EXPIRY (§10).
    queue = expireOrders(queue, t, W);

    // 4. DUTCH AUCTION (§11–12) + zero-sum capital update (§13).
    const result = runAuction(queue, prevPrice, agentsById);
    pInt = result.price;
    for (const fill of result.fills) {
      const a = agentsById.get(fill.agentId);
      if (a === undefined) continue;
      a.eur += fill.eurDelta;
      a.btc += fill.btcDelta;
    }
    queue = purgeConsumed(queue, agentsById);

    // 5. CARRY DEDUCTION (§14): drain the home leg — the only non-zero-sum flow (to "the house").
    for (const a of agents) {
      if (!a.alive) continue;
      if (a.side === 'LONG') a.eur -= c * a.eur;
      else a.btc -= c * a.btc;
    }

    // 6. BANKRUPTCY (§15): recompute K at p_int(t); K ≤ ε ⇒ dead + purge its queued orders.
    let anyDeath = false;
    for (const a of agents) {
      if (!a.alive) continue;
      a.K = a.eur + a.btc * pInt;
      if (a.K <= epsilon) {
        a.alive = false;
        anyDeath = true;
      }
    }
    if (anyDeath) {
      queue = queue.filter((o) => {
        const a = agentsById.get(o.agentId);
        return a !== undefined && a.alive;
      });
    }

    // 7. RECORD (§18).
    let queueDepthLong = 0;
    let queueDepthShort = 0;
    for (const o of queue) {
      if (o.side === 'LONG') queueDepthLong++;
      else queueDepthShort++;
    }
    let aliveLong = 0;
    let aliveShort = 0;
    let totalCapital = 0;
    for (const a of agents) {
      if (!a.alive) continue;
      totalCapital += a.K;
      if (a.side === 'LONG') aliveLong++;
      else aliveShort++;
    }
    series.push({
      t,
      pInt,
      queueDepthLong,
      queueDepthShort,
      aliveLong,
      aliveShort,
      totalCapital,
      matchedVolume: result.matchedVolumeEur,
    });

    // 8. TERMINATION (§16.7): all agents dead ⇒ stop early.
    if (aliveLong + aliveShort === 0) {
      reason = 'all-dead';
      break;
    }
  }

  return { params, series, finalTick, reason };
}

/** Below this (home-currency units) a fired order is too small to bother queueing. */
const FIRE_EPSILON = 1e-9;
