import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  ConfirmActionPanel,
  type PairSummary,
  type WriteStatus,
} from '../../components/ui/confirm-action-panel.js';
import { ApiClientError } from '../../lib/api-client.js';
import type { CoupledPairPosition, Money, PositionSide } from '../../lib/contract-types.js';
import { legTokenSymbols } from '../../lib/leg-symbols.js';
import { deriveFloorUnits } from '../../lib/pair-math.js';
import { useOpenPosition, useOpenPositionFlow } from '../../lib/queries.js';

// Paper/local demo defaults — the deployed flow reads the payment asset/scale from the pair config
// (ops-deferred). The position-open amount crosses the wire as a smallest-units integer STRING
// (NFR-2); this only formats it for display (BigInt-safe).
const PAYMENT_ASSET = 'EUR';
const PAYMENT_SCALE = 2;

function formatUnits(units: string, scale: number): string {
  const safe = units.length > 0 ? units : '0';
  if (scale === 0) return safe;
  const neg = safe.startsWith('-');
  const digits = (neg ? safe.slice(1) : safe).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

function Row({ k, v, hl }: { k: string; v: string; hl?: boolean }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-dim">{k}</dt>
      <dd className={hl ? 'text-right text-gold' : 'text-right'}>{v}</dd>
    </div>
  );
}

/**
 * The position-OPEN write flow on the terminal (Story 8.3, FR-25, UX-DR6, NFR-9). Reuses the
 * pessimistic `ConfirmActionPanel`: on Confirm it fires the real `POST /positions/open` mutation,
 * captures the pending flow handle, and the panel stays **pending** ("Awaiting Sepolia confirmation…")
 * while `GET /positions/open/:id` is polled — it shows success ONLY once the polled flow reads
 * `confirmed` (no optimistic success). A typed refusal (409/422/503) surfaces its machine `code` +
 * message (e.g. a 503 `POSITION_SERVICE_UNAVAILABLE` ⇒ "not available on this deployment").
 */
function TerminalOpenFlow({
  pair,
  side,
  owner,
  pairSummary,
  onClose,
}: {
  pair: CoupledPairPosition;
  side: PositionSide;
  owner: string;
  pairSummary: PairSummary;
  onClose: () => void;
}): React.JSX.Element {
  const [amountUnits, setAmountUnits] = useState('100000');
  const openMut = useOpenPosition();
  const [handle, setHandle] = useState('');
  const flow = useOpenPositionFlow(handle);
  const statusData = flow.data;

  const amount: Money = {
    asset: PAYMENT_ASSET,
    scale: PAYMENT_SCALE,
    smallestUnits: amountUnits,
    decimal: formatUnits(amountUnits, PAYMENT_SCALE),
  };

  let writeStatus: WriteStatus = 'idle';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  if (openMut.isError) {
    writeStatus = 'failed';
    errorCode = openMut.error instanceof ApiClientError ? openMut.error.code : 'REQUEST_FAILED';
    errorMessage = openMut.error instanceof ApiClientError ? openMut.error.message : undefined;
  } else if (statusData?.status === 'confirmed') {
    writeStatus = 'confirmed';
  } else if (statusData?.status === 'failed') {
    writeStatus = 'failed';
    errorCode = 'WRITE_FAILED';
  } else if (openMut.isPending || handle.length > 0) {
    writeStatus = 'pending';
  }

  function onConfirm(): void {
    // A fresh idempotency key per submit (NFR-9 exactly-once); the owner+side scope keeps two distinct
    // owners/sides from colliding on one key.
    const idempotencyKey = `open:${pair.id}:${owner}:${side}:${amountUnits}:${Date.now()}`;
    openMut.mutate(
      {
        coupledPairId: pair.id,
        owner,
        side,
        amount: amountUnits,
        paymentAsset: PAYMENT_ASSET,
        idempotencyKey,
      },
      { onSuccess: (v) => setHandle(v.id) },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {writeStatus === 'idle' && (
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">Amount (smallest units)</span>
          <input
            className="w-36 rounded-md border border-border bg-background px-2 py-1 text-right font-numeric tabular-nums"
            inputMode="numeric"
            value={amountUnits}
            aria-label="Amount in smallest units"
            onChange={(e) => setAmountUnits(e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
      )}
      <ConfirmActionPanel
        action="subscribe"
        amount={amount}
        paymentAsset={PAYMENT_ASSET}
        pair={pairSummary}
        status={writeStatus}
        errorCode={errorCode}
        errorMessage={errorMessage}
        onConfirm={onConfirm}
        onCancel={onClose}
      />
    </div>
  );
}

/**
 * Right column. ROSE coins are issued as an ATOMIC L+S package (the core coupling invariant — a naked
 * single leg is impossible on-chain), so this is NOT a perp order ticket: it shows the selected
 * market's REAL package terms, a LONG/SHORT direction selector + a DISABLED / fixed-1x leverage
 * selector (P0 pins leverage to 1x), and an Open action that opens a directional POSITION (`POST
 * /positions/open`) through the Review→Confirm panel (pending until the on-chain commit point, UX-DR6).
 * Closing happens per position row in the positions table. No fabricated balances, no optimistic write.
 */
export function OrderTicket({
  pair,
  owner,
  onNavigate,
}: {
  pair: CoupledPairPosition | null;
  owner?: string;
  onNavigate?: (surface: 'subscriber') => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<PositionSide>('LONG');

  if (!pair) {
    return (
      <div className="p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">Order ticket</p>
        <p className="mt-3 text-sm text-muted-foreground">No open pair for this market yet.</p>
      </div>
    );
  }
  const sym = legTokenSymbols(pair.referenceAsset);
  const floorUnits = deriveFloorUnits(pair.collateralPool, pair.floor).toString();
  const pairSummary: PairSummary = { referenceAsset: pair.referenceAsset, state: pair.state };
  const canTrade = (owner ?? '').length > 0;

  if (open) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">
          Open {side} position
        </p>
        <TerminalOpenFlow
          pair={pair}
          side={side}
          owner={owner ?? ''}
          pairSummary={pairSummary}
          onClose={() => setOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">Order ticket</p>
      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <p className="mb-2 font-semibold">Acquire the coupled package</p>
        <p className="text-xs text-muted-foreground">
          Issued as an atomic <span className="text-long">{sym.long}</span> +{' '}
          <span className="text-short">{sym.short}</span> pair — delta-neutral at issuance, never a
          naked leg.
        </p>
        <dl className="mt-3 flex flex-col gap-1.5 font-numeric text-xs">
          <Row k="Reference" v={pair.referenceAsset} />
          <Row k="Anchor (P₀)" v={pair.anchorPrice} />
          <Row k="Leverage" v={`${pair.leverage}×`} />
          <Row k="Collateral (K)" v={`${pair.collateralPool} units`} />
          <Row k="Floor (f)" v={`${pair.floor} · ${floorUnits} units`} />
          <Row k="Max loss" v="Floored — never into debt" hl />
        </dl>
      </div>

      {/* Direction — the recorded off-chain directional side of the position (LONG | SHORT). */}
      <label className="flex items-center justify-between gap-2 text-xs">
        <span className="text-dim">Direction</span>
        <select
          aria-label="Position side"
          value={side}
          onChange={(e) => setSide(e.target.value as PositionSide)}
          className="rounded-md border border-border bg-background px-2 py-1 font-numeric"
        >
          <option value="LONG">Long</option>
          <option value="SHORT">Short</option>
        </select>
      </label>

      {/* Leverage selector — DISABLED / fixed-1x in P0 (leverage is modelled but pinned to 1x). */}
      <label className="flex items-center justify-between gap-2 text-xs">
        <span className="text-dim">Position leverage</span>
        <select
          aria-label="Position leverage"
          value="1"
          disabled
          title="Leverage is fixed at 1× in P0"
          className="rounded-md border border-border bg-muted px-2 py-1 font-numeric text-muted-foreground"
        >
          <option value="1">1× (fixed)</option>
        </select>
      </label>

      {canTrade ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => setOpen(true)}>
            Open position
          </Button>
        </div>
      ) : onNavigate ? (
        <button
          type="button"
          onClick={() => onNavigate('subscriber')}
          className="rounded-lg border border-border bg-muted px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-elevated"
        >
          Subscribe to or redeem this package in the{' '}
          <span className="text-foreground">Subscriber</span> surface →
        </button>
      ) : (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          Subscribe to or redeem this package from the{' '}
          <span className="text-foreground">Subscriber</span> surface.
        </p>
      )}

      <div className="rounded-lg border border-long/20 bg-long/5 p-3 text-xs text-muted-foreground">
        <span className="text-long" aria-hidden>
          ◈
        </span>{' '}
        Collateral is segregated and 100% withdrawable; the package floors at zero.
      </div>
    </div>
  );
}
