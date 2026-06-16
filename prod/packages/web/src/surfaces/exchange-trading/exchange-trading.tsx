import { DeltaIndicator } from '../../components/ui/delta-indicator.js';
import { LiveIndicator } from '../../components/ui/live-indicator.js';
import { MoneyCell } from '../../components/ui/money-cell.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatCard } from '../../components/ui/stat-card.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table.js';
import { ApiClientError } from '../../lib/api-client.js';
import type {
  AccountBalance,
  GroupViewEntity,
  GroupViewResponse,
} from '../../lib/contract-types.js';
import { REFRESH_WINDOW_MS, useGroupView } from '../../lib/queries.js';

/** An entity row's execution figures: deployed positions + realized P&L, by entity (paper/testnet). */
interface EntityExecution {
  entity: GroupViewEntity;
  positions: AccountBalance[]; // DEPLOYED_CAPITAL
  pnl: AccountBalance[]; // FEE_INCOME
}

/** Project each entity to its execution accounts; keep only entities that actually traded. */
function deriveExecution(view: GroupViewResponse): EntityExecution[] {
  return view.entities
    .map((entity) => ({
      entity,
      positions: entity.accounts.filter((a) => a.type === 'DEPLOYED_CAPITAL'),
      pnl: entity.accounts.filter((a) => a.type === 'FEE_INCOME'),
    }))
    .filter((e) => e.positions.length > 0 || e.pnl.length > 0);
}

/** The P&L direction from the net smallest-units sign (no float math — BigInt compare). */
function pnlDirection(units: string): 'up' | 'down' | 'flat' {
  const n = BigInt(units);
  return n > 0n ? 'up' : n < 0n ? 'down' : 'flat';
}

// The DeltaIndicator owns the sign+glyph (UX-DR2); its `label` must be the unsigned MAGNITUDE only,
// else a negative P&L would render a double sign (e.g. "▾ −-1250.00"). Strip a leading '-'.
function magnitude(decimal: string): string {
  return decimal.replace(/^-/, '');
}

/**
 * Presentational Exchange/Trading view (AC-1, FR-14, FR-20): live (paper/testnet) execution,
 * positions, and P&L **by entity** derived from the group view (TRADING_CO's DEPLOYED_CAPITAL +
 * FEE_INCOME) plus the open coupled-pair legs — money cells + a signed P&L delta (glyph, never
 * color-only) + the lifecycle badge. Empty state handled here; loading/error in the container.
 */
export function ExchangeTradingView({
  view,
  now,
}: {
  view: GroupViewResponse;
  now?: number;
}): React.JSX.Element {
  const execution = deriveExecution(view);
  const pairs = view.coupledPairs;

  if (execution.length === 0 && pairs.length === 0) {
    return <p className="text-muted-foreground">No trading activity yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <LiveIndicator
          lastUpdated={view.generatedAt}
          refreshWindowMs={REFRESH_WINDOW_MS}
          now={now}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {execution.flatMap((e) =>
          e.pnl.map((pnl) => (
            <StatCard
              key={`${e.entity.entityCode}:${pnl.accountId}`}
              label={`${e.entity.entityCode} realized P&L`}
              figure={<MoneyCell money={pnl.net} />}
              delta={
                <DeltaIndicator
                  direction={pnlDirection(pnl.net.smallestUnits)}
                  label={magnitude(pnl.net.decimal)}
                />
              }
            />
          )),
        )}
      </div>

      <section>
        <h2 className="mb-2 font-display text-base font-semibold">
          Positions &amp; P&amp;L by entity
        </h2>
        <Table>
          <THead>
            <TR>
              <TH>Entity</TH>
              <TH>Account</TH>
              <TH>Type</TH>
              <TH>Net</TH>
            </TR>
          </THead>
          <TBody>
            {execution.flatMap((e) =>
              [...e.positions, ...e.pnl].map((account) => (
                <TR key={`${e.entity.entityCode}:${account.accountId}`}>
                  <TD>{e.entity.entityCode}</TD>
                  <TD className="font-numeric text-xs">{account.accountId}</TD>
                  <TD>{account.type}</TD>
                  <TD>
                    <MoneyCell money={account.net} />
                  </TD>
                </TR>
              )),
            )}
          </TBody>
        </Table>
      </section>

      <section>
        <h2 className="mb-2 font-display text-base font-semibold">Open coupled-pair positions</h2>
        {pairs.length === 0 ? (
          <p className="text-muted-foreground">No open pairs.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Pair</TH>
                <TH>State</TH>
                <TH>V_A</TH>
                <TH>V_B</TH>
                <TH>K</TH>
              </TR>
            </THead>
            <TBody>
              {pairs.map((pair) => (
                <TR key={pair.id}>
                  <TD>{pair.referenceAsset}</TD>
                  <TD>
                    <StatusBadge status={pair.state} />
                  </TD>
                  <TD className="font-numeric tabular-nums">{pair.longLegValue}</TD>
                  <TD className="font-numeric tabular-nums">{pair.shortLegValue}</TD>
                  <TD className="font-numeric tabular-nums">{pair.collateralPool}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}

/** Container: live group view with explicit loading/empty/error states (UX-DR4). */
export function ExchangeTrading(): React.JSX.Element {
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
        <p>Failed to load trading activity — {code}.</p>
        <button type="button" className="mt-2 underline" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!query.data) {
    return <p className="text-muted-foreground">No trading activity yet.</p>;
  }
  return <ExchangeTradingView view={query.data} now={query.dataUpdatedAt} />;
}
