// THROWAWAY (Story 7.3, FR-17 / SM-2 / SM-3 / SM-C1) — the model trial.
//
// Load-bearing consequences:
//   • NO-NEGATIVE-LEG (AC #1): within the barrier every tick keeps both legs ≥ 0 with V_A+V_B=K;
//     the run reports whether ANY leg went negative + the closest approach to the barrier.
//   • ISSUER-NEUTRALITY BREAK (AC #2): a gap PAST the barrier (|L·r| > 1) is reported as a break;
//     a reset that stops AT the barrier (|L·r| = 1) is a clean reset, NOT a break.
//   • JOURNAL EVERY RESET (AC #3): every simulate() reset → a serializable journal entry; 0 resets
//     ⇒ empty journal. Values are exact (bigint → decimal string).
//   • FULL LIFECYCLE (AC #4): PENDING → … → CLOSED; a run with a reset exercises REBALANCING.
//   • SM-C1 (AC #5/#6): EUR/USD ⇒ reset rate ≤ the pre-committed threshold; BTC ⇒ resets expected.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { type FloorParams, loadFloorParams } from '../../coupled-math/src/index.js';
import {
  EURUSD_MAX_PLAUSIBLE_RESET_RATE,
  PRE_REGISTERED_FLOOR,
  buildResetJournal,
  journalToText,
  loadTicksFromFile,
  parseTicks,
  runTrial,
} from './index.js';

const K = 1000n;
const fixture = (name: string) =>
  loadTicksFromFile(fileURLToPath(new URL(`../fixtures/${name}.csv`, import.meta.url)));

describe('no-negative-leg verdict + issuer-neutrality-break report (AC #1, #2)', () => {
  it('a within-barrier tick set ⇒ no negative leg, no breaks, invariant held', () => {
    const ticks = parseTicks('a,100\nb,105\nc,98\nd,102\ne,99');
    const report = runTrial(ticks, {
      initialAnchorPrice: '100',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.noNegativeLeg.anyLegNegative).toBe(false);
    expect(report.noNegativeLeg.issuerNeutralityBreaks).toEqual([]);
    expect(report.noNegativeLeg.invariantHeldWithinBarrier).toBe(true);
    expect(report.resetCount).toBe(0);
  });

  it('a gap PAST the barrier (|L·r| = 1.5 > 1) ⇒ anyLegNegative + one break with the right tick', () => {
    // P₀=100 → 250 at L=1 ⇒ r=1.5 ⇒ a leg would be strictly negative (issuer-neutrality break).
    const ticks = parseTicks('t,250');
    const report = runTrial(ticks, {
      initialAnchorPrice: '100',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.noNegativeLeg.anyLegNegative).toBe(true);
    expect(report.noNegativeLeg.issuerNeutralityBreaks).toHaveLength(1);
    const brk = report.noNegativeLeg.issuerNeutralityBreaks[0]!;
    expect(brk.tickIndex).toBe(0);
    expect(brk.price).toBe('250');
    expect(brk.anchorBefore).toBe('100');
    // The reset that fired is flagged as a gap past the floor.
    expect(report.resetJournal[0]!.gapPastFloor).toBe(true);
  });

  it('a reset that stops EXACTLY at the barrier (|L·r| = 1) is a clean reset, NOT a break', () => {
    // P₀=100 → 200 at L=1 ⇒ r=1.0 ⇒ losing leg is 0 (not negative); legs exist.
    const ticks = parseTicks('t,200');
    const report = runTrial(ticks, {
      initialAnchorPrice: '100',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.noNegativeLeg.anyLegNegative).toBe(false);
    expect(report.noNegativeLeg.issuerNeutralityBreaks).toEqual([]);
    expect(report.resetCount).toBe(1); // a reset DID fire (the floor was breached)
    expect(report.resetJournal[0]!.gapPastFloor).toBe(false);
    // Closest approach reported as exactly 1.0.
    expect(report.noNegativeLeg.closestApproachToBarrier).toBe('1.00000000');
  });
});

describe('journal every reset (audit artifact) (AC #3)', () => {
  it('BTC fixture ⇒ a non-empty journal whose first entry matches the 7.2 reset semantics', () => {
    const report = runTrial(fixture('btc'), {
      initialAnchorPrice: '60000',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.resetJournal.length).toBeGreaterThanOrEqual(1);
    const first = report.resetJournal[0]!;
    expect(first.anchorBefore).toBe('60000');
    expect(first.price).toBe('16000');
    expect(first.losingLeg).toBe('long'); // a drawdown ⇒ the long leg loses
    expect(first.gapPastFloor).toBe(false); // within the barrier — a clean floor reset
    expect(first.newAnchorPrice).toBe('16000');
    // Locked legs sum to K exactly (bigint via decimal strings).
    expect(BigInt(first.lockedLong) + BigInt(first.lockedShort)).toBe(K);
  });

  it('EUR/USD fixture ⇒ an empty journal (a valid audit artifact, not an error)', () => {
    const report = runTrial(fixture('eurusd'), {
      initialAnchorPrice: '1.0850',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.resetJournal).toEqual([]);
    expect(journalToText(report.resetJournal)).toBe('');
  });

  it('buildResetJournal renders bigint values as decimal strings deterministically', () => {
    const report = runTrial(fixture('btc'), {
      initialAnchorPrice: '60000',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    const text = journalToText(report.resetJournal);
    const lines = text.split('\n');
    expect(lines).toHaveLength(report.resetJournal.length);
    // Round-trips and stays deterministic.
    expect(JSON.parse(lines[0]!).price).toBe('16000');
    expect(typeof JSON.parse(lines[0]!).lockedLong).toBe('string');
  });
});

describe('full lifecycle traversal (AC #4)', () => {
  it('a run with ≥ 1 reset (BTC) exercises the rebalance cluster and reaches CLOSED', () => {
    const report = runTrial(fixture('btc'), {
      initialAnchorPrice: '60000',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.lifecycle.final).toBe('CLOSED');
    expect(report.lifecycle.history[0]).toBe('PENDING');
    expect(report.lifecycle.history).toContain('REBALANCING');
    expect(report.lifecycle.history).toContain('PARTIAL'); // first reset exercises the transient
    expect(report.lifecycle.history).toContain('SETTLING');
    expect(report.lifecycle.history.at(-1)).toBe('CLOSED');
  });

  it('a run with 0 resets (EUR/USD) still reaches CLOSED without a rebalance cluster', () => {
    const report = runTrial(fixture('eurusd'), {
      initialAnchorPrice: '1.0850',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.lifecycle.final).toBe('CLOSED');
    expect(report.lifecycle.history).toEqual(['PENDING', 'ACTIVE', 'SETTLING', 'CLOSED']);
  });
});

describe('SM-C1 — pre-registered floor, EUR/USD near-zero vs BTC resets (AC #5, #6)', () => {
  it('EUR/USD at L=1 ⇒ reset rate at/below the pre-committed threshold (PASSES), clean trial', () => {
    const report = runTrial(fixture('eurusd'), {
      initialAnchorPrice: '1.0850',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR, // the pre-registered floor, not a looser one
    });
    expect(report.resetCount).toBe(0);
    expect(report.resetCount / report.ticksProcessed).toBeLessThanOrEqual(
      EURUSD_MAX_PLAUSIBLE_RESET_RATE,
    );
    expect(Number(report.resetRate)).toBe(0);
    expect(report.noNegativeLeg.anyLegNegative).toBe(false);
    expect(report.resetJournal).toEqual([]);
    expect(report.lifecycle.final).toBe('CLOSED');
  });

  it('BTC at L=1 ⇒ resets expected (the stress test); SM-C1 does not apply to BTC', () => {
    const report = runTrial(fixture('btc'), {
      initialAnchorPrice: '60000',
      leverage: '1',
      collateralPool: K,
      floorParams: PRE_REGISTERED_FLOOR,
    });
    expect(report.resetCount).toBeGreaterThan(0);
    expect(Number(report.resetRate)).toBeGreaterThan(0);
    expect(report.lifecycle.history).toContain('REBALANCING');
  });
});

describe('regime / refuse-if-absent passthrough (AC #5, #7)', () => {
  it('floor params stay refuse-if-absent (no defaulting) — reused from 7.1', () => {
    expect(() => loadFloorParams({})).toThrow();
  });

  it('the trial refuses a degenerate floor f = m·L·g ≥ 1 (inherited from simulate)', () => {
    const degenerate: FloorParams = { m: '1', g: '1' };
    expect(() =>
      runTrial(parseTicks('a,100\nb,101'), {
        initialAnchorPrice: '100',
        leverage: '1',
        collateralPool: K,
        floorParams: degenerate,
      }),
    ).toThrow();
  });
});
