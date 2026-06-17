// THROWAWAY (Story 7.3, FR-17 / SM-3) — the pure coupled-pair lifecycle state machine.
//
// Load-bearing consequences (AC #4):
//   • The full lifecycle PENDING → ACTIVE → (REBALANCING | PARTIAL | SETTLING) → CLOSED is
//     traversable and the ordered history is observable.
//   • Every transition is validated against the FR-4 single-source set; illegal moves throw.
//   • CLOSED is terminal; same-state no-ops are rejected.
import { describe, expect, it } from 'vitest';
import {
  type CoupledPairState,
  IllegalLifecycleTransitionError,
  LIFECYCLE_TRANSITIONS,
  Lifecycle,
  isTransitionAllowed,
} from './index.js';

describe('lifecycle transition table mirrors the FR-4 single source of truth (AC #4)', () => {
  it('pins the exact allowed-transition set', () => {
    expect(LIFECYCLE_TRANSITIONS).toEqual({
      PENDING: ['ACTIVE'],
      ACTIVE: ['REBALANCING', 'SETTLING'],
      REBALANCING: ['PARTIAL', 'ACTIVE', 'SETTLING'],
      PARTIAL: ['REBALANCING', 'ACTIVE', 'SETTLING'],
      SETTLING: ['CLOSED'],
      CLOSED: [],
    });
  });

  it('ACTIVE → PARTIAL is NOT allowed directly (PARTIAL is a mid-rebalance transient)', () => {
    expect(isTransitionAllowed('ACTIVE', 'PARTIAL')).toBe(false);
    expect(isTransitionAllowed('REBALANCING', 'PARTIAL')).toBe(true);
  });

  it('CLOSED is terminal — no transition out of it is allowed', () => {
    const states: CoupledPairState[] = [
      'PENDING',
      'ACTIVE',
      'REBALANCING',
      'PARTIAL',
      'SETTLING',
      'CLOSED',
    ];
    for (const to of states) {
      expect(isTransitionAllowed('CLOSED', to)).toBe(false);
    }
  });
});

describe('Lifecycle driver — observable traversal (AC #4)', () => {
  it('traverses the FULL lifecycle PENDING → … → CLOSED with a legal, observable history', () => {
    const lc = new Lifecycle();
    expect(lc.current).toBe('PENDING');

    lc.activate();
    lc.beginRebalance();
    lc.partial();
    lc.completeRebalance();
    lc.settle();
    lc.close();

    expect(lc.current).toBe('CLOSED');
    expect(lc.history).toEqual([
      'PENDING',
      'ACTIVE',
      'REBALANCING',
      'PARTIAL',
      'ACTIVE',
      'SETTLING',
      'CLOSED',
    ]);
    // Every consecutive pair in the history must be a legal transition.
    for (let i = 1; i < lc.history.length; i++) {
      expect(isTransitionAllowed(lc.history[i - 1]!, lc.history[i]!)).toBe(true);
    }
  });

  it('completeRebalance works from both REBALANCING and PARTIAL', () => {
    const fromRebalancing = new Lifecycle();
    fromRebalancing.activate();
    fromRebalancing.beginRebalance();
    fromRebalancing.completeRebalance();
    expect(fromRebalancing.current).toBe('ACTIVE');
    expect(fromRebalancing.history).toEqual(['PENDING', 'ACTIVE', 'REBALANCING', 'ACTIVE']);
  });

  it('refuses an illegal transition (PENDING → CLOSED) — fail closed', () => {
    const lc = new Lifecycle();
    expect(() => lc.close()).toThrow(IllegalLifecycleTransitionError);
    // State is unchanged after a refused transition.
    expect(lc.current).toBe('PENDING');
    expect(lc.history).toEqual(['PENDING']);
  });

  it('refuses any move out of CLOSED (no resurrection)', () => {
    const lc = new Lifecycle();
    lc.activate();
    lc.settle();
    lc.close();
    expect(lc.current).toBe('CLOSED');
    expect(() => lc.activate()).toThrow(IllegalLifecycleTransitionError);
    expect(() => lc.beginRebalance()).toThrow(IllegalLifecycleTransitionError);
  });

  it('refuses ACTIVE → PARTIAL directly (skipping the rebalance window)', () => {
    const lc = new Lifecycle();
    lc.activate();
    expect(() => lc.partial()).toThrow(IllegalLifecycleTransitionError);
  });
});
