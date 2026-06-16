import { useMemo, useState } from 'react';
import { CopyTxHash } from '../../components/ui/copy-tx-hash.js';
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
  GroupViewEntity,
  GroupViewResponse,
  Money,
} from '../../lib/contract-types.js';
import { REFRESH_WINDOW_MS, useGroupView } from '../../lib/queries.js';
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

/**
 * Presentational Covenant Console (AC-2, AC-4). Live group NAV hero, per-entity balances table with
 * drill (account → postings → copy-tx-hash), float yield + exposure derived from the group view, the
 * divergence banner, and the entity switcher. Empty state handled here; loading/error in the container.
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
  const floatBalance = sumNetByType(entities, 'BACKING_FLOAT');
  const floatYield = sumNetByType(entities, 'FEE_INCOME');
  const exposure = sumNetByType(entities, 'DEPLOYED_CAPITAL') ?? floatBalance;

  if (view.entities.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <DivergenceBanner chainComparison={view.chainComparison} onViewEntry={onViewEntry} />
        <p className="text-muted-foreground">No balances yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <DivergenceBanner chainComparison={view.chainComparison} onViewEntry={onViewEntry} />

      <div className="flex items-center justify-between">
        <EntitySwitcher value={scope} onChange={setScope} />
        <LiveIndicator
          lastUpdated={view.generatedAt}
          refreshWindowMs={REFRESH_WINDOW_MS}
          now={now}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label={scope === 'consolidated' ? 'Group NAV' : `${scope} NAV`}
          figure={nav ? <MoneyCell money={nav} /> : '—'}
        />
        <StatCard
          label="Float yield (FEE_INCOME)"
          figure={floatYield ? <MoneyCell money={floatYield} /> : '—'}
        />
        <StatCard label="Exposure" figure={exposure ? <MoneyCell money={exposure} /> : '—'} />
      </div>

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
