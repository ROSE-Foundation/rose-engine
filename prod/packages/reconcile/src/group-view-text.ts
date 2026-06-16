// Human-readable text rendering of the consolidated group view (Story 5.5, FR-9). Deterministic and
// derived entirely from the SAME `GroupView` the JSON view uses (one integer source → both views).
// Amounts are shown as exact formatted decimals (NFR-2) — never raw smallest-units, never floats.

import type {
  ConsolidatedAssetView,
  CoupledPairPositionView,
  EntityView,
  GroupView,
  MoneyView,
} from './group-view.js';

function amount(m: MoneyView): string {
  return `${m.decimal} ${m.asset}`;
}

function renderEntity(e: EntityView): string[] {
  const lines: string[] = [];
  lines.push(`  ${e.entityCode}  (jurisdiction: ${e.jurisdiction})`);
  if (e.accounts.length === 0) {
    lines.push('    (no accounts)');
  } else {
    for (const a of e.accounts) {
      lines.push(`    ${a.type.padEnd(18)} ${a.asset.padEnd(8)} net ${amount(a.net)}`);
    }
  }
  for (const s of e.byAsset) {
    lines.push(
      `    └─ ${s.asset}: assets ${amount(s.assets)} | liabilities ${amount(
        s.liabilities,
      )} | equity ${amount(s.equity)} | NAV ${amount(s.nav)}`,
    );
  }
  return lines;
}

function renderConsolidated(c: ConsolidatedAssetView): string {
  const flag = c.balanced ? 'balanced' : 'UNBALANCED';
  return `  ${c.asset}: assets ${amount(c.assets)} | liabilities ${amount(
    c.liabilities,
  )} | equity ${amount(c.equity)} | NAV ${amount(c.nav)}  [${flag}]`;
}

function renderPair(p: CoupledPairPositionView): string[] {
  return [
    `  pair ${p.id} (${p.referenceAsset}) state=${p.state}${p.noteId ? ` note=${p.noteId}` : ''}`,
    `    V_A=${p.longLegValue} V_B=${p.shortLegValue} K=${p.collateralPool} anchor=${p.anchorPrice} leverage=${p.leverage} floor=${p.floor}`,
  ];
}

/**
 * Renders a `GroupView` as a deterministic, human-readable text report (FR-9). The exact same data
 * the JSON view carries; every amount is the exact decimal formatted from integer smallest-units.
 */
export function renderGroupViewText(view: GroupView): string {
  const lines: string[] = [];
  lines.push('ROSE — Consolidated Group View');
  lines.push(`Generated: ${view.generatedAt}`);
  lines.push(`Source: ${view.source}`);
  lines.push('');

  lines.push('Entities (per-entity, per-account-type balances):');
  for (const e of view.entities) {
    lines.push(...renderEntity(e));
  }
  lines.push('');

  lines.push('Consolidated group view (group NAV per asset):');
  if (view.consolidated.length === 0) {
    lines.push('  (no balances)');
  } else {
    for (const c of view.consolidated) {
      lines.push(renderConsolidated(c));
    }
  }
  lines.push('');

  lines.push('Coupled-pair positions:');
  if (view.coupledPairs.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of view.coupledPairs) {
      lines.push(...renderPair(p));
    }
  }
  lines.push('');

  lines.push('Ledger ↔ chain comparison:');
  if (view.chainComparison.source === 'ledger-only') {
    lines.push(
      '  ledger-only — no on-chain supply snapshot supplied; no divergence check performed.',
    );
  } else if (view.chainComparison.divergences.length === 0) {
    lines.push('  ledger+chain — no token supplies to compare.');
  } else {
    for (const d of view.chainComparison.divergences) {
      const status = d.diverged ? `DIVERGENCE ${amount(d.divergence)}` : 'no divergence';
      lines.push(
        `  ${d.asset}: ledger ${amount(d.ledgerQuantity)} | on-chain ${amount(
          d.onChainTotalSupply,
        )} → ${status}`,
      );
    }
    lines.push(
      view.chainComparison.anyDivergence
        ? '  RESULT: divergence detected (reported only; correction is Story 5.6).'
        : '  RESULT: no divergence.',
    );
  }
  lines.push('');

  for (const note of view.notes) {
    lines.push(`Note: ${note}`);
  }

  return lines.join('\n');
}
