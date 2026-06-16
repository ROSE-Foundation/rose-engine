// Reconcile-and-correct toward the chain (Story 5.6, FR-10 / NFR-9, D3). The WRITE half of
// `@rose/reconcile`: Story 5.5 delivered the READ-ONLY consolidated group view + a divergence
// SIGNAL; this module CORRECTS the off-chain ledger toward the authoritative chain when a token's
// ledger quantity diverges from its on-chain `totalSupply`.
//
// D3 / NFR-9 — THE CHAIN IS THE SOURCE OF TRUTH. `divergence = onChainTotalSupply − ledgerQuantity`;
// the correcting entry always moves the LEDGER to the chain quantity, never the reverse.
//
// AUDITABLE, BALANCED, NEVER SILENT. The correction is recorded as ONE balanced double-entry via
// `@rose/ledger` `recordJournalEntry` (≥2 postings, balanced per (asset, scale), positive integer
// amounts; the Story-1.5 DB double-entry trigger is the non-bypassable backstop). It is APPENDED —
// no `UPDATE`/`DELETE` of existing rows — and carries a human-readable `description` naming the
// signed divergence. It is NOT routed through `postTransfer` (that chokepoint governs authorizable
// capital MOVEMENTS; a chain-truth quantity correction is the same recording pattern the mint/burn
// commit-point effects use — `recordJournalEntry` directly).
//
// IDEMPOTENT. A token whose ledger quantity already equals the chain produces NO entry; re-running
// after a correction is a no-op (the first run made the ledger consistent).
//
// DECOUPLING (kept from 5.5). No `@rose/chain` / `viem` edge: the authoritative on-chain quantities
// enter as the injected `ChainSupplySnapshot`. The real `readTotalSupply` / `getPastPairEvents` read
// that produces the snapshot is the Epic-6 composition / ops-deferred seam (no secret, no `.env`).

import { recordJournalEntry, type PostingDirection, type RoseDb } from '@rose/ledger';
import { buildGroupView, type MoneyView, type NavRole } from './group-view.js';
import type { ChainSupplySnapshot } from './chain-supply.js';

/**
 * Caller-supplied account topology for correcting ONE token's quantity (the established
 * caller-supplied-facts trust boundary — reconcile does NOT invent which accounts hold a token,
 * mirroring `@rose/chain` `MintLegAccounts`). The correction adjusts the ASSET-side holder against a
 * NON-ASSET contra in the SAME (asset, scale), so the ledger circulating quantity (Σ over
 * ASSET-classified accounts) moves by EXACTLY the divergence.
 */
export interface TokenCorrectionAccounts {
  readonly asset: string;
  readonly scale: number;
  /** ASSET-classified account of the token (DEBITed when the chain has MORE than the ledger). */
  readonly holderAccountId: string;
  /** NON-ASSET contra of the token in the same (asset, scale) (balances the correction). */
  readonly contraAccountId: string;
}

/** The plan for a reconcile-and-correct pass. */
export interface ReconcilePlan {
  /** Correction topology per token denomination; a token with no entry here is reported uncorrectable. */
  readonly corrections: ReadonlyArray<TokenCorrectionAccounts>;
  /** Optional override for the correcting entry's description (defaults to a divergence-naming string). */
  readonly description?: string;
  /** Optional coupled-pair link recorded on the correcting journal entry (audit trail). */
  readonly coupledPairId?: string | null;
  /** Injected clock for a deterministic `reconciledAt` (tests). Defaults to `new Date()`. */
  readonly now?: Date;
  /** When true, a diverged token with no correction mapping throws `UnreconciledDivergenceError`. */
  readonly strict?: boolean;
}

/** Per-token reconciliation outcome. All amounts are `MoneyView` (no bigint/float, NFR-2). */
export interface TokenReconciliation {
  readonly asset: string;
  readonly scale: number;
  /** Ledger ASSET-side circulating quantity BEFORE this pass. */
  readonly ledgerQuantityBefore: MoneyView;
  readonly onChainTotalSupply: MoneyView;
  /** Signed `onChainTotalSupply − ledgerQuantityBefore` (chain authoritative, D3). */
  readonly divergence: MoneyView;
  readonly diverged: boolean;
  /** True when a balanced correcting entry was posted for this token in this pass. */
  readonly corrected: boolean;
  /** False when the token diverged but no correction mapping was supplied. */
  readonly correctable: boolean;
  /** The correcting entry's id, or null when nothing was posted. */
  readonly journalEntryId: string | null;
  /** Ledger ASSET-side quantity AFTER this pass (equals the chain supply when corrected, D3). */
  readonly ledgerQuantityAfter: MoneyView;
  /** Human-readable reason when not corrected (consistent, or uncorrectable). */
  readonly reason: string | null;
}

/** Consolidated per-(asset, scale) double-entry balance check, surfaced for AC-1 reporting. */
export interface InternalConsistencyRow {
  readonly asset: string;
  readonly scale: number;
  /** True when Σ(debit − credit) over all accounts of this (asset, scale) is exactly zero. */
  readonly balanced: boolean;
}

/** The full reconcile-and-correct report — a plain, JSON-serialisable object (NO bigint, NO float). */
export interface ReconciliationReport {
  readonly reconciledAt: string;
  readonly source: 'ledger+chain';
  /** Per-(asset, scale) internal double-entry consistency (AC-1). */
  readonly internalConsistency: ReadonlyArray<InternalConsistencyRow>;
  /** True when any consolidated (asset, scale) fails the double-entry balance check. */
  readonly anyImbalance: boolean;
  readonly tokens: ReadonlyArray<TokenReconciliation>;
  readonly anyDivergence: boolean;
  readonly anyCorrected: boolean;
  /** Count of correcting journal entries posted in this pass. */
  readonly corrections: number;
}

/** Thrown when a diverged token's supplied correction accounts are structurally invalid. */
export class InvalidCorrectionAccountsError extends Error {
  readonly asset: string;
  readonly scale: number;
  constructor(asset: string, scale: number, detail: string) {
    super(`Invalid correction accounts for ${asset} (scale ${scale}): ${detail}`);
    this.name = 'InvalidCorrectionAccountsError';
    this.asset = asset;
    this.scale = scale;
  }
}

/** Thrown in `strict` mode when one or more diverged tokens have no correction mapping. */
export class UnreconciledDivergenceError extends Error {
  readonly tokens: ReadonlyArray<{ readonly asset: string; readonly scale: number }>;
  constructor(tokens: ReadonlyArray<{ readonly asset: string; readonly scale: number }>) {
    super(
      `Reconciliation left ${tokens.length} diverged token(s) uncorrected (no correction mapping): ` +
        tokens.map((t) => `${t.asset}@${t.scale}`).join(', '),
    );
    this.name = 'UnreconciledDivergenceError';
    this.tokens = tokens;
  }
}

function denomKey(asset: string, scale: number): string {
  return `${asset} ${scale}`;
}

// A minimal per-account classification needed to validate the supplied correction accounts.
interface AccountClass {
  readonly navRole: NavRole;
  readonly asset: string;
  readonly scale: number;
}

/**
 * Reconciles the ledger against the authoritative on-chain supplies and CORRECTS it toward the chain
 * (FR-10, D3). For each token in `snapshot`, computes the ledger ASSET-side quantity and the signed
 * divergence; a diverged token WITH a `TokenCorrectionAccounts` mapping gets ONE balanced correcting
 * entry (via `recordJournalEntry`) that moves the ledger quantity to the on-chain `totalSupply`. A
 * consistent token produces nothing (idempotence). All corrections commit atomically in ONE
 * transaction. Returns a structured, JSON-serialisable `ReconciliationReport`.
 *
 * Reports (never silently drops): consolidated internal-consistency flags (AC-1), and any diverged
 * token without a correction mapping (`correctable: false`); with `plan.strict`, an uncorrectable
 * divergence throws `UnreconciledDivergenceError` (rolling back the whole pass).
 */
export async function reconcileLedgerToChain(
  db: RoseDb,
  snapshot: ChainSupplySnapshot,
  plan: ReconcilePlan,
): Promise<ReconciliationReport> {
  const now = plan.now ?? new Date();

  // One READ pass (reuse the 5.5 group view) gives both the consolidated balance check (AC-1) and the
  // per-token divergence (the same ASSET-side definition the correction must move).
  const view = await buildGroupView(db, { chainSupplies: snapshot, now });

  // Map account id -> classification, to validate that a holder is ASSET-side and a contra is not
  // (so the correction actually moves the circulating quantity and stays idempotent).
  const classById = new Map<string, AccountClass>();
  for (const e of view.entities) {
    for (const a of e.accounts) {
      classById.set(a.accountId, { navRole: a.navRole, asset: a.asset, scale: a.scale });
    }
  }

  const correctionByDenom = new Map<string, TokenCorrectionAccounts>();
  for (const c of plan.corrections) {
    correctionByDenom.set(denomKey(c.asset, c.scale), c);
  }

  const internalConsistency: InternalConsistencyRow[] = view.consolidated.map((c) =>
    Object.freeze({ asset: c.asset, scale: c.scale, balanced: c.balanced }),
  );
  const anyImbalance = internalConsistency.some((r) => !r.balanced);

  const tokens: TokenReconciliation[] = [];
  const uncorrectable: Array<{ asset: string; scale: number }> = [];
  let corrections = 0;

  await db.transaction(async (tx) => {
    for (const d of view.chainComparison.divergences) {
      const divergence = BigInt(d.divergence.smallestUnits);

      if (!d.diverged) {
        tokens.push(
          Object.freeze({
            asset: d.asset,
            scale: d.scale,
            ledgerQuantityBefore: d.ledgerQuantity,
            onChainTotalSupply: d.onChainTotalSupply,
            divergence: d.divergence,
            diverged: false,
            corrected: false,
            correctable: true,
            journalEntryId: null,
            ledgerQuantityAfter: d.ledgerQuantity,
            reason: 'ledger already matches chain',
          }),
        );
        continue;
      }

      const corr = correctionByDenom.get(denomKey(d.asset, d.scale));
      if (!corr) {
        uncorrectable.push({ asset: d.asset, scale: d.scale });
        tokens.push(
          Object.freeze({
            asset: d.asset,
            scale: d.scale,
            ledgerQuantityBefore: d.ledgerQuantity,
            onChainTotalSupply: d.onChainTotalSupply,
            divergence: d.divergence,
            diverged: true,
            corrected: false,
            correctable: false,
            journalEntryId: null,
            ledgerQuantityAfter: d.ledgerQuantity,
            reason: 'no correction account mapping supplied for this token',
          }),
        );
        continue;
      }

      // Validate the supplied accounts: a holder must be ASSET-side and a contra must NOT be, both in
      // the token's (asset, scale). Otherwise the correction would not move the circulating quantity
      // (breaking idempotence) or would balance against the wrong denomination — fail loud.
      const holder = classById.get(corr.holderAccountId);
      const contra = classById.get(corr.contraAccountId);
      if (!holder) {
        throw new InvalidCorrectionAccountsError(
          d.asset,
          d.scale,
          `holder account '${corr.holderAccountId}' not found`,
        );
      }
      if (!contra) {
        throw new InvalidCorrectionAccountsError(
          d.asset,
          d.scale,
          `contra account '${corr.contraAccountId}' not found`,
        );
      }
      if (holder.asset !== d.asset || holder.scale !== d.scale) {
        throw new InvalidCorrectionAccountsError(
          d.asset,
          d.scale,
          `holder account denomination ${holder.asset}@${holder.scale} does not match the token`,
        );
      }
      if (contra.asset !== d.asset || contra.scale !== d.scale) {
        throw new InvalidCorrectionAccountsError(
          d.asset,
          d.scale,
          `contra account denomination ${contra.asset}@${contra.scale} does not match the token`,
        );
      }
      if (holder.navRole !== 'ASSET') {
        throw new InvalidCorrectionAccountsError(
          d.asset,
          d.scale,
          `holder account must be ASSET-classified (is ${holder.navRole})`,
        );
      }
      if (contra.navRole === 'ASSET') {
        throw new InvalidCorrectionAccountsError(
          d.asset,
          d.scale,
          'contra account must NOT be ASSET-classified (it would not balance the quantity move)',
        );
      }

      // Move the ASSET-side quantity toward the chain. divergence > 0 (chain has more) ⇒ DEBIT the
      // holder; divergence < 0 (chain has less) ⇒ CREDIT the holder. The contra takes the opposite
      // side for the same positive amount, so the entry balances in one (asset, scale).
      const amount = divergence > 0n ? divergence : -divergence;
      const holderDir: PostingDirection = divergence > 0n ? 'DEBIT' : 'CREDIT';
      const contraDir: PostingDirection = divergence > 0n ? 'CREDIT' : 'DEBIT';
      const signed = `${divergence > 0n ? '+' : ''}${divergence.toString()}`;
      const description =
        plan.description ??
        `reconcile: correct ${d.asset} ledger quantity toward chain (divergence ${signed} smallest-units, D3 chain-authoritative)`;

      const entry = await recordJournalEntry(tx, {
        description,
        coupledPairId: plan.coupledPairId ?? null,
        postings: [
          { accountId: corr.holderAccountId, direction: holderDir, amount },
          { accountId: corr.contraAccountId, direction: contraDir, amount },
        ],
      });
      corrections += 1;
      console.info('[reconcile] corrected ledger toward chain (D3)', {
        asset: d.asset,
        scale: d.scale,
        divergence: signed,
        journalEntryId: entry.entry.id,
        coupledPairId: plan.coupledPairId ?? null,
      });

      tokens.push(
        Object.freeze({
          asset: d.asset,
          scale: d.scale,
          ledgerQuantityBefore: d.ledgerQuantity,
          onChainTotalSupply: d.onChainTotalSupply,
          divergence: d.divergence,
          diverged: true,
          corrected: true,
          correctable: true,
          journalEntryId: entry.entry.id,
          // After the correction the ledger ASSET-side quantity equals the chain supply (D3).
          ledgerQuantityAfter: d.onChainTotalSupply,
          reason: null,
        }),
      );
    }

    if (plan.strict && uncorrectable.length > 0) {
      // Roll back the whole pass — strict callers require full correction or nothing.
      throw new UnreconciledDivergenceError(uncorrectable);
    }
  });

  if (uncorrectable.length > 0) {
    console.warn('[reconcile] diverged tokens left uncorrected (no mapping)', {
      tokens: uncorrectable.map((t) => `${t.asset}@${t.scale}`),
    });
  }

  return Object.freeze({
    reconciledAt: now.toISOString(),
    source: 'ledger+chain',
    internalConsistency,
    anyImbalance,
    tokens,
    anyDivergence: tokens.some((t) => t.diverged),
    anyCorrected: tokens.some((t) => t.corrected),
    corrections,
  });
}

/** Returns the report as a plain object ready for `JSON.stringify` (it already contains no bigint). */
export function reconciliationReportToJson(report: ReconciliationReport): ReconciliationReport {
  return report;
}

/** Serialises the reconciliation report to a JSON string (pretty-printed). No bigint, no float. */
export function serializeReconciliationReport(report: ReconciliationReport, space = 2): string {
  return JSON.stringify(report, null, space);
}

/** Renders a deterministic, human-readable reconciliation report (amounts as exact decimals). */
export function renderReconciliationText(report: ReconciliationReport): string {
  const lines: string[] = [];
  lines.push('ROSE — Ledger ↔ Chain Reconciliation (correct toward chain, D3)');
  lines.push(`Reconciled: ${report.reconciledAt}`);
  lines.push(`Source: ${report.source}`);
  lines.push('');

  lines.push('Internal consistency (consolidated double-entry per asset):');
  if (report.internalConsistency.length === 0) {
    lines.push('  (no balances)');
  } else {
    for (const r of report.internalConsistency) {
      lines.push(`  ${r.asset} (scale ${r.scale}): ${r.balanced ? 'balanced' : 'UNBALANCED'}`);
    }
  }
  lines.push(
    report.anyImbalance
      ? '  RESULT: internal IMBALANCE detected.'
      : '  RESULT: internally balanced.',
  );
  lines.push('');

  lines.push('Token reconciliation (chain authoritative):');
  if (report.tokens.length === 0) {
    lines.push('  (no tokens to reconcile)');
  } else {
    for (const t of report.tokens) {
      const outcome = t.corrected
        ? `CORRECTED → ${t.onChainTotalSupply.decimal} ${t.asset} (entry ${t.journalEntryId})`
        : t.diverged
          ? `DIVERGED, NOT corrected (${t.reason ?? ''})`
          : 'consistent';
      lines.push(
        `  ${t.asset}: ledger ${t.ledgerQuantityBefore.decimal} | on-chain ${t.onChainTotalSupply.decimal} | divergence ${t.divergence.decimal} → ${outcome}`,
      );
    }
  }
  lines.push(
    `  RESULT: ${report.corrections} correcting entr${report.corrections === 1 ? 'y' : 'ies'} posted; ` +
      `${report.anyDivergence ? 'divergence detected' : 'no divergence'}.`,
  );

  return lines.join('\n');
}
