// Position ↔ pair reconciliation (Story 8.5, FR-27 / NFR-3 / NFR-9). REUSES the FR-10
// reconcile-and-correct PATTERN (Story 5.6) — it does NOT fork a parallel engine: chain
// authoritative for the underlying pairs; any correction is ONE balanced, append-only,
// auditable double-entry via `@rose/ledger` `recordJournalEntry` (the Story-1.5 per-(asset,scale)
// DB trigger is the non-bypassable balance backstop); a consistent state posts NOTHING
// (idempotence); nothing is silently dropped (reported; `strict` rolls the whole pass back).
//
// TWO concerns, ONE pass:
//   (1) RESIDUAL-BACKING INVARIANT (AC-1, AC-2) — REPORT-ONLY. Per pair AND per side (L/S),
//       INDEPENDENTLY (never netted across pairs or sides), verify aggregate off-chain position
//       exposure never exceeds the residual collateral backing of that pair/side. The residual
//       backing is the side's CURRENT leg value (`long_leg_value`/`short_leg_value`) — the residual
//       pool AFTER any D1a reset/withdrawal, NOT gross issued notional. An over-exposed side is
//       surfaced and can NEVER be masked by headroom on another pair or side (the math sums nothing
//       across rows). Over-exposure is NOT auto-corrected — liquidation is the board-gated Story 8.6.
//   (2) POSITION ↔ PAIR MISMATCH (AC-3) — CORRECTED toward the chain. A position still OPEN while the
//       CHAIN reports its underlying pair's package closed/gone (the ledger has not yet retired it) is
//       the divergence. Correcting it reduces/voids a user's recorded claim, so it is JOURNALED and
//       SURFACED — never a silent liquidation: in ONE transaction post a balanced correcting entry
//       (naming the void, via the caller-supplied claim/contra accounts) AND flip OPEN→CLOSED.
//
// P0 INTERPRETATION (documented, not invented scope): "exposure" and "backing" are both measured in
// smallest-unit COLLATERAL value — exposure(pair,side) = Σ position.collateral over OPEN positions;
// backing(pair,side) = that side's stored leg value (0 for a chain-closed pair). In paper P0
// collateral == size_units (1:1) and at entry the leg value = K/2, so this is exact (NFR-2).
//
// DECOUPLING. No `@rose/chain` / `viem` edge: the chain-authoritative "this pair's package is closed/
// gone" facts enter as an injected `chainClosedPairs` snapshot (mirrors 5.6 `ChainSupplySnapshot`).
import { eq, inArray } from 'drizzle-orm';
import {
  accounts,
  recordJournalEntry,
  coupledPairs,
  type PostingDirection,
  type RoseDb,
  type RoseExecutor,
} from '@rose/ledger';
import { positions } from './schema/positions.js';
import type { PositionSide } from './schema/positions.js';
import { closePosition } from './repositories/positions.js';

/** The two directional sides, in a stable order (report determinism). */
export const POSITION_SIDES: readonly PositionSide[] = ['LONG', 'SHORT'] as const;

/**
 * A chain-authoritative fact: the on-chain coupled package for this pair is closed/gone, so any
 * off-chain position still OPEN against it has out-lived the chain and must be corrected toward the
 * chain. Injected (the codebase's port decoupling) — reconcile does NOT read the chain itself.
 */
export interface ChainClosedPair {
  readonly coupledPairId: string;
}

/**
 * Caller-supplied account topology for journaling the void of ONE pair/side's stale position claim
 * (the established 5.6 caller-supplied-facts trust boundary — reconcile does not invent which
 * accounts carry a user's recorded claim). Both accounts must exist and share the SAME (asset,
 * scale) so the correcting entry balances. The voided collateral magnitude moves from the claim
 * account (DEBIT — the recorded claim is reduced) to the contra (CREDIT).
 */
export interface PositionClaimCorrectionAccounts {
  readonly coupledPairId: string;
  readonly side: PositionSide;
  readonly asset: string;
  readonly scale: number;
  /** The account carrying the user's recorded position claim (DEBITed to void it). */
  readonly claimAccountId: string;
  /** The contra in the same (asset, scale) that balances the void (CREDITed). */
  readonly contraAccountId: string;
}

/** The plan for a position↔pair reconcile pass. All inputs optional — an empty plan is report-only. */
export interface PositionReconcilePlan {
  /** Chain-authoritative "package closed/gone" facts (injected port; no `@rose/chain` edge). */
  readonly chainClosedPairs?: ReadonlyArray<ChainClosedPair>;
  /** Per-(pair, side) correction-account topology for journaling a claim-voiding correction. */
  readonly corrections?: ReadonlyArray<PositionClaimCorrectionAccounts>;
  /** Injected clock for a deterministic `reconciledAt` (tests). Defaults to `new Date()`. */
  readonly now?: Date;
  /** When true, a mismatch with no correction mapping throws `UnreconciledPositionMismatchError`. */
  readonly strict?: boolean;
  /** Optional override for the correcting entry's description (defaults to a void-naming string). */
  readonly description?: string;
}

/** Per-(pair, side) residual-backing solvency row. Amounts are exact integer decimal strings (NFR-2). */
export interface SideBackingRow {
  readonly coupledPairId: string;
  readonly referenceAsset: string;
  readonly side: PositionSide;
  /** Residual collateral backing of this side (its leg value; `0` for a chain-closed pair). */
  readonly backing: string;
  /** Aggregate off-chain exposure = Σ collateral of OPEN positions of THIS pair & side only. */
  readonly exposure: string;
  /** `backing − exposure` (signed). Negative ⇒ over-exposed. */
  readonly headroom: string;
  /** True when `exposure > backing` for THIS pair/side (computed independently — never netted). */
  readonly overExposed: boolean;
  /** `max(0, exposure − backing)`. */
  readonly overExposedBy: string;
  readonly openPositionCount: number;
}

/** An over-exposed (pair, side), surfaced so cross-pair/cross-side headroom can never mask it. */
export interface OverExposedSide {
  readonly coupledPairId: string;
  readonly side: PositionSide;
  readonly overExposedBy: string;
}

/** A position↔pair mismatch and its correction outcome (surfaced — never silent). */
export interface PositionMismatchRow {
  readonly positionId: string;
  readonly coupledPairId: string;
  readonly owner: string;
  readonly side: PositionSide;
  /** The recorded collateral claim that the correction voids (exact integer decimal string). */
  readonly voidedCollateral: string;
  /** True when this mismatch was corrected (journaled + closed) in this pass. */
  readonly corrected: boolean;
  /** False when the mismatch has no correction-account mapping (reported, never silently closed). */
  readonly correctable: boolean;
  /** The voiding entry's id, or null when nothing was posted. */
  readonly journalEntryId: string | null;
  /** Human-readable reason when not corrected, or the void description when corrected. */
  readonly reason: string | null;
}

/** The full position↔pair reconciliation report — plain, JSON-serialisable (NO bigint, NO float). */
export interface PositionReconciliationReport {
  readonly reconciledAt: string;
  readonly source: 'positions+pairs+chain';
  /** Per-(pair, side) residual-backing solvency (AC-1). */
  readonly sideBacking: ReadonlyArray<SideBackingRow>;
  /** Every over-exposed (pair, side) — surfaced, never masked by headroom elsewhere (AC-2). */
  readonly overExposedSides: ReadonlyArray<OverExposedSide>;
  readonly anyOverExposure: boolean;
  /** Every position↔pair mismatch and its correction outcome (AC-3). */
  readonly mismatches: ReadonlyArray<PositionMismatchRow>;
  readonly anyMismatch: boolean;
  readonly anyCorrected: boolean;
  /** Count of voiding journal entries posted in this pass. */
  readonly corrections: number;
}

/** Thrown when a mismatch's supplied correction accounts are structurally invalid. */
export class InvalidPositionCorrectionAccountsError extends Error {
  readonly coupledPairId: string;
  readonly side: PositionSide;
  constructor(coupledPairId: string, side: PositionSide, detail: string) {
    super(`Invalid correction accounts for pair ${coupledPairId} side ${side}: ${detail}`);
    this.name = 'InvalidPositionCorrectionAccountsError';
    this.coupledPairId = coupledPairId;
    this.side = side;
  }
}

/** Thrown in `strict` mode when one or more mismatches have no correction mapping. */
export class UnreconciledPositionMismatchError extends Error {
  readonly positions: ReadonlyArray<{
    readonly positionId: string;
    readonly coupledPairId: string;
  }>;
  constructor(
    positionsLeft: ReadonlyArray<{ readonly positionId: string; readonly coupledPairId: string }>,
  ) {
    super(
      `Reconciliation left ${positionsLeft.length} position↔pair mismatch(es) uncorrected ` +
        `(no correction mapping): ` +
        positionsLeft.map((p) => `${p.positionId}@${p.coupledPairId}`).join(', '),
    );
    this.name = 'UnreconciledPositionMismatchError';
    this.positions = positionsLeft;
  }
}

/** Parses an integer-NUMERIC smallest-unit string (validated by DB CHECKs) to a BigInt. */
function numericToBigInt(label: string, value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart] = unsigned.split('.');
  if (fracPart !== undefined && /[^0]/.test(fracPart)) {
    throw new Error(`Non-integer ${label} '${value}' read from the DB (smallest-units contract).`);
  }
  const magnitude = BigInt(intPart);
  return negative ? -magnitude : magnitude;
}

function sideKey(coupledPairId: string, side: PositionSide): string {
  return `${coupledPairId}|${side}`;
}

/** A minimal account classification needed to validate supplied correction accounts. */
interface AccountClass {
  readonly asset: string;
  readonly scale: number;
}

/**
 * Reconciles off-chain positions against their issued coupled pairs (FR-27), reusing the FR-10
 * reconcile-and-correct pattern. Reports the per-(pair, side) residual-backing solvency (AC-1/AC-2,
 * report-only) and CORRECTS position↔pair mismatches toward the chain (AC-3) with a journaled,
 * surfaced, balanced voiding entry + an OPEN→CLOSED flip, atomically. Returns a structured,
 * JSON-serialisable `PositionReconciliationReport`.
 */
export async function reconcilePositionsToPairs(
  db: RoseDb,
  plan: PositionReconcilePlan = {},
): Promise<PositionReconciliationReport> {
  const now = plan.now ?? new Date();

  const chainClosedSet = new Set((plan.chainClosedPairs ?? []).map((c) => c.coupledPairId));
  const correctionByKey = new Map<string, PositionClaimCorrectionAccounts>();
  for (const c of plan.corrections ?? []) {
    correctionByKey.set(sideKey(c.coupledPairId, c.side), c);
  }

  // 1. Read every OPEN position (the only ones with live exposure / that can outlive a pair).
  const openPositions = await db
    .select({
      id: positions.id,
      coupledPairId: positions.coupledPairId,
      owner: positions.owner,
      side: positions.side,
      collateral: positions.collateral,
    })
    .from(positions)
    .where(eq(positions.lifecycle, 'OPEN'))
    .orderBy(positions.coupledPairId, positions.side, positions.createdAt);

  // 2. Read the referenced pairs' residual per-side backing (leg values). Only the pairs touched by
  //    OPEN positions matter for the invariant.
  const pairIds = Array.from(new Set(openPositions.map((p) => p.coupledPairId)));
  const pairRows =
    pairIds.length === 0
      ? []
      : await db
          .select({
            id: coupledPairs.id,
            referenceAsset: coupledPairs.referenceAsset,
            longLegValue: coupledPairs.longLegValue,
            shortLegValue: coupledPairs.shortLegValue,
          })
          .from(coupledPairs)
          .where(inArray(coupledPairs.id, pairIds));
  const pairById = new Map(pairRows.map((p) => [p.id, p]));

  // 3. Aggregate exposure PER (pair, side) — INDEPENDENTLY. No sum is ever taken across pairs or
  //    sides, so over-exposure on one side can never be masked by headroom on another (AC-2).
  const exposureByKey = new Map<string, { sum: bigint; count: number }>();
  for (const p of openPositions) {
    const key = sideKey(p.coupledPairId, p.side);
    const agg = exposureByKey.get(key) ?? { sum: 0n, count: 0 };
    agg.sum += numericToBigInt('collateral', p.collateral);
    agg.count += 1;
    exposureByKey.set(key, agg);
  }

  // 4. Build the per-(pair, side) residual-backing rows.
  const sideBacking: SideBackingRow[] = [];
  const overExposedSides: OverExposedSide[] = [];
  for (const pairId of pairIds) {
    const pair = pairById.get(pairId);
    const referenceAsset = pair?.referenceAsset ?? '';
    const chainClosed = chainClosedSet.has(pairId);
    for (const side of POSITION_SIDES) {
      const agg = exposureByKey.get(sideKey(pairId, side));
      if (!agg) {
        continue; // only surface (pair, side) combinations that carry OPEN exposure
      }
      // Residual backing: the side's CURRENT leg value (post-D1a-reset residual). A chain-closed
      // pair's package is gone ⇒ backing is 0 (any exposure is over-exposed AND a mismatch).
      const backing =
        chainClosed || !pair
          ? 0n
          : side === 'LONG'
            ? numericToBigInt('long_leg_value', pair.longLegValue)
            : numericToBigInt('short_leg_value', pair.shortLegValue);
      const exposure = agg.sum;
      const headroom = backing - exposure;
      const overExposed = exposure > backing;
      const overExposedBy = overExposed ? exposure - backing : 0n;
      sideBacking.push(
        Object.freeze({
          coupledPairId: pairId,
          referenceAsset,
          side,
          backing: backing.toString(),
          exposure: exposure.toString(),
          headroom: headroom.toString(),
          overExposed,
          overExposedBy: overExposedBy.toString(),
          openPositionCount: agg.count,
        }),
      );
      if (overExposed) {
        overExposedSides.push(
          Object.freeze({ coupledPairId: pairId, side, overExposedBy: overExposedBy.toString() }),
        );
      }
    }
  }

  // 5. Position↔pair mismatches: OPEN positions whose pair the chain reports closed/gone. Correct
  //    toward the chain — journaled + surfaced, never silent — in ONE transaction (whole pass).
  const mismatchPositions = openPositions.filter((p) => chainClosedSet.has(p.coupledPairId));
  const mismatches: PositionMismatchRow[] = [];
  const uncorrectable: Array<{ positionId: string; coupledPairId: string }> = [];
  let corrections = 0;

  if (mismatchPositions.length > 0) {
    await db.transaction(async (tx) => {
      // Classify the supplied correction accounts once (existence + denomination), so a balanced
      // entry is guaranteed to balance in one (asset, scale) — fail loud otherwise (mirrors 5.6).
      const referencedAccountIds = new Set<string>();
      for (const c of plan.corrections ?? []) {
        referencedAccountIds.add(c.claimAccountId);
        referencedAccountIds.add(c.contraAccountId);
      }
      const classById = await loadAccountClasses(tx, Array.from(referencedAccountIds));

      for (const p of mismatchPositions) {
        const voided = numericToBigInt('collateral', p.collateral);
        const corr = correctionByKey.get(sideKey(p.coupledPairId, p.side));
        if (!corr) {
          uncorrectable.push({ positionId: p.id, coupledPairId: p.coupledPairId });
          mismatches.push(
            Object.freeze({
              positionId: p.id,
              coupledPairId: p.coupledPairId,
              owner: p.owner,
              side: p.side,
              voidedCollateral: voided.toString(),
              corrected: false,
              correctable: false,
              journalEntryId: null,
              reason:
                'no correction-account mapping supplied for this pair/side (NOT silently closed)',
            }),
          );
          continue;
        }

        validateCorrectionAccounts(corr, classById);

        // Flip OPEN→CLOSED in the SAME transaction (closePosition nests a savepoint on `tx`).
        await closePosition(tx, p.id);

        // Post the balanced, append-only, AUDITABLE voiding entry. A zero claim has no value to void
        // ⇒ no entry (recordJournalEntry requires positive amounts); the close is still surfaced.
        let journalEntryId: string | null = null;
        let reason: string;
        if (voided > 0n) {
          const holderDir: PostingDirection = 'DEBIT'; // reduce the recorded claim
          const contraDir: PostingDirection = 'CREDIT';
          const description =
            plan.description ??
            `reconcile: void position ${p.id} (${p.side}) claim of ${voided.toString()} ${corr.asset} ` +
              `— underlying pair ${p.coupledPairId} closed/gone on chain (FR-27, chain-authoritative; journaled, not silent)`;
          const entry = await recordJournalEntry(tx, {
            description,
            coupledPairId: p.coupledPairId,
            postings: [
              { accountId: corr.claimAccountId, direction: holderDir, amount: voided },
              { accountId: corr.contraAccountId, direction: contraDir, amount: voided },
            ],
          });
          journalEntryId = entry.entry.id;
          corrections += 1;
          reason = description;
          console.info('[positions/reconcile] voided stale position claim toward chain (FR-27)', {
            positionId: p.id,
            coupledPairId: p.coupledPairId,
            owner: p.owner,
            side: p.side,
            voidedCollateral: voided.toString(),
            journalEntryId,
          });
        } else {
          reason = 'zero recorded claim — position closed toward chain, no value to journal';
          console.info('[positions/reconcile] closed zero-claim stale position toward chain', {
            positionId: p.id,
            coupledPairId: p.coupledPairId,
          });
        }

        mismatches.push(
          Object.freeze({
            positionId: p.id,
            coupledPairId: p.coupledPairId,
            owner: p.owner,
            side: p.side,
            voidedCollateral: voided.toString(),
            corrected: true,
            correctable: true,
            journalEntryId,
            reason,
          }),
        );
      }

      if (plan.strict && uncorrectable.length > 0) {
        // Roll back the whole pass — strict callers require full correction or nothing.
        throw new UnreconciledPositionMismatchError(uncorrectable);
      }
    });
  }

  if (uncorrectable.length > 0) {
    console.warn('[positions/reconcile] mismatches left uncorrected (no mapping)', {
      positions: uncorrectable.map((p) => `${p.positionId}@${p.coupledPairId}`),
    });
  }

  return Object.freeze({
    reconciledAt: now.toISOString(),
    source: 'positions+pairs+chain',
    sideBacking,
    overExposedSides,
    anyOverExposure: overExposedSides.length > 0,
    mismatches,
    anyMismatch: mismatches.length > 0,
    anyCorrected: mismatches.some((m) => m.corrected),
    corrections,
  });
}

/** Loads the (asset, scale) classification of the referenced accounts (for correction validation). */
async function loadAccountClasses(
  tx: RoseExecutor,
  accountIds: readonly string[],
): Promise<Map<string, AccountClass>> {
  const classById = new Map<string, AccountClass>();
  if (accountIds.length === 0) {
    return classById;
  }
  const rows = await tx
    .select({ id: accounts.id, asset: accounts.asset, scale: accounts.decimalScale })
    .from(accounts)
    .where(inArray(accounts.id, [...accountIds]));
  for (const row of rows) {
    classById.set(row.id, { asset: row.asset, scale: row.scale });
  }
  return classById;
}

/** Validates a supplied correction topology: both accounts exist, differ, and share (asset, scale). */
function validateCorrectionAccounts(
  corr: PositionClaimCorrectionAccounts,
  classById: Map<string, AccountClass>,
): void {
  if (corr.claimAccountId === corr.contraAccountId) {
    throw new InvalidPositionCorrectionAccountsError(
      corr.coupledPairId,
      corr.side,
      'claim and contra accounts must differ',
    );
  }
  const claim = classById.get(corr.claimAccountId);
  const contra = classById.get(corr.contraAccountId);
  if (!claim) {
    throw new InvalidPositionCorrectionAccountsError(
      corr.coupledPairId,
      corr.side,
      `claim account '${corr.claimAccountId}' not found`,
    );
  }
  if (!contra) {
    throw new InvalidPositionCorrectionAccountsError(
      corr.coupledPairId,
      corr.side,
      `contra account '${corr.contraAccountId}' not found`,
    );
  }
  if (claim.asset !== contra.asset || claim.scale !== contra.scale) {
    throw new InvalidPositionCorrectionAccountsError(
      corr.coupledPairId,
      corr.side,
      `claim ${claim.asset}@${claim.scale} and contra ${contra.asset}@${contra.scale} must share one (asset, scale) so the void balances`,
    );
  }
}

/**
 * Builds a faithful-mode OPERATOR-injected divergence plan (Story 9.5, FR-32) so the NEXT
 * `reconcilePositionsToPairs` run REPORTS-AND-CORRECTS a genuine position↔pair divergence through the
 * SAME real Story-8.5 path — no fake report. It picks an OPEN position (preferring the pair with the
 * FEWEST open positions, so a multi-leg D1 topology is left intact), injects a `chainClosedPairs` fact
 * for its pair, and supplies a balanced claim/contra correction-account mapping (two DISTINCT accounts
 * sharing one (asset, scale)) for every side that pair carries — so the induced mismatch is fully
 * correctable (journaled void + OPEN→CLOSED flip), never left silent. Returns `null` when no OPEN
 * position or no suitable correction-account pair exists (the caller then reconciles cleanly). It WRITES
 * nothing itself — the correction is posted by `reconcilePositionsToPairs` (the one journaling path).
 */
export async function buildInjectedDivergencePlan(
  db: RoseDb,
  opts: { now?: Date } = {},
): Promise<PositionReconcilePlan | null> {
  // 1. Every OPEN position (deterministic order), grouped by pair so we can pick the least-entangled pair.
  const openPositions = await db
    .select({
      coupledPairId: positions.coupledPairId,
      side: positions.side,
    })
    .from(positions)
    .where(eq(positions.lifecycle, 'OPEN'))
    .orderBy(positions.coupledPairId, positions.side, positions.createdAt);
  if (openPositions.length === 0) {
    return null;
  }
  const byPair = new Map<string, Set<PositionSide>>();
  const countByPair = new Map<string, number>();
  for (const p of openPositions) {
    countByPair.set(p.coupledPairId, (countByPair.get(p.coupledPairId) ?? 0) + 1);
    const set = byPair.get(p.coupledPairId) ?? new Set<PositionSide>();
    set.add(p.side);
    byPair.set(p.coupledPairId, set);
  }
  // Prefer the pair with the FEWEST open positions (tie-break by pair id, ascending) — for the seeded
  // demo this is the single-owner solo pair, so the headline D1 (LONG+SHORT) topology stays intact.
  const targetPairId = [...countByPair.entries()].sort(
    (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )[0]![0];
  const targetSides = [...(byPair.get(targetPairId) ?? new Set<PositionSide>())].sort();

  // 2. A balanced correction-account pair: two DISTINCT accounts sharing ONE (asset, scale) so the void
  //    entry balances per (asset, scale). Prefer a CLIENT_COLLATERAL claim (a user's recorded claim,
  //    DEBITed to void) + a non-client contra (CREDITed), else any two same-denomination accounts.
  const accountRows = await db
    .select({
      id: accounts.id,
      type: accounts.type,
      asset: accounts.asset,
      scale: accounts.decimalScale,
    })
    .from(accounts);
  const byDenom = new Map<string, Array<(typeof accountRows)[number]>>();
  for (const a of accountRows) {
    const key = `${a.asset}|${a.scale}`;
    const group = byDenom.get(key) ?? [];
    group.push(a);
    byDenom.set(key, group);
  }
  let claim: (typeof accountRows)[number] | undefined;
  let contra: (typeof accountRows)[number] | undefined;
  for (const group of byDenom.values()) {
    if (group.length < 2) continue;
    const client = group.find((a) => a.type === 'CLIENT_COLLATERAL');
    if (client) {
      const other = group.find((a) => a.id !== client.id);
      if (other) {
        claim = client;
        contra = other;
        break;
      }
    }
    // Remember a fallback (any two distinct same-denom accounts) in case no CLIENT_COLLATERAL group exists.
    if (!claim) {
      claim = group[0];
      contra = group[1];
    }
  }
  if (!claim || !contra) {
    return null;
  }

  const corrections: PositionClaimCorrectionAccounts[] = targetSides.map((side) => ({
    coupledPairId: targetPairId,
    side,
    asset: claim!.asset,
    scale: claim!.scale,
    claimAccountId: claim!.id,
    contraAccountId: contra!.id,
  }));

  const plan: PositionReconcilePlan = {
    chainClosedPairs: [{ coupledPairId: targetPairId }],
    corrections,
    description:
      `operator-injected divergence (Story 9.5, FR-32): pair ${targetPairId} reported closed on chain ` +
      `while an off-chain position is still OPEN — reconcile corrects toward the chain (journaled, not silent)`,
    ...(opts.now ? { now: opts.now } : {}),
  };
  return plan;
}

/** Returns the report as a plain object ready for `JSON.stringify` (already free of bigint/float). */
export function positionReconciliationReportToJson(
  report: PositionReconciliationReport,
): PositionReconciliationReport {
  return report;
}

/** Serialises the position↔pair reconciliation report to a JSON string. No bigint, no float. */
export function serializePositionReconciliationReport(
  report: PositionReconciliationReport,
  space = 2,
): string {
  return JSON.stringify(report, null, space);
}
