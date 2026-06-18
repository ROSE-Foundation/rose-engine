// THROWAWAY — Alpha Engine PoC (docs/alpha_engine_poc_v1.pdf) — Dutch-auction tests.
// Covers the I/O matrix's "crossing found" / "no crossing holds price" rows, the two-sided
// crossing price (free to rise AND fall — no ratchet floor), per-trade zero-sum conservation, and
// the remaining-inventory cap across ≥2 same-side orders.
import { describe, it, expect } from 'vitest';
import type { Agent } from './agent.js';
import type { Order } from './auction.js';
import { runAuction } from './auction.js';

function agent(id: number, side: 'LONG' | 'SHORT', eur: number, btc: number): Agent {
  return { id, side, eur, btc, K: eur + btc, K0: eur + btc, phi: 0, d: 1, alive: true };
}

function mapOf(agents: Agent[]): Map<number, Agent> {
  return new Map(agents.map((a) => [a.id, a]));
}

describe('runAuction — crossing found', () => {
  it('clears at the two-sided crossing p_int = D/Btot with exact zero-sum transfer', () => {
    const longA = agent(0, 'LONG', 100, 0);
    const shortA = agent(1, 'SHORT', 0, 100);
    const queue: Order[] = [
      { agentId: 0, side: 'LONG', size: 100, tickPlaced: 1 },
      { agentId: 1, side: 'SHORT', size: 100, tickPlaced: 1 },
    ];
    const res = runAuction(queue, 1.0, mapOf([longA, shortA]));

    // D=100 EUR, Btot=100 BTC ⇒ p_int = 100/100 = 1.0, V = D = 100.
    expect(res.price).toBeCloseTo(1.0, 9);
    expect(res.matchedVolumeEur).toBeCloseTo(100, 9);

    // Zero-sum: EUR moved long→short, BTC moved short→long; both net to zero across all fills.
    const eurSum = res.fills.reduce((s, f) => s + f.eurDelta, 0);
    const btcSum = res.fills.reduce((s, f) => s + f.btcDelta, 0);
    expect(eurSum).toBeCloseTo(0, 9);
    expect(btcSum).toBeCloseTo(0, 9);
    // Sign-pinned: the long PAYS 100 EUR (delta exactly -100) and receives 100 BTC.
    expect(res.fills.find((f) => f.agentId === 0)?.eurDelta).toBeCloseTo(-100, 9);
    expect(res.fills.find((f) => f.agentId === 0)?.btcDelta).toBeCloseTo(100, 9);
  });

  it('price RISES above prev when long demand dominates (D=2·Btot ⇒ p=2)', () => {
    // D=200 EUR demand, Btot=100 BTC supply ⇒ p_int = 200/100 = 2.0 (rose from prev 1.0).
    const longA = agent(0, 'LONG', 200, 0);
    const shortA = agent(1, 'SHORT', 0, 100);
    const queue: Order[] = [
      { agentId: 0, side: 'LONG', size: 200, tickPlaced: 1 },
      { agentId: 1, side: 'SHORT', size: 100, tickPlaced: 1 },
    ];
    const res = runAuction(queue, 1.0, mapOf([longA, shortA]));
    expect(res.price).toBeCloseTo(2.0, 9);
    expect(res.matchedVolumeEur).toBeCloseTo(200, 9); // V = D = 200
    expect(res.fills.reduce((s, f) => s + f.eurDelta, 0)).toBeCloseTo(0, 9);
    expect(res.fills.reduce((s, f) => s + f.btcDelta, 0)).toBeCloseTo(0, 9);
  });

  it('price FALLS below prev when short supply dominates (no ratchet floor): p = 0.5', () => {
    // D=50 EUR, Btot=100 BTC ⇒ p_int = 50/100 = 0.5 — must FALL below prevPrice 1.0 (no floor).
    const longA = agent(0, 'LONG', 50, 0);
    const shortA = agent(1, 'SHORT', 0, 100);
    const queue: Order[] = [
      { agentId: 0, side: 'LONG', size: 50, tickPlaced: 1 },
      { agentId: 1, side: 'SHORT', size: 100, tickPlaced: 1 },
    ];
    const res = runAuction(queue, 1.0, mapOf([longA, shortA]));
    expect(res.price).toBeCloseTo(0.5, 9);
    expect(res.price).toBeLessThan(1.0); // fell below the previous price
    expect(res.matchedVolumeEur).toBeCloseTo(50, 9); // V = D = 50
  });

  it('caps an offer at the agent’s current home inventory (balances cannot go negative)', () => {
    // The long order size (100) exceeds the long's current EUR (40) after carry drain.
    const longA = agent(0, 'LONG', 40, 0);
    const shortA = agent(1, 'SHORT', 0, 100);
    const queue: Order[] = [
      { agentId: 0, side: 'LONG', size: 100, tickPlaced: 1 },
      { agentId: 1, side: 'SHORT', size: 100, tickPlaced: 1 },
    ];
    const res = runAuction(queue, 1.0, mapOf([longA, shortA]));
    // Effective demand capped at 40 EUR ⇒ V = 40, long pays exactly its 40 EUR (sign-pinned).
    expect(res.matchedVolumeEur).toBeCloseTo(40, 9);
    expect(res.fills.find((f) => f.agentId === 0)?.eurDelta).toBeCloseTo(-40, 9);
  });

  it('caps ≥2 same-side orders against REMAINING inventory: agent never oversells / goes negative', () => {
    // One long holds TWO orders summing to 160 EUR but only 100 EUR of inventory.
    const longA = agent(0, 'LONG', 100, 0);
    const shortA = agent(1, 'SHORT', 0, 200);
    const queue: Order[] = [
      { agentId: 0, side: 'LONG', size: 80, tickPlaced: 1 },
      { agentId: 0, side: 'LONG', size: 80, tickPlaced: 1 },
      { agentId: 1, side: 'SHORT', size: 200, tickPlaced: 1 },
    ];
    const res = runAuction(queue, 1.0, mapOf([longA, shortA]));

    // Aggregate EUR the long pays across BOTH its fills must be ≤ its 100 EUR inventory (not 160).
    const longPaid = res.fills
      .filter((f) => f.agentId === 0)
      .reduce((s, f) => s + f.eurDelta, 0);
    expect(longPaid).toBeCloseTo(-100, 9); // committed exactly its inventory, never more
    expect(longA.eur + longPaid).toBeGreaterThanOrEqual(-1e-9); // balance never negative

    // Conservation: EUR and BTC both net to zero across all fills (no currency created).
    expect(res.fills.reduce((s, f) => s + f.eurDelta, 0)).toBeCloseTo(0, 9);
    expect(res.fills.reduce((s, f) => s + f.btcDelta, 0)).toBeCloseTo(0, 9);
  });
});

describe('runAuction — no crossing', () => {
  it('one empty side ⇒ price holds at prev and no fills', () => {
    const longA = agent(0, 'LONG', 100, 0);
    const queue: Order[] = [{ agentId: 0, side: 'LONG', size: 100, tickPlaced: 1 }];
    const res = runAuction(queue, 1.5, mapOf([longA]));
    expect(res.price).toBe(1.5); // p_int(t) = p_int(t-1)
    expect(res.matchedVolumeEur).toBe(0);
    expect(res.fills).toHaveLength(0);
    // Order carries forward (size untouched).
    expect(queue[0]?.size).toBe(100);
  });

  it('ignores orders from dead agents (purged-order behaviour)', () => {
    const dead = agent(0, 'LONG', 100, 0);
    (dead as { alive: boolean }).alive = false;
    const shortA = agent(1, 'SHORT', 0, 100);
    const queue: Order[] = [
      { agentId: 0, side: 'LONG', size: 100, tickPlaced: 1 },
      { agentId: 1, side: 'SHORT', size: 100, tickPlaced: 1 },
    ];
    const res = runAuction(queue, 1.0, mapOf([dead, shortA]));
    // Dead long ⇒ no live demand ⇒ no crossing.
    expect(res.matchedVolumeEur).toBe(0);
    expect(res.fills).toHaveLength(0);
  });
});
