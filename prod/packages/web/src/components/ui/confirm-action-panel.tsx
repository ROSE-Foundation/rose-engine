import { useState } from 'react';
import { Button } from './button.js';
import { Card, CardContent, CardHeader } from './card.js';
import { MoneyCell } from './money-cell.js';
import { StatusBadge } from './status-badge.js';
import type { CoupledPairState, Money } from '../../lib/contract-types.js';

/** The lifecycle of a write+poll the panel reflects (pessimistic: no optimistic success, UX-DR6). */
export type WriteStatus = 'idle' | 'pending' | 'confirmed' | 'failed';

/** A minimal summary of the embedded coupled pair shown on the Review step. */
export interface PairSummary {
  referenceAsset: string;
  state: CoupledPairState;
}

const CONSEQUENCE: Record<'subscribe' | 'redeem', string> = {
  subscribe:
    'On confirm: a paired L/S mint on Sepolia. Your position opens once the chain commits.',
  redeem:
    'On confirm: a paired burn of the whole package on Sepolia. Your position closes once the chain commits.',
};

/**
 * The two-step Review → Confirm panel reused by subscribe and redeem (UX-DR6, NFR-9). Review states
 * the amount (from the decimal string), the asset, the embedded pair, and the on-chain consequence.
 * On Confirm the panel goes **pending** ("Awaiting Sepolia confirmation…") and STAYS in-flight until
 * the polled `status` resolves to `confirmed` (success) or `failed` (a typed refusal naming the
 * machine `code`) — it NEVER shows success before the on-chain commit point. Fully keyboard-operable.
 */
export function ConfirmActionPanel({
  action,
  amount,
  paymentAsset,
  pair,
  status,
  errorCode,
  onConfirm,
  onCancel,
}: {
  action: 'subscribe' | 'redeem';
  amount: Money;
  paymentAsset: string;
  pair: PairSummary;
  status: WriteStatus;
  errorCode?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}): React.JSX.Element {
  // Local: once Confirm is clicked the panel shows pending immediately (the parent flips `status`
  // asynchronously as the mutation/poll resolves). A typed `failed` returns the user to Review (retry).
  const [submitted, setSubmitted] = useState(false);

  const title = action === 'subscribe' ? 'Review subscription' : 'Review redemption';
  const confirmLabel = action === 'subscribe' ? 'Confirm subscription' : 'Confirm redemption';

  const isPending =
    status === 'pending' || (submitted && status !== 'failed' && status !== 'confirmed');
  const isConfirmed = status === 'confirmed';
  const isFailed = status === 'failed';

  function handleConfirm(): void {
    setSubmitted(true);
    onConfirm();
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="font-display text-lg font-semibold">{title}</span>
        {isPending && <StatusBadge status="pending" />}
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Amount</dt>
            <dd>
              <MoneyCell money={amount} />
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Payment asset</dt>
            <dd className="font-numeric">{paymentAsset}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Coupled pair</dt>
            <dd className="flex items-center gap-2">
              <span>{pair.referenceAsset}</span>
              <StatusBadge status={pair.state} />
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-sm text-muted-foreground">{CONSEQUENCE[action]}</p>

        {/* The pessimistic write region — announced to SR; never an optimistic success. */}
        <div aria-live="polite" className="mt-4">
          {isPending && <p className="text-sm text-warn">Awaiting Sepolia confirmation…</p>}
          {isConfirmed && (
            <p className="text-sm text-gain">
              ✓ {action === 'subscribe' ? 'Subscription confirmed' : 'Redemption confirmed'}{' '}
              on-chain.
            </p>
          )}
          {isFailed && (
            <p role="alert" className="text-sm text-loss">
              ✗ {action === 'subscribe' ? 'Subscription' : 'Redemption'} refused —{' '}
              {errorCode ?? 'REQUEST_FAILED'}.
            </p>
          )}
        </div>

        {!isConfirmed && (
          <div className="mt-4 flex items-center gap-2">
            <Button variant="primary" onClick={handleConfirm} disabled={isPending}>
              {isFailed ? 'Retry' : confirmLabel}
            </Button>
            {onCancel && (
              <Button variant="ghost" onClick={onCancel} disabled={isPending}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
