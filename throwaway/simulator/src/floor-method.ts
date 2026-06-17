// THROWAWAY (Story 7.3, SM-C1) — the PRE-REGISTERED floor parameters `m` and `g`.
//
// WHY THIS FILE EXISTS (falsifiability): SM-C1 requires that `m` and `g` be chosen by a stated,
// defensible method *BEFORE* the reset rate is observed — otherwise "EUR/USD reset rate is near
// zero" is unfalsifiable theatre (pick m/g, then read off the rate those choices produce). The
// adversarial PRD review (review-adversarial-general.md M-3/M-4) flags exactly this. So the floor
// is committed here, in code, with its rationale, and is NEVER retuned to the observed rate.
//
// THE METHOD (stated in advance):
//   • g = "worst plausible gap over the reaction window." Basis: at L = 1 the barrier is ~100%
//     away. EUR/USD single-tick moves over the historical window are sub-1%; a plausible
//     reaction-window gap is bounded well under the barrier. We register g = 0.30 — i.e. we treat
//     a 30% adverse move as the worst plausible gap to protect against. This is far larger than
//     any EUR/USD reaction-window gap (so EUR/USD should essentially never reset) yet is crossed
//     by a BTC-scale bear-market drawdown (the deliberate stress test).
//   • m = "fixed safety margin," registered = 1 (no extra inflation of g; the floor IS the worst
//     plausible gap). Kept simple and documented in advance rather than tuned.
//   ⇒ floor f = m · L · g = 1 · 1 · 0.30 = 0.30 at L = 1; a reset fires when the losing-leg buffer
//     1 − |L·r| ≤ 0.30, i.e. when |L·r| ≥ 0.70 (a 70% adverse leveraged move). f < 1, so it never
//     fires at the neutral point (guarded by `simulate`).
//
// PRE-REGISTERED, not back-fitted: these are the SAME values Story 7.2 already validated fire 0
// EUR/USD resets and ≥1 BTC reset under the SAME floor — we adopt them as the committed method,
// we do not search for values that produce a nice rate.
import { type FloorParams } from '../../coupled-math/src/index.js';

/**
 * The pre-registered floor parameters (SM-C1). Decimal strings (never JS `number` — NFR-2).
 * Committed BEFORE observing the reset rate; never retuned to it.
 */
export const PRE_REGISTERED_FLOOR: FloorParams = Object.freeze({
  m: '1',
  g: '0.30',
});

/**
 * The pre-committed EUR/USD failure threshold (SM-C1): the maximum reset rate (resets / ticks)
 * at which EUR/USD at L = 1 still counts as PASSING. We pre-commit ZERO — under the pre-registered
 * floor, a plausible-floor EUR/USD replay should fire NO resets at all; any EUR/USD reset over the
 * fixture would warrant re-examining the model/parameters. (SM-C1 does NOT apply to BTC: resets
 * are expected there — BTC is the stress test.)
 */
export const EURUSD_MAX_PLAUSIBLE_RESET_RATE = 0;
