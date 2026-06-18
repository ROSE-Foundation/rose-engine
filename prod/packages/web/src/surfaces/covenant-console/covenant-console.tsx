import { useMemo, useState } from 'react';
import { CopyTxHash } from '../../components/ui/copy-tx-hash.js';
import { CovenantBar } from '../../components/ui/covenant-bar.js';
import { DivergenceBanner } from '../../components/ui/divergence-banner.js';
import { LiveIndicator } from '../../components/ui/live-indicator.js';
import { MoneyCell } from '../../components/ui/money-cell.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatCard } from '../../components/ui/stat-card.js';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table.js';
import { ApiClientError } from '../../lib/api-client.js';
import type {
  AccountBalance,
  EntityCode,
  EntityRole,
  GroupViewEntity,
  GroupViewResponse,
  Money,
  ReconciliationStatus,
} from '../../lib/contract-types.js';
import { REFRESH_WINDOW_MS, useGroupView } from '../../lib/queries.js';
import { cn } from '../../lib/cn.js';
import { EntitySwitcher, type Scope } from './entity-switcher.js';

/**
 * Sum the net of every account of `type` across the scoped entities, in the dominant (first-match)
 * asset/scale ONLY — never adding unlike units across assets (a type can appear in more than one
 * asset). Exact BigInt smallest-units (NFR-2). The KPI reflects the dominant asset, mirroring the
 * hero NAV's dominant-asset convention.
 */
function sumNetByType(
  entities: readonly GroupViewEntity[],
  type: AccountBalance['type'],
): Money | null {
  const matches = entities.flatMap((e) => e.accounts).filter((a) => a.type === type);
  if (matches.length === 0) return null;
  const first = matches[0]!;
  const asset = first.net.asset;
  const scale = first.net.scale;
  let total = 0n;
  for (const a of matches) {
    if (a.net.asset === asset && a.net.scale === scale) total += BigInt(a.net.smallestUnits);
  }
  return {
    asset,
    scale,
    smallestUnits: total.toString(),
    decimal: formatUnits(total, scale),
  };
}

/** Format smallest-units → exact decimal string at `scale` (no float). */
function formatUnits(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const neg = units < 0n;
  const abs = (neg ? -units : units).toString().padStart(scale + 1, '0');
  const whole = abs.slice(0, abs.length - scale);
  const frac = abs.slice(abs.length - scale);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * A live ratio (numerator/denominator) as a percent string, computed in exact bigint basis points —
 * no float in the money path. Returns '—' when the denominator is ≤ 0 (cannot compute honestly).
 */
function ratioPercent(numerator: Money | null, denominator: Money | null): string {
  if (!numerator || !denominator) return '—';
  const den = BigInt(denominator.smallestUnits);
  if (den <= 0n) return '—';
  const bps = (BigInt(numerator.smallestUnits) * 10000n) / den;
  return `${(Number(bps) / 100).toFixed(1)}%`;
}

/** The consolidated Group NAV (hero) — the dominant consolidated asset, or null when empty. */
function groupNav(view: GroupViewResponse, scope: Scope): Money | null {
  if (scope === 'consolidated') return view.consolidated[0]?.nav ?? null;
  const entity = view.entities.find((e) => e.entityCode === scope);
  return entity?.byAsset[0]?.nav ?? null;
}

function scopedEntities(view: GroupViewResponse, scope: Scope): GroupViewEntity[] {
  if (scope === 'consolidated') return [...view.entities];
  return view.entities.filter((e) => e.entityCode === scope);
}

/** Readable labels for the four fixed entities' static roles. */
const ROLE_LABEL: Record<EntityRole, string> = {
  TREASURY_NOTE_ISSUER: 'Treasury / Note issuer',
  COORDINATION: 'Coordination',
  TRADING: 'Trading',
  COIN_ISSUANCE: 'Coin issuance',
};

const RECON_STYLE: Record<ReconciliationStatus, { text: string; label: string; glyph: string }> = {
  RECONCILED: { text: 'text-gain', label: 'Reconciled', glyph: '✓' },
  DIVERGENT: { text: 'text-warn', label: 'Divergent', glyph: '!' },
  NOT_CHECKED: { text: 'text-muted-foreground', label: 'Not checked', glyph: '–' },
};

function ReconciliationBadge({ status }: { status: ReconciliationStatus }): React.JSX.Element {
  const s = RECON_STYLE[status];
  return (
    <span
      role="status"
      aria-label={`Reconciliation: ${s.label}`}
      className={cn('inline-flex items-center gap-1 text-xs font-medium', s.text)}
    >
      <span aria-hidden>{s.glyph}</span>
      {s.label}
    </span>
  );
}

/**
 * Presentational Treasury Dashboard / Covenant Console. Live hero KPIs, a bright-line covenant
 * monitor, net directional exposure, the coupled-coin book by market, a cross-entity reconciliation
 * table, and the per-account balances drill (account → postings → copy-tx-hash) — all from the live
 * group view. The divergence banner + entity switcher are retained. Empty state handled here;
 * loading/error in the container.
 */
export function CovenantConsoleView({
  view,
  now,
  onViewEntry,
}: {
  view: GroupViewResponse;
  now?: number;
  onViewEntry?: (entryId: string | null) => void;
}): React.JSX.Element {
  const [scope, setScope] = useState<Scope>('consolidated');
  const [expanded, setExpanded] = useState<string | null>(null);

  const entities = useMemo(() => scopedEntities(view, scope), [view, scope]);
  const nav = groupNav(view, scope);
  const backingFloat = sumNetByType(entities, 'BACKING_FLOAT');
  const clientCollateral = sumNetByType(entities, 'CLIENT_COLLATERAL');
  const backingRatio = ratioPercent(backingFloat, nav);

  if (view.entities.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <DivergenceBanner chainComparison={view.chainComparison} onViewEntry={onViewEntry} />
        <p className="text-muted-foreground">No balances yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <DivergenceBanner chainComparison={view.chainComparison} onViewEntry={onViewEntry} />

      <div className="flex items-center justify-between">
        <EntitySwitcher value={scope} onChange={setScope} />
        <LiveIndicator
          lastUpdated={view.generatedAt}
          refreshWindowMs={REFRESH_WINDOW_MS}
          now={now}
        />
      </div>

      {/* Hero KPIs — Group NAV, backing float, client collateral, and the live backing ratio. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={scope === 'consolidated' ? 'Group NAV' : `${scope} NAV`}
          figure={nav ? <MoneyCell money={nav} /> : '—'}
        />
        <StatCard
          label="Backing float"
          figure={backingFloat ? <MoneyCell money={backingFloat} /> : '—'}
        />
        <StatCard
          label="Client collateral"
          figure={clientCollateral ? <MoneyCell money={clientCollateral} /> : '—'}
        />
        <StatCard label="Backing ratio (of NAV)" figure={backingRatio} />
      </div>

      {/* Covenant monitor — the bright lines (group-level). Shown always; an explicit empty-state
          when no thresholds are configured, rather than silently hiding the section. */}
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-base font-semibold">Covenant monitor — the bright lines</h2>
        {view.covenants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Covenant thresholds not configured (set the <code>COVENANT_*</code> parameters to enable
            the monitor).
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {view.covenants.map((c) => (
              <CovenantBar key={c.key} covenant={c} />
            ))}
          </div>
        )}
      </section>

      {/* Net directional exposure — PER market (delta-neutral by construction ⇒ net ≈ 0). Coupled-pair
          leg values are raw "units" (no recorded scale), so they are never summed across markets. */}
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-base font-semibold">Net directional exposure</h2>
        {view.netExposure.length === 0 ? (
          <p className="text-sm text-muted-foreground">No coupled pairs.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {view.netExposure.map((m) => (
              <StatCard
                key={m.referenceAsset}
                label={`${m.referenceAsset} · net`}
                figure={
                  <span className="font-numeric">
                    {m.net} <span className="text-sm text-muted-foreground">units</span>
                  </span>
                }
                delta={
                  <span className="font-numeric text-muted-foreground">
                    <span className="text-long">Σ {m.longTotal}</span> /{' '}
                    <span className="text-short">Σ {m.shortTotal}</span>
                  </span>
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Coupled-coin book — coupled pairs aggregated by market. */}
      {view.coupledCoinBook.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold">Coupled-coin book</h2>
          <Table>
            <THead>
              <TR>
                <TH>Market</TH>
                <TH>Pairs</TH>
                <TH>L notional</TH>
                <TH>S notional</TH>
                <TH>Collateral K</TH>
                <TH>Net</TH>
              </TR>
            </THead>
            <TBody>
              {view.coupledCoinBook.map((m) => (
                <TR key={m.referenceAsset}>
                  <TD>{m.referenceAsset}</TD>
                  <TD className="font-numeric">{m.pairs}</TD>
                  <TD className="font-numeric text-long">{m.longNotional} units</TD>
                  <TD className="font-numeric text-short">{m.shortNotional} units</TD>
                  <TD className="font-numeric text-gold">{m.collateral} units</TD>
                  <TD className="font-numeric">{m.net} units</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      {/* Cross-entity reconciliation — role + dominant-asset NAV + reconciliation status. */}
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-base font-semibold">Cross-entity reconciliation</h2>
        <Table>
          <THead>
            <TR>
              <TH>Entity</TH>
              <TH>Role</TH>
              <TH>NAV</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {view.entities.map((entity) => (
              <TR key={entity.entityCode}>
                <TD>{entity.entityCode}</TD>
                <TD className="text-muted-foreground">{ROLE_LABEL[entity.role]}</TD>
                <TD>
                  {entity.byAsset[0] ? <MoneyCell money={entity.byAsset[0].nav} /> : '—'}
                </TD>
                <TD>
                  <ReconciliationBadge status={entity.reconciliationStatus} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>

      {/* Account balances — the per-account drill (account → postings → copy-tx-hash). */}
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-base font-semibold">Account balances</h2>
        <Table>
          <THead>
            <TR>
              <TH>Entity</TH>
              <TH>Account</TH>
              <TH>Type</TH>
              <TH>NAV role</TH>
              <TH>Net</TH>
            </TR>
          </THead>
          <TBody>
            {entities.flatMap((entity) =>
              entity.accounts.map((account) => {
                const key = `${entity.entityCode}:${account.accountId}`;
                const isOpen = expanded === key;
                return (
                  <ConsoleRow
                    key={key}
                    rowKey={key}
                    entityCode={entity.entityCode}
                    account={account}
                    isOpen={isOpen}
                    onToggle={() => setExpanded(isOpen ? null : key)}
                  />
                );
              }),
            )}
          </TBody>
        </Table>
      </section>
    </div>
  );
}

function ConsoleRow({
  rowKey,
  entityCode,
  account,
  isOpen,
  onToggle,
}: {
  rowKey: string;
  entityCode: EntityCode;
  account: AccountBalance;
  isOpen: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <>
      <TR
        className="cursor-pointer hover:bg-muted"
        onClick={onToggle}
        aria-expanded={isOpen}
        data-testid={`row-${rowKey}`}
      >
        <TD>{entityCode}</TD>
        <TD className="font-numeric text-xs">{account.accountId}</TD>
        <TD>{account.type}</TD>
        <TD>{account.navRole}</TD>
        <TD>
          <MoneyCell money={account.net} />
        </TD>
      </TR>
      {isOpen && (
        <TR data-testid={`drill-${rowKey}`}>
          <TD />
          <TD colSpan={4}>
            <div className="flex flex-wrap items-center gap-6 py-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                Total debit <MoneyCell money={account.totalDebit} />
              </span>
              <span className="inline-flex items-center gap-2">
                Total credit <MoneyCell money={account.totalCredit} />
              </span>
              <span className="inline-flex items-center gap-2">
                On-chain tx <CopyTxHash hash={null} />
              </span>
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}

/** Container: live group view with explicit loading/empty/error states (UX-DR4). */
export function CovenantConsole(): React.JSX.Element {
  const query = useGroupView();

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const code = query.error instanceof ApiClientError ? query.error.code : 'REQUEST_FAILED';
    return (
      <div role="alert" className="rounded-md border border-loss p-4 text-loss">
        <p>Failed to load the group view — {code}.</p>
        <button type="button" className="mt-2 underline" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!query.data) {
    return <p className="text-muted-foreground">No balances yet.</p>;
  }
  return <CovenantConsoleView view={query.data} now={query.dataUpdatedAt} />;
}
