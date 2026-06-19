import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  ConfirmActionPanel,
  type PairSummary,
  type WriteStatus,
} from '../../components/ui/confirm-action-panel.js';
import { ApiClientError } from '../../lib/api-client.js';
import type { CoupledPairPosition, Money } from '../../lib/contract-types.js';
import { legTokenSymbols } from '../../lib/leg-symbols.js';
import { deriveFloorUnits } from '../../lib/pair-math.js';
import { useRedeem, useRedemption, useSubscribe, useSubscription } from '../../lib/queries.js';

// Paper/local demo defaults — the deployed flow reads the payment asset/scale from the Note/pair
// config (ops-deferred, see deferred-work.md story-6.6). The subscribe/redeem amount crosses the wire
// as a smallest-units integer STRING (NFR-2); this only formats it for display (BigInt-safe).
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
 * The open/close write flow on the terminal (AC-3, UX-DR6, NFR-9). Reuses the pessimistic
 * `ConfirmActionPanel`: on Confirm it fires the real subscribe/redeem mutation, captures the pending
 * handle, and the panel stays **pending** ("Awaiting Sepolia confirmation…") while the status endpoint
 * is polled — it shows success ONLY once the polled status returns `confirmed` (no optimistic success).
 * A typed refusal (403/422/409/503) surfaces its machine `code`.
 */
function TerminalWriteFlow({
  action,
  roseNoteId,
  pair,
  owner,
  onClose,
}: {
  action: 'subscribe' | 'redeem';
  roseNoteId: string;
  pair: PairSummary;
  owner: string;
  onClose: () => void;
}): React.JSX.Element {
  const [amountUnits, setAmountUnits] = useState('100000');
  const subscribeMut = useSubscribe();
  const redeemMut = useRedeem();
  const [handle, setHandle] = useState('');
  const subStatus = useSubscription(action === 'subscribe' ? handle : '');
  const redStatus = useRedemption(action === 'redeem' ? handle : '');

  const amount: Money = {
    asset: PAYMENT_ASSET,
    scale: PAYMENT_SCALE,
    smallestUnits: amountUnits,
    decimal: formatUnits(amountUnits, PAYMENT_SCALE),
  };

  const mut = action === 'subscribe' ? subscribeMut : redeemMut;
  const statusData = action === 'subscribe' ? subStatus.data : redStatus.data;

  let writeStatus: WriteStatus = 'idle';
  let errorCode: string | undefined;
  if (mut.isError) {
    writeStatus = 'failed';
    errorCode = mut.error instanceof ApiClientError ? mut.error.code : 'REQUEST_FAILED';
  } else if (statusData?.status === 'confirmed') {
    writeStatus = 'confirmed';
  } else if (statusData?.status === 'failed') {
    writeStatus = 'failed';
    errorCode = 'WRITE_FAILED';
  } else if (mut.isPending || handle.length > 0) {
    writeStatus = 'pending';
  }

  function onConfirm(): void {
    // Include the owner so two distinct owners don't collide on one exactly-once key (NFR-9).
    const idempotencyKey = `${action}:${roseNoteId}:${owner}:${amountUnits}`;
    if (action === 'subscribe') {
      subscribeMut.mutate(
        {
          roseNoteId,
          body: {
            subscriber: owner,
            amount: amountUnits,
            paymentAsset: PAYMENT_ASSET,
            idempotencyKey,
          },
        },
        { onSuccess: (s) => setHandle(s.id) },
      );
    } else {
      redeemMut.mutate(
        {
          roseNoteId,
          body: {
            redeemer: owner,
            amount: amountUnits,
            paymentAsset: PAYMENT_ASSET,
            idempotencyKey,
          },
        },
        { onSuccess: (r) => setHandle(r.id) },
      );
    }
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
        action={action}
        amount={amount}
        paymentAsset={PAYMENT_ASSET}
        pair={pair}
        status={writeStatus}
        errorCode={errorCode}
        onConfirm={onConfirm}
        onCancel={onClose}
      />
    </div>
  );
}

/**
 * Right column. ROSE coins are issued as an ATOMIC L+S package (the core coupling invariant — a
 * naked single leg is impossible on-chain), so this is NOT a perp order ticket: it shows the
 * selected market's REAL package terms, a DISABLED / fixed-1x leverage selector (P0 pins leverage to
 * 1x), and Open/Close actions that pass the Review→Confirm panel (pending until the on-chain commit
 * point, UX-DR6). No fabricated balances, no optimistic write.
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
  const [mode, setMode] = useState<'subscribe' | 'redeem' | null>(null);

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
  const canTrade = pair.noteId !== null && (owner ?? '').length > 0;

  if (mode && pair.noteId !== null) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">
          {mode === 'subscribe' ? 'Open position' : 'Close position'}
        </p>
        <TerminalWriteFlow
          action={mode}
          roseNoteId={pair.noteId}
          pair={pairSummary}
          owner={owner ?? ''}
          onClose={() => setMode(null)}
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
          <Button variant="primary" onClick={() => setMode('subscribe')}>
            Open position
          </Button>
          <Button variant="outline" onClick={() => setMode('redeem')}>
            Close position
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
