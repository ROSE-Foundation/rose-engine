// THROWAWAY (Story 7.3, FR-17 / SM-2 / SM-3 / SM-C1) — the model "trial": turn the Story 7.2 reset
// EVENTS into auditable EVIDENCE about the coupled-coin model over a full tick set.
//
// It consumes (never re-implements) Story 7.1 math (`evaluate`) and Story 7.2 `simulate` and
// produces, in one `runTrial(...)`:
//   1. NO-NEGATIVE-LEG VERDICT (SM-2): within the barrier (|L·r| < 1), every tick keeps both legs
//      non-negative with V_A + V_B = K — proven by consequence over the tick set; the closest
//      approach to the barrier is reported so a near-miss is visible.
//   2. ISSUER-NEUTRALITY-BREAK REPORT (the KEY model risk): any single gap PAST the barrier
//      (|L·r| > 1 ⇒ a leg would be negative ⇒ V_A + V_B = K breaks). A reset that stops at or
//      before the barrier (|L·r| ≤ 1) is a clean floor reset, NOT a break.
//   3. JOURNAL EVERY RESET (SM-3 audit artifact): each `simulate` reset → a serializable journal
//      entry (price, locked values, new anchor). bigints render as decimal strings (never floats).
//   4. FULL LIFECYCLE TRAVERSAL (SM-3): a pure in-memory state machine driven PENDING → ACTIVE →
//      (REBALANCING | PARTIAL) → … → SETTLING → CLOSED, with the ordered history observable.
//
// SINGLE SOURCE OF RESET TRUTH: resets come ONLY from `simulate(...)`. The per-tick verdict walk
// reconstructs the anchor timeline FROM those resets (not by an independent reset decision), so the
// verdict and the journal can never disagree about where resets happened.
//
// REGIME: /throwaway. Reuses @throwaway/coupled-math + @throwaway/simulator only. /prod must NEVER
// import this. The reset ECONOMICS / balanced ledger settlement entry is a /prod concern (Epics
// 2/5) and a deferred D1 product decision — out of scope here; this is a throwaway audit artifact.
import {
  type Evaluation,
  type PairParams,
  ZERO,
  abs,
  cmp,
  evaluate,
  rational,
  toApproxString,
} from '../../coupled-math/src/index.js';
import { type CoupledPairState, Lifecycle } from './lifecycle.js';
import { type LosingLeg, type ResetEvent, type SimConfig, simulate } from './simulator.js';
import { type Tick } from './ticks.js';

/** One reset rendered as a serializable, auditable journal entry (bigints as decimal strings). */
export interface ResetJournalEntry {
  readonly tickIndex: number;
  /** Reporting/audit only — never drove the reset (FR-16). */
  readonly timestamp: string;
  /** Breaching price (= the new anchor). */
  readonly price: string;
  /** The anchor (P₀) that was breached. */
  readonly anchorBefore: string;
  /** Locked long-leg value at the breach (smallest units, decimal string). */
  readonly lockedLong: string;
  /** Locked short-leg value at the breach (smallest units, decimal string). */
  readonly lockedShort: string;
  /** Locked loss of the losing holder (smallest units, decimal string). */
  readonly lockedLoss: string;
  /** Which leg lost. */
  readonly losingLeg: LosingLeg;
  /** New anchor P₀ after re-anchoring (= price). */
  readonly newAnchorPrice: string;
  /** True when the breach gapped PAST the barrier (|L·r| > 1) — the issuer-neutrality break. */
  readonly gapPastFloor: boolean;
}

/** A single point where the model's issuer-neutrality broke (a leg would go negative). */
export interface IssuerNeutralityBreak {
  readonly tickIndex: number;
  readonly price: string;
  readonly anchorBefore: string;
  /** |L·r| at the break, lossy decimal — reporting only (it is > 1 here). */
  readonly leveragedDeviationApprox: string;
}

/** The no-negative-leg verdict over the whole tick set (SM-2). */
export interface NoNegativeLegVerdict {
  /** True if ANY tick had a leg that would be negative (|L·r| > 1) — issuer-neutrality break. */
  readonly anyLegNegative: boolean;
  /** True if, on EVERY within-barrier tick, legs exist, are non-negative, and sum to K. */
  readonly invariantHeldWithinBarrier: boolean;
  /** The largest |L·r| observed across the run (lossy decimal) — the closest approach to barrier. */
  readonly closestApproachToBarrier: string;
  /** Every issuer-neutrality break observed (empty ⇒ the model held over the whole tick set). */
  readonly issuerNeutralityBreaks: IssuerNeutralityBreak[];
}

/** The consolidated trial evidence (FR-17). */
export interface TrialReport {
  /** Every reset journaled (empty ⇒ the floor was never breached — a valid audit artifact). */
  readonly resetJournal: ResetJournalEntry[];
  /** The no-negative-leg verdict + issuer-neutrality-break report. */
  readonly noNegativeLeg: NoNegativeLegVerdict;
  /** The observable lifecycle traversal. */
  readonly lifecycle: { readonly final: CoupledPairState; readonly history: CoupledPairState[] };
  /** Number of resets that fired. */
  readonly resetCount: number;
  /** Ticks replayed. */
  readonly ticksProcessed: number;
  /** Reset rate = resets / ticks, as a lossy decimal string (reporting). 0 ticks ⇒ "0". */
  readonly resetRate: string;
  /** Anchor P₀ after the last reset (or the initial anchor if none). */
  readonly finalAnchorPrice: string;
}

/** Maps Story 7.2 `ResetEvent`s to serializable journal entries (bigint → decimal string). */
export function buildResetJournal(resets: readonly ResetEvent[]): ResetJournalEntry[] {
  return resets.map((r) => ({
    tickIndex: r.tickIndex,
    timestamp: r.timestamp,
    price: r.price,
    anchorBefore: r.anchorBefore,
    lockedLong: r.lockedLong.toString(),
    lockedShort: r.lockedShort.toString(),
    lockedLoss: r.lockedLoss.toString(),
    losingLeg: r.losingLeg,
    newAnchorPrice: r.newAnchorPrice,
    gapPastFloor: r.gapPastFloor,
  }));
}

/** Deterministic NDJSON rendering of the reset journal — the human/audit artifact. */
export function journalToText(journal: readonly ResetJournalEntry[]): string {
  return journal.map((e) => JSON.stringify(e)).join('\n');
}

/**
 * Reconstructs, for each tick index, the anchor P₀ that `simulate` evaluated that tick against —
 * derived SOLELY from the resets `simulate` produced. Tick `r.tickIndex` was evaluated against the
 * pre-reset anchor (`r.anchorBefore`); every later tick uses the post-reset anchor (`r.price`)
 * until the next reset. This guarantees the verdict walk and the journal agree on reset points.
 */
function anchorTimeline(
  ticks: readonly Tick[],
  initialAnchorPrice: string,
  resets: readonly ResetEvent[],
): string[] {
  const timeline: string[] = new Array<string>(ticks.length);
  let anchor = initialAnchorPrice;
  let nextResetIdx = 0;
  for (let i = 0; i < ticks.length; i++) {
    timeline[i] = anchor; // the anchor in effect WHEN tick i is evaluated
    if (nextResetIdx < resets.length && resets[nextResetIdx]!.tickIndex === i) {
      anchor = resets[nextResetIdx]!.price; // re-anchor AFTER this breaching tick
      nextResetIdx++;
    }
  }
  return timeline;
}

/** Builds the no-negative-leg verdict by replaying each tick against the reconstructed anchor. */
function judgeNoNegativeLeg(
  ticks: readonly Tick[],
  config: SimConfig,
  resets: readonly ResetEvent[],
): NoNegativeLegVerdict {
  const timeline = anchorTimeline(ticks, config.initialAnchorPrice, resets);
  const breaks: IssuerNeutralityBreak[] = [];
  let anyLegNegative = false;
  let invariantHeldWithinBarrier = true;
  let maxAbsLr = ZERO;

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const params: PairParams = {
      anchorPrice: timeline[i]!,
      leverage: config.leverage,
      collateralPool: config.collateralPool,
    };
    const ev: Evaluation = evaluate(params, tick.price, config.floorParams);

    const absLr = abs(ev.leveragedDeviation);
    // "Closest approach to the barrier" only counts ticks at-or-within the barrier (|L·r| <= 1,
    // which includes the exactly-at-barrier reset tick). Ticks that break past it (|L·r| > 1) are
    // not an "approach" — they are reported separately as issuerNeutralityBreaks below.
    if (!ev.legWouldBeNegative && cmp(absLr, maxAbsLr) > 0) {
      maxAbsLr = absLr;
    }

    if (ev.legWouldBeNegative) {
      // |L·r| > 1 — a leg would be strictly negative: the issuer-neutrality break condition.
      anyLegNegative = true;
      breaks.push({
        tickIndex: i,
        price: tick.price,
        anchorBefore: timeline[i]!,
        leveragedDeviationApprox: toApproxString(ev.leveragedDeviation),
      });
    } else if (ev.withinBarrier && (ev.legs === null || !ev.invariantHolds)) {
      // Defensive: within the barrier the legs MUST exist and sum to K. If this ever trips, the
      // model/library is broken — record it so the proof is honest rather than assumed.
      invariantHeldWithinBarrier = false;
    }
  }

  return {
    anyLegNegative,
    invariantHeldWithinBarrier,
    closestApproachToBarrier: toApproxString(maxAbsLr),
    issuerNeutralityBreaks: breaks,
  };
}

/**
 * Drives a pure lifecycle through the full traversal for the trial: PENDING → ACTIVE, then per
 * reset enter the rebalance cluster (the FIRST reset also exercises the PARTIAL transient so the
 * full state set is observable, SM-3) and return to ACTIVE, then SETTLING → CLOSED at end-of-run.
 */
function traverseLifecycle(resetCount: number): Lifecycle {
  const lc = new Lifecycle();
  lc.activate(); // PENDING → ACTIVE
  for (let i = 0; i < resetCount; i++) {
    lc.beginRebalance(); // ACTIVE → REBALANCING
    if (i === 0) {
      lc.partial(); // REBALANCING → PARTIAL (mid-rebalance transient, once, to exercise it)
    }
    lc.completeRebalance(); // REBALANCING|PARTIAL → ACTIVE
  }
  lc.settle(); // ACTIVE → SETTLING
  lc.close(); // SETTLING → CLOSED (terminal)
  return lc;
}

/**
 * Runs the full model trial over `ticks`: simulates resets (Story 7.2), journals every reset,
 * judges no-negative-leg + reports issuer-neutrality breaks (FR-17), and traverses the full
 * lifecycle (SM-3) — returning the consolidated evidence. Resets come solely from `simulate`.
 */
export function runTrial(ticks: readonly Tick[], config: SimConfig): TrialReport {
  const sim = simulate(ticks, config);
  const resetJournal = buildResetJournal(sim.resets);
  const noNegativeLeg = judgeNoNegativeLeg(ticks, config, sim.resets);
  const lc = traverseLifecycle(sim.resets.length);

  const resetRate =
    sim.ticksProcessed === 0
      ? '0'
      : toApproxString(rational(BigInt(sim.resets.length), BigInt(sim.ticksProcessed)));

  return {
    resetJournal,
    noNegativeLeg,
    lifecycle: { final: lc.current, history: [...lc.history] },
    resetCount: sim.resets.length,
    ticksProcessed: sim.ticksProcessed,
    resetRate,
    finalAnchorPrice: sim.finalAnchorPrice,
  };
}
