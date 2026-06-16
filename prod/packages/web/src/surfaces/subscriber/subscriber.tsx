import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  ConfirmActionPanel,
  type PairSummary,
  type WriteStatus,
} from '../../components/ui/confirm-action-panel.js';
import { EligibilityGate, type Eligibility } from '../../components/ui/eligibility-gate.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ApiClientError } from '../../lib/api-client.js';
import type { CoupledPairResponse, Money } from '../../lib/contract-types.js';
import {
  useCoupledPair,
  useRedeem,
  useRedemption,
  useRoseNote,
  useSubscribe,
  useSubscription,
} from '../../lib/queries.js';
import { CoupledPairView } from '../coupled-pair/coupled-pair.js';

// Format a smallest-units integer STRING → its exact decimal at `scale` (NFR-2: BigInt-safe string
// math, never a float). The Subscriber's amount crosses the wire as the smallest-units string.
function formatUnits(units: string, scale: number): string {
  const safe = units.length > 0 ? units : '0';
  if (scale === 0) return safe;
  const neg = safe.startsWith('-');
  const digits = (neg ? safe.slice(1) : safe).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// Paper/local demo defaults — the payment asset + scale are EUR (the deployed flow reads them from
// the Note/pair config; that wiring is ops-deferred, see deferred-work.md story-6.6).
const PAYMENT_ASSET = 'EUR';
const PAYMENT_SCALE = 2;

/**
 * The subscribe/redeem write flow (UX-DR6, FR-11). Drives the existing `@rose/api` write endpoints
 * via the mutation + status-poll hooks: on Confirm it fires the mutation, captures the pending handle,
 * and polls the status endpoint until `confirmed` — the panel stays **pending** the whole time (no
 * optimistic success). A typed refusal (403/422/409/503) surfaces its machine `code`.
 */
function WriteFlow({
  action,
  roseNoteId,
  pair,
  subscriberAddress,
  onClose,
}: {
  action: 'subscribe' | 'redeem';
  roseNoteId: string;
  pair: CoupledPairResponse;
  subscriberAddress: string;
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
  const pairSummary: PairSummary = { referenceAsset: pair.referenceAsset, state: pair.state };

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
    // Stable idempotency key per (action, note, amount) — exactly-once (NFR-9).
    const idempotencyKey = `${action}:${roseNoteId}:${amountUnits}`;
    if (action === 'subscribe') {
      subscribeMut.mutate(
        {
          roseNoteId,
          body: {
            subscriber: subscriberAddress,
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
            redeemer: subscriberAddress,
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
            className="w-40 rounded-md border border-border bg-background px-2 py-1 text-right font-numeric tabular-nums"
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
        pair={pairSummary}
        status={writeStatus}
        errorCode={errorCode}
        onConfirm={onConfirm}
        onCancel={onClose}
      />
    </div>
  );
}

/** A single Rose Note position: the live embedded pair (reused Coupled-Pair atom) + the write actions. */
function SubscriberNoteDetail({
  noteId,
  eligibility,
  subscriberAddress,
}: {
  noteId: string;
  eligibility: Eligibility;
  subscriberAddress: string;
}): React.JSX.Element {
  const noteQuery = useRoseNote(noteId);
  const coupledPairId = noteQuery.data?.coupledPairId ?? '';
  const pairQuery = useCoupledPair(coupledPairId);
  const [mode, setMode] = useState<'subscribe' | 'redeem' | null>(null);

  if (noteQuery.isLoading) return <Skeleton className="h-40 w-full" />;
  if (noteQuery.isError) {
    const code =
      noteQuery.error instanceof ApiClientError ? noteQuery.error.code : 'REQUEST_FAILED';
    return (
      <div role="alert" className="rounded-md border border-loss p-4 text-loss">
        <p>Failed to load your position — {code}.</p>
        <button type="button" className="mt-2 underline" onClick={() => void noteQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!noteQuery.data) return <p className="text-muted-foreground">Position not found.</p>;

  return (
    <div className="flex flex-col gap-4">
      {pairQuery.isLoading && <Skeleton className="h-64 w-full" />}
      {pairQuery.isError && (
        <div role="alert" className="rounded-md border border-loss p-4 text-loss">
          Failed to load the embedded pair —{' '}
          {pairQuery.error instanceof ApiClientError ? pairQuery.error.code : 'REQUEST_FAILED'}.
        </div>
      )}
      {pairQuery.data && (
        <>
          <CoupledPairView pair={pairQuery.data} lastUpdated={pairQuery.dataUpdatedAt} />
          {mode ? (
            <WriteFlow
              action={mode}
              roseNoteId={noteId}
              pair={pairQuery.data}
              subscriberAddress={subscriberAddress}
              onClose={() => setMode(null)}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <EligibilityGate eligibility={eligibility}>
                <Button variant="primary" onClick={() => setMode('subscribe')}>
                  Subscribe
                </Button>
              </EligibilityGate>
              <Button variant="outline" onClick={() => setMode('redeem')}>
                Redeem
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The responsive Subscriber surface (AC-2/3/4/5, UX-DR6, UX-DR8): a centered single reading column
 * (`max-w-2xl`), a positions list → Note detail (live position + embedded pair) → subscribe/redeem
 * behind the eligibility gate + the Review→Confirm panel. The held note ids, eligibility and the
 * subscriber address are injected (paper/local; the deployed session-auth source is ops-deferred).
 */
export function SubscriberSurface({
  eligibility,
  subscriberAddress,
  noteIds,
}: {
  eligibility: Eligibility;
  subscriberAddress: string;
  noteIds: string[];
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-2">
      <h1 className="font-display text-xl font-semibold">Your Rose Notes</h1>
      {selected === null ? (
        noteIds.length === 0 ? (
          <p className="text-muted-foreground">You hold no Rose Notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {noteIds.map((id) => (
              <li key={id}>
                <Button
                  variant="outline"
                  className="w-full justify-start font-numeric"
                  onClick={() => setSelected(id)}
                >
                  {id}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" className="self-start" onClick={() => setSelected(null)}>
            ← Positions
          </Button>
          <SubscriberNoteDetail
            noteId={selected}
            eligibility={eligibility}
            subscriberAddress={subscriberAddress}
          />
        </div>
      )}
    </div>
  );
}
