// THROWAWAY — Alpha Engine PoC (docs/alpha_engine_poc_v1.pdf), Part II §3 "Agent Structure".
//
// One agent = a simple float record. `side` is fixed for life (the §5 Lane model — a long never
// flips to short). All money/price values are plain JS `number` (floats permitted here; NFR-2
// binds /prod only).
//
// REGIME: lives under /throwaway, Node stdlib only.

/** Fixed agent role (§5 Lane model). LONG = EUR-heavy, offers EUR. SHORT = BTC-heavy, offers BTC. */
export type Side = 'LONG' | 'SHORT';

/** An agent (§3). `K` is derived (eur + btc·p_int); `K0` is the retained initial capital for scaling. */
export interface Agent {
  /** Unique identifier. */
  readonly id: number;
  /** LONG or SHORT — fixed for the agent's lifetime. */
  readonly side: Side;
  /** EUR balance. */
  eur: number;
  /** BTC balance. */
  btc: number;
  /** Total capital in EUR terms (eur + btc·p_int) — recomputed each tick. */
  K: number;
  /** Initial total capital in EUR terms — retained for threshold scaling. */
  readonly K0: number;
  /** Accumulated carry pressure — the agent's internal clock (φ). */
  phi: number;
  /** Firing threshold — scales with K0 (d_i = d_base·K0_i/K0_min). */
  readonly d: number;
  /** False once K falls to/below the bankruptcy threshold. */
  alive: boolean;
}

/** Total capital in EUR terms at a given price: K_i = eur_i + btc_i·p. */
export function capital(agent: Agent, price: number): number {
  return agent.eur + agent.btc * price;
}

/** The agent's home-currency balance: EUR for longs, BTC for shorts (§5 — carry is on the home leg). */
export function homeBalance(agent: Agent): number {
  return agent.side === 'LONG' ? agent.eur : agent.btc;
}
