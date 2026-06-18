import { useState } from 'react';
import { DeltaIndicator } from '../../components/ui/delta-indicator.js';
import { LiveIndicator } from '../../components/ui/live-indicator.js';
import { MoneyCell } from '../../components/ui/money-cell.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatCard } from '../../components/ui/stat-card.js';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table.js';
import { ApiClientError } from '../../lib/api-client.js';
import { cn } from '../../lib/cn.js';
import type {
  AccountBalance,
  GroupViewEntity,
  GroupViewResponse,
} from '../../lib/contract-types.js';
import { REFRESH_WINDOW_MS, useGroupView } from '../../lib/queries.js';
import { ChartPlaceholder } from './chart-placeholder.js';
import { MarketList } from './market-list.js';
import { OrderTicket } from './order-ticket.js';
import { PairStrip } from './pair-strip.js';
import { PositionsTable } from './positions-table.js';

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

/** A single labelled metric in the chart-head stat strip; `feed` marks a price-feed-dependent gap. */
function Stat({ label, value, feed }: { label: string; value: string; feed?: boolean }): React.JSX.Element {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-dim">{label}</p>
      <p className={cn('font-numeric text-sm', feed && 'text-dim')}>
        {value}
        {feed && <span className="ml-1 text-[10px]">(price feed)</span>}
      </p>
    </div>
  );
}

const PANEL = 'rounded-lg border border-border bg-card';

/**
 * Exchange/Trading terminal (AC-1, FR-14, FR-20). A 3-column trading-terminal layout — market list |
 * chart + pair strip | order ticket — honestly adapted to ROSE's atomic coupled-PACKAGE model (no
 * naked single-leg trading; the order ticket points to the real subscribe/redeem flow). Markets come
 * from the live `coupledCoinBook`; open coupled-pair positions and per-entity execution/P&L are live.
 * Everything that needs a price oracle (chart, live mark, 24h hi/lo, open interest, live P&L) renders
 * an explicit "price feed" empty-state — never fabricated. Loading/error live in the container.
 */
export function ExchangeTradingView({
  view,
  now,
  onNavigate,
}: {
  view: GroupViewResponse;
  now?: number;
  onNavigate?: (surface: 'subscriber') => void;
}): React.JSX.Element {
  const execution = deriveExecution(view);
  const markets = view.coupledCoinBook;
  const pairs = view.coupledPairs;
  const [selected, setSelected] = useState<string | null>(markets[0]?.referenceAsset ?? null);

  if (execution.length === 0 && pairs.length === 0 && markets.length === 0) {
    return <p className="text-muted-foreground">No trading activity yet.</p>;
  }

  const market = markets.find((m) => m.referenceAsset === selected) ?? markets[0] ?? null;
  const marketPair = market
    ? (pairs.find((p) => p.referenceAsset === market.referenceAsset) ?? null)
    : null;
  const scopedPairs = market
    ? pairs.filter((p) => p.referenceAsset === market.referenceAsset)
    : pairs;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <LiveIndicator lastUpdated={view.generatedAt} refreshWindowMs={REFRESH_WINDOW_MS} now={now} />
      </div>

      {market && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_320px]">
          <div className={cn(PANEL, 'min-w-0 p-2')}>
            <MarketList markets={markets} selected={market.referenceAsset} onSelect={setSelected} />
          </div>

          <div className={cn(PANEL, 'flex min-w-0 flex-col')}>
            <div className="border-b border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-display text-lg font-semibold">{market.referenceAsset}</h2>
                  <p className="text-xs text-dim">
                    coupled L/S pair · {market.pairs} outstanding
                  </p>
                </div>
                <div className="text-right text-dim">
                  <p className="font-numeric text-2xl leading-none">—</p>
                  <p className="mt-1 text-[11px]">price feed not connected</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-6">
                <Stat label="Pair TVL" value={`${market.collateral} u`} />
                <Stat label="Pairs" value={String(market.pairs)} />
                <Stat label="Leverage" value={marketPair ? `${marketPair.leverage}×` : '—'} />
                <Stat label="24h High" value="—" feed />
                <Stat label="24h Low" value="—" feed />
                <Stat label="Open interest" value="—" feed />
              </div>
            </div>
            <div className="p-4">
              <ChartPlaceholder />
            </div>
            <div className="border-t border-border p-4">
              <PairStrip market={market} />
            </div>
          </div>

          <div className={cn(PANEL, 'min-w-0')}>
            <OrderTicket pair={marketPair} onNavigate={onNavigate} />
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-2 font-display text-base font-semibold">
          Open positions{market ? ` · ${market.referenceAsset}` : ''}
        </h2>
        <PositionsTable pairs={scopedPairs} />
      </section>

      {execution.length > 0 && (
        <>
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
        </>
      )}
    </div>
  );
}

/** Container: live group view with explicit loading/empty/error states (UX-DR4). */
export function ExchangeTrading({
  onNavigate,
}: {
  onNavigate?: (surface: 'subscriber') => void;
} = {}): React.JSX.Element {
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
  return (
    <ExchangeTradingView view={query.data} now={query.dataUpdatedAt} onNavigate={onNavigate} />
  );
}
