// THROWAWAY — Alpha Engine PoC (docs/alpha_engine_poc_v1.pdf), Part V §10–12 clearing.
//
// Rolling-window order queue + per-tick Dutch auction that produces the endogenous price p_int.
//
// FROZEN INTERPRETATION (spec ## Design Notes — the authoritative reading of a spec that is loose
// on order denomination):
//   - Orders are in the agent's HOME currency: a long offers EUR, a short offers BTC.
//   - Long demand (EUR) is price-INDEPENDENT: D = Σ long order sizes (EUR).
//   - Short supply in EUR terms RISES with price: S(p) = (Σ short BTC) · p.
//   - The clearing price is the TWO-SIDED CROSSING: the lowest price where cumulative short supply
//     S(p)=Btot·p meets long demand D. Since S(p) is increasing in p, that price is exactly
//     p_int = D / Btot. There is NO max(prev, …) floor — p_int is free to RISE (longs fire more,
//     D up) AND FALL (shorts fire more, Btot up). The previous price is reused ONLY in the genuine
//     no-crossing case: one side empty, Btot = 0, or D = 0 (Spec Change Log 2026-06-18 #1).
//   - Cleared volume V = min(D, Btot·p_int) EUR (= D at p_int=D/Btot); longs fill largest-first up
//     to V EUR (each receives V-pro-rata BTC at `price`), shorts fill largest-first up to V/price
//     BTC (each receives pro-rata EUR). Aggregate conservation is exact; the marginal order
//     partially fills and its residual stays queued.
//   - No crossing (one side empty / Btot = 0 / D = 0) ⇒ price holds, queue carries forward.
//
// Orders are capped at the agent's REMAINING home-currency inventory as it is decremented WITHIN
// the auction: an agent holding ≥2 live same-side orders has each successive offer capped against
// what is left after the earlier offers, never re-against the full starting balance. So aggregate
// fills for an agent can never exceed its inventory and a balance can never go negative.
//
// REGIME: lives under /throwaway, Node stdlib only.
import type { Agent, Side } from './agent.js';

/** Below this (in home-currency units) an order/residual is treated as fully consumed. */
const FILL_EPSILON = 1e-9;

/** A queued order: a home-currency offer (EUR for longs, BTC for shorts) placed at a tick. */
export interface Order {
  readonly agentId: number;
  readonly side: Side;
  /** Remaining offer size in the agent's HOME currency (mutated down as the order fills). */
  size: number;
  readonly tickPlaced: number;
}

/** One agent's balance change from the auction (applied by the caller). */
export interface Fill {
  readonly agentId: number;
  readonly eurDelta: number;
  readonly btcDelta: number;
}

/** The auction outcome for a tick. */
export interface AuctionResult {
  /** The clearing price p_int(t) (= prevPrice when no crossing). */
  readonly price: number;
  /** Total EUR cleared this tick (matched_volume, §18). */
  readonly matchedVolumeEur: number;
  /** Per-order balance deltas to apply to agents. */
  readonly fills: Fill[];
}

/**
 * Rolling-window expiry (§10): drops orders older than W ticks, i.e. keeps `tickPlaced ≥ t - W`.
 * Returns a NEW array; the input is not mutated.
 */
export function expireOrders(queue: readonly Order[], t: number, W: number): Order[] {
  return queue.filter((o) => o.tickPlaced >= t - W);
}

/** Drops fully-consumed orders (size ≤ ε) and orders whose agent is dead/missing. */
export function purgeConsumed(queue: readonly Order[], agentsById: ReadonlyMap<number, Agent>): Order[] {
  return queue.filter((o) => {
    if (o.size <= FILL_EPSILON) return false;
    const a = agentsById.get(o.agentId);
    return a !== undefined && a.alive;
  });
}

/**
 * Runs the Dutch auction over the queue (§11–12) under the frozen Design-Notes interpretation.
 *
 * Reads agent balances (read-only) to cap each offer at current home inventory, MUTATES each
 * matched order's `size` down by the amount it filled (residuals remain queued), and returns the
 * clearing price + per-order balance deltas for the caller to apply. The caller is responsible for
 * purging fully-consumed orders afterwards (see `purgeConsumed`).
 */
export function runAuction(
  queue: readonly Order[],
  prevPrice: number,
  agentsById: ReadonlyMap<number, Agent>,
): AuctionResult {
  // Available offers per side, each capped against the agent's REMAINING home inventory as it is
  // decremented across that agent's successive same-side orders (never re-against the full
  // starting balance). Ignore dead/missing agents.
  const remaining = new Map<number, number>(); // agentId → home inventory not yet committed
  const longs: { order: Order; avail: number }[] = [];
  const shorts: { order: Order; avail: number }[] = [];
  for (const order of queue) {
    const a = agentsById.get(order.agentId);
    if (a === undefined || !a.alive) continue;
    let rem = remaining.get(order.agentId);
    if (rem === undefined) rem = order.side === 'LONG' ? a.eur : a.btc;
    const avail = Math.min(order.size, rem);
    remaining.set(order.agentId, rem - avail);
    if (avail <= FILL_EPSILON) continue;
    if (order.side === 'LONG') longs.push({ order, avail });
    else shorts.push({ order, avail });
  }

  const demandEur = longs.reduce((s, o) => s + o.avail, 0); // D — price-independent
  const supplyBtc = shorts.reduce((s, o) => s + o.avail, 0); // Btot

  // No crossing: one side empty / no supply or demand ⇒ price holds, queue carries forward.
  if (longs.length === 0 || shorts.length === 0 || demandEur <= 0 || supplyBtc <= 0) {
    return { price: prevPrice, matchedVolumeEur: 0, fills: [] };
  }

  // Two-sided crossing: lowest price where short supply Btot·p meets long demand D. Free to rise
  // AND fall — NO max(prev, …) floor (prevPrice is reused only in the no-crossing branch above).
  const price = demandEur / supplyBtc;
  const supplyEurAtPrice = supplyBtc * price;
  const matchedVolumeEur = Math.min(demandEur, supplyEurAtPrice); // V (EUR)
  const matchedBtc = matchedVolumeEur / price; // BTC cleared = V / price

  // Largest-first (§11: sort by size descending). Stable tie-break on agentId for determinism.
  const bySizeDesc = (a: { order: Order; avail: number }, b: { order: Order; avail: number }): number =>
    b.avail - a.avail || a.order.agentId - b.order.agentId;
  longs.sort(bySizeDesc);
  shorts.sort(bySizeDesc);

  const fills: Fill[] = [];

  // Longs give EUR (capped, ≤ Σavail = demand ≥ V), receive V/price BTC pro-rata.
  let remEur = matchedVolumeEur;
  for (const { order, avail } of longs) {
    if (remEur <= FILL_EPSILON) break;
    const give = Math.min(avail, remEur);
    remEur -= give;
    order.size -= give;
    fills.push({ agentId: order.agentId, eurDelta: -give, btcDelta: give / price });
  }

  // Shorts give BTC (capped, ≤ Σavail = supply ≥ matchedBtc), receive pro-rata EUR.
  let remBtc = matchedBtc;
  for (const { order, avail } of shorts) {
    if (remBtc <= FILL_EPSILON) break;
    const give = Math.min(avail, remBtc);
    remBtc -= give;
    order.size -= give;
    fills.push({ agentId: order.agentId, eurDelta: give * price, btcDelta: -give });
  }

  return { price, matchedVolumeEur, fills };
}
