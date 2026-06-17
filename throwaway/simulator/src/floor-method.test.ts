// THROWAWAY (Story 7.3, SM-C1) — the PRE-REGISTERED floor parameters.
//
// Load-bearing consequence (AC #5): `m`/`g` are fixed constants committed BEFORE the reset rate is
// observed, with a documented method — never tuned to manufacture a low rate. This test pins the
// pre-registered values and the pre-committed EUR/USD failure threshold so any change is a visible,
// deliberate edit (falsifiability guard).
import { describe, expect, it } from 'vitest';
import { floor } from '../../coupled-math/src/index.js';
import { EURUSD_MAX_PLAUSIBLE_RESET_RATE, PRE_REGISTERED_FLOOR } from './index.js';

describe('pre-registered floor parameters (SM-C1 falsifiability) (AC #5)', () => {
  it('pins m and g as decimal strings (committed before observing the reset rate)', () => {
    expect(PRE_REGISTERED_FLOOR).toEqual({ m: '1', g: '0.30' });
    // Decimal strings, never JS number (NFR-2).
    expect(typeof PRE_REGISTERED_FLOOR.m).toBe('string');
    expect(typeof PRE_REGISTERED_FLOOR.g).toBe('string');
  });

  it('yields a floor f = m·L·g = 0.30 at L = 1 (f < 1, so it never fires at the neutral point)', () => {
    const f = floor('1', PRE_REGISTERED_FLOOR);
    // f = 0.30 = 3/10.
    expect(f.n).toBe(3n);
    expect(f.d).toBe(10n);
  });

  it('pre-commits the EUR/USD failure threshold to ZERO resets/tick', () => {
    expect(EURUSD_MAX_PLAUSIBLE_RESET_RATE).toBe(0);
  });
});
