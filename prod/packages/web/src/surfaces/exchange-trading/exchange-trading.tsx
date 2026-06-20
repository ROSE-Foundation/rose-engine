import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  ConfirmActionPanel,
  type PairSummary,
  type WriteStatus,
} from '../../components/ui/confirm-action-panel.js';
import { DeltaIndicator } from '../../components/ui/delta-indicator.js';
import { LiveIndicator } from '../../components/ui/live-indicator.js';
import { MoneyCell } from '../../components/ui/money-cell.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { StatCard } from '../../components/ui/stat-card.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table.js';
import { ApiClientError } from '../../lib/api-client.js';
import { cn } from '../../lib/cn.js';
import type {
  AccountBalance,
  CoupledPairState,
  GroupViewEntity,
  GroupViewResponse,
  Money,
  Position,
  PositionMark,
} from '../../lib/contract-types.js';
import {
  REFRESH_WINDOW_MS,
  useClosePosition,
  useClosePositionFlow,
  useGroupView,
  usePositions,
  useReconcilePositions,
} from '../../lib/queries.js';
import { ChartPlaceholder } from './chart-placeholder.js';
import { KycOnboardingControl } from './kyc-onboarding.js';
import { MarketList } from './market-list.js';
import { PayoffChart } from './payoff-chart.js';
import { OrderTicket } from './order-ticket.js';
import { PairStrip } from './pair-strip.js';
import { PositionsTable } from './positions-table.js';

// Paper/local demo default — the close collateral/payment asset (matches the order-ticket open default).
const PAYMENT_ASSET = 'EUR';

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

/** The chart-head live price for the selected market: the OK mark price, a stale figure, or the
 * honest "price feed not connected" empty-state when no oracle/position is available (UX-DR4). Never
 * fabricates a price. The representative `mark` is taken from a held position on this market. */
function MarketPrice({ mark }: { mark: PositionMark | null }): React.JSX.Element {
  if (mark && mark.status === 'OK' && mark.markPrice !== null) {
    return (
      <div className="text-right">
        <p className="font-numeric text-2xl leading-none">{mark.markPrice}</p>
        <p className="mt-1 text-[11px] text-gain">live mark</p>
      </div>
    );
  }
  if (mark && mark.status === 'STALE' && mark.markPrice !== null) {
    return (
      <div className="text-right text-warn">
        <p className="font-numeric text-2xl leading-none">{mark.markPrice}</p>
        <p className="mt-1 text-[11px]">stale mark</p>
      </div>
    );
  }
  return (
    <div className="text-right text-dim">
      <p className="font-numeric text-2xl leading-none">—</p>
      <p className="mt-1 text-[11px]">price feed not connected</p>
    </div>
  );
}

/** A single labelled metric in the chart-head stat strip; `feed` marks a price-feed-dependent gap. */
function Stat({
  label,
  value,
  feed,
}: {
  label: string;
  value: string;
  feed?: boolean;
}): React.JSX.Element {
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
 * The position-CLOSE write flow (Stories 8.3/8.6, FR-25, UX-DR6). Reuses the pessimistic
 * `ConfirmActionPanel`: on Confirm it fires `POST /positions/close`, captures the pending flow handle,
 * and stays **pending** until the polled `GET /positions/close/:id` reads `confirmed` (no optimistic
 * success). The headline Epic-8.6 behaviour: a D1 single-side close is refused with a typed 409
 * `SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` — surfaced as an explicit, §11.4-rule-NAMED refusal
 * (UX-DR5), carrying the boundary's message, not a generic error. A 503 surfaces "not available …".
 */
function PositionCloseFlow({
  position,
  pairState,
  onCancel,
}: {
  position: Position;
  pairState: CoupledPairState;
  onCancel: () => void;
}): React.JSX.Element {
  const closeMut = useClosePosition();
  const [handle, setHandle] = useState('');
  const flow = useClosePositionFlow(handle);
  const statusData = flow.data;

  // The close size is the position's collateral magnitude — surfaced for the Review step (NFR-2 string).
  const amount: Money = {
    asset: PAYMENT_ASSET,
    scale: 2,
    smallestUnits: position.collateral,
    decimal: position.collateral,
  };
  const pairSummary: PairSummary = { referenceAsset: position.referenceAsset, state: pairState };

  let writeStatus: WriteStatus = 'idle';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  if (closeMut.isError) {
    writeStatus = 'failed';
    errorCode = closeMut.error instanceof ApiClientError ? closeMut.error.code : 'REQUEST_FAILED';
    errorMessage = closeMut.error instanceof ApiClientError ? closeMut.error.message : undefined;
  } else if (statusData?.status === 'confirmed') {
    writeStatus = 'confirmed';
  } else if (statusData?.status === 'failed') {
    writeStatus = 'failed';
    errorCode = 'WRITE_FAILED';
  } else if (closeMut.isPending || handle.length > 0) {
    writeStatus = 'pending';
  }

  function onConfirm(): void {
    // A fresh idempotency key per submit (NFR-9 exactly-once).
    const idempotencyKey = `close:${position.id}:${Date.now()}`;
    closeMut.mutate(
      { positionId: position.id, paymentAsset: PAYMENT_ASSET, idempotencyKey },
      { onSuccess: (v) => setHandle(v.id) },
    );
  }

  return (
    <div className="mt-3 max-w-md">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-dim">
        Close {position.side} {position.referenceAsset} position
      </p>
      <ConfirmActionPanel
        action="redeem"
        amount={amount}
        paymentAsset={PAYMENT_ASSET}
        pair={pairSummary}
        status={writeStatus}
        errorCode={errorCode}
        errorMessage={errorMessage}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}

/** One residual-backing row of the reconciliation report (per pair + side). */
function backingRowKey(coupledPairId: string, side: string): string {
  return `${coupledPairId}:${side}`;
}

/**
 * Operator panel (Story 8.5, FR-27): runs `POST /positions/reconcile` on demand and renders the
 * per-(pair, side) residual-backing report (backing vs exposure + an over-exposed flag) plus any
 * position↔pair mismatches/corrections. A 503 `POSITION_SERVICE_UNAVAILABLE` (non-paper deployment)
 * degrades to a clean "not available on this deployment" state. Behavioural/minimal — reuses existing
 * components/styles, no new visual design system.
 */
function ReconciliationPanel(): React.JSX.Element {
  const reconcile = useReconcilePositions();
  const report = reconcile.data;
  const err = reconcile.error;
  const unavailable = err instanceof ApiClientError && err.status === 503;
  const code = err instanceof ApiClientError ? err.code : 'REQUEST_FAILED';

  return (
    <section className={cn(PANEL, 'p-4')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold">
            Operator · position↔pair reconciliation
          </h2>
          <p className="text-xs text-dim">
            Per-(pair, side) residual-backing solvency report (report-only, FR-27).
          </p>
        </div>
        <Button variant="outline" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
          {reconcile.isPending ? 'Reconciling…' : 'Run reconciliation'}
        </Button>
      </div>

      <div aria-live="polite" className="mt-3">
        {unavailable && (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            Reconciliation is not available on this deployment ({code}).
          </p>
        )}
        {err && !unavailable && (
          <p role="alert" className="text-sm text-loss">
            ✗ Reconciliation failed — {code}.
          </p>
        )}
        {report && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <StatusBadge status={report.anyOverExposure ? 'divergent' : 'live'} />
              <span className="text-dim">
                {report.anyOverExposure
                  ? `${report.overExposedSides.length} over-exposed side(s)`
                  : 'All sides solvent'}
                {report.anyMismatch ? ` · ${report.mismatches.length} mismatch(es)` : ''}
                {report.anyCorrected ? ` · ${report.corrections} correction(s)` : ''}
              </span>
            </div>
            {report.sideBacking.length === 0 ? (
              <p className="text-sm text-muted-foreground">No positions to reconcile.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Market</TH>
                    <TH>Side</TH>
                    <TH>Backing</TH>
                    <TH>Exposure</TH>
                    <TH>Headroom</TH>
                    <TH>Solvency</TH>
                  </TR>
                </THead>
                <TBody>
                  {report.sideBacking.map((row) => (
                    <TR key={backingRowKey(row.coupledPairId, row.side)}>
                      <TD>{row.referenceAsset}</TD>
                      <TD>
                        <span className={row.side === 'LONG' ? 'text-long' : 'text-short'}>
                          {row.side}
                        </span>
                      </TD>
                      <TD className="font-numeric tabular-nums">{row.backing}</TD>
                      <TD className="font-numeric tabular-nums">{row.exposure}</TD>
                      <TD className="font-numeric tabular-nums">{row.headroom}</TD>
                      <TD>
                        <StatusBadge status={row.overExposed ? 'divergent' : 'live'} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

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
  positions = [],
  owner,
  now,
  onNavigate,
  showOperatorTools = true,
}: {
  view: GroupViewResponse;
  /** The viewer's live per-user positions + marks (Story 8.4). Empty ⇒ no oracle/owner wired. */
  positions?: readonly Position[];
  /** The viewer's owner reference — drives the order-ticket open/close target (paper/local). */
  owner?: string;
  now?: number;
  onNavigate?: (surface: 'subscriber') => void;
  /** Role gate (Story 9.3): the operator-only tools (reconciliation panel + KYC control) render only
   * for an operator identity. Defaults to `true` (backward-compatible with the pre-session callers). */
  showOperatorTools?: boolean;
}): React.JSX.Element {
  const execution = deriveExecution(view);
  const markets = view.coupledCoinBook;
  const pairs = view.coupledPairs;
  const [selected, setSelected] = useState<string | null>(markets[0]?.referenceAsset ?? null);
  // The position the operator is closing (a per-row action on the positions table); null ⇒ none.
  const [closing, setClosing] = useState<Position | null>(null);

  if (execution.length === 0 && pairs.length === 0 && markets.length === 0) {
    return <p className="text-muted-foreground">No trading activity yet.</p>;
  }

  const market = markets.find((m) => m.referenceAsset === selected) ?? markets[0] ?? null;
  const marketPair = market
    ? (pairs.find((p) => p.referenceAsset === market.referenceAsset) ?? null)
    : null;
  const scopedPositions = market
    ? positions.filter((p) => p.referenceAsset === market.referenceAsset)
    : positions;
  // The representative live mark for the chart-head price (a held position on this market).
  const marketMark = scopedPositions[0]?.mark ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <LiveIndicator
          lastUpdated={view.generatedAt}
          refreshWindowMs={REFRESH_WINDOW_MS}
          now={now}
        />
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
                  <p className="text-xs text-dim">coupled L/S pair · {market.pairs} outstanding</p>
                </div>
                <MarketPrice mark={marketMark} />
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
              {marketPair ? <PayoffChart pair={marketPair} /> : <ChartPlaceholder />}
            </div>
            <div className="border-t border-border p-4">
              <PairStrip market={market} />
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {showOperatorTools && <KycOnboardingControl address={owner ?? ''} />}
            <div className={cn(PANEL, 'min-w-0')}>
              <OrderTicket pair={marketPair} owner={owner} onNavigate={onNavigate} />
            </div>
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-2 font-display text-base font-semibold">
          Open positions{market ? ` · ${market.referenceAsset}` : ''}
        </h2>
        <PositionsTable positions={scopedPositions} onClose={setClosing} />
        {closing && (
          <PositionCloseFlow
            position={closing}
            pairState={pairs.find((p) => p.id === closing.coupledPairId)?.state ?? 'ACTIVE'}
            onCancel={() => setClosing(null)}
          />
        )}
      </section>

      {showOperatorTools && <ReconciliationPanel />}

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

/** Container: live group view + the viewer's live positions/marks, with explicit loading/empty/error
 * states (UX-DR4). The `owner` is an injected prop in paper/local (the deployed session/ONCHAINID
 * source is ops-deferred); empty ⇒ no positions query and the honest no-feed terminal. */
export function ExchangeTrading({
  owner = '',
  onNavigate,
  showOperatorTools = true,
}: {
  owner?: string;
  onNavigate?: (surface: 'subscriber') => void;
  showOperatorTools?: boolean;
} = {}): React.JSX.Element {
  const query = useGroupView();
  const positionsQuery = usePositions(owner);

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
    <ExchangeTradingView
      view={query.data}
      positions={positionsQuery.data?.positions ?? []}
      owner={owner}
      now={query.dataUpdatedAt}
      onNavigate={onNavigate}
      showOperatorTools={showOperatorTools}
    />
  );
}
