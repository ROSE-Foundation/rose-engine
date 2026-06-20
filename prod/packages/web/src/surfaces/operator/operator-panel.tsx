// Operator control panel (Story 9.5, FR-32) — faithful-mode, operator-role-gated. Injects three
// production-like events on demand so prod-state handling is demonstrable LIVE:
//   1. Confirmation latency / failure — tunes the Story-9.1 async-confirmation transport (latency,
//      failure rate, a "fail next" one-shot) so the next flow exhibits the delayed-commit /
//      compensated-failure behaviour.
//   2. Covenant breach — forces a GENUINE BREACH on the real Treasury covenant monitor (and clears).
//   3. Reconcile divergence — arms a real position↔pair divergence the NEXT reconcile reports-and-
//      corrects through the Story-8.5 path (journaled), then clears.
// Each control READS its current state, calls the faithful-gated endpoint, and degrades CLEANLY to a
// "not available on this deployment (faithful mode only)" note on the typed 503. No new design system —
// reuses the existing Button + panel styles (mirrors the Simulation surface).
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ApiClientError } from '../../lib/api-client.js';
import { cn } from '../../lib/cn.js';
import type {
  FaithfulConfirmationSettingsView,
  OperatorInjectionState,
} from '../../lib/contract-types.js';
import {
  useConfirmationSettings,
  useCovenantBreach,
  useReconcileDivergence,
  useSetCovenantBreach,
  useSetReconcileDivergence,
  useUpdateConfirmationSettings,
} from '../../lib/queries.js';
import type { UseQueryResult } from '@tanstack/react-query';

const PANEL = 'rounded-lg border border-border bg-card';

/** A 503 from the faithful gate ⇒ the control is not available on this deployment. */
function unavailableOf(err: unknown): string | null {
  return err instanceof ApiClientError && err.status === 503 ? err.code : null;
}

/** The shared "not available on this deployment (faithful only)" note for a 503-gated control. */
function UnavailableNote({ code }: { code: string }): React.JSX.Element {
  return (
    <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
      Not available on this deployment — operator injections require faithful mode ({code}).
    </p>
  );
}

/** A small section wrapper with a title + description + body. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={cn(PANEL, 'p-4')}>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-base font-semibold">{title}</h2>
        <p className="text-xs text-dim">{description}</p>
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

// ─── 1. Confirmation latency / failure injection ──────────────────────────────────────────────────
function ConfirmationInjection({
  view,
}: {
  view: FaithfulConfirmationSettingsView;
}): React.JSX.Element {
  const { bounds } = view;
  const [latencyMs, setLatencyMs] = useState(view.latencyMs);
  const [failureRate, setFailureRate] = useState(view.failureRate);
  const [failNext, setFailNext] = useState(view.failNext);
  const update = useUpdateConfirmationSettings();

  const err = update.error;
  const unavailable = unavailableOf(err);
  const errorCode = err instanceof ApiClientError ? err.code : 'REQUEST_FAILED';
  const errorMessage = err instanceof ApiClientError ? err.message : 'The update failed.';
  const appliedVersion = update.data?.version;

  function onApply(): void {
    update.mutate({ latencyMs, failureRate, failNext });
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="op-latency" className="text-sm font-medium">
            Confirmation latency (ms)
          </label>
          <span className="font-numeric text-sm tabular-nums text-dim">{latencyMs}ms</span>
        </div>
        <input
          id="op-latency"
          type="number"
          className="w-32 rounded-md border border-border bg-background px-2 py-1 text-right font-numeric tabular-nums"
          min={bounds.latencyMsMin}
          max={bounds.latencyMsMax}
          step={100}
          value={latencyMs}
          aria-label="Confirmation latency"
          onChange={(e) => setLatencyMs(Number(e.target.value))}
        />
        <p className="text-[11px] text-dim">
          The realistic delay before the on-chain commit point fires (range {bounds.latencyMsMin}–
          {bounds.latencyMsMax}ms).
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="op-failure-rate" className="text-sm font-medium">
            Failure rate
          </label>
          <span className="font-numeric text-sm tabular-nums text-dim">{failureRate}</span>
        </div>
        <input
          id="op-failure-rate"
          type="number"
          className="w-32 rounded-md border border-border bg-background px-2 py-1 text-right font-numeric tabular-nums"
          min={bounds.failureRateMin}
          max={bounds.failureRateMax}
          step={0.05}
          value={failureRate}
          aria-label="Failure rate"
          onChange={(e) => setFailureRate(Number(e.target.value))}
        />
        <p className="text-[11px] text-dim">
          Fraction of flows the watcher reports FAILED → saga compensation (range{' '}
          {bounds.failureRateMin}–{bounds.failureRateMax}).
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={failNext}
          aria-label="Fail the next flow"
          onChange={(e) => setFailNext(e.target.checked)}
        />
        Fail the next flow (one-shot)
      </label>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={onApply} disabled={update.isPending}>
          {update.isPending ? 'Applying…' : 'Apply'}
        </Button>
        <span className="text-xs text-dim">Current version {view.version}</span>
      </div>

      <div aria-live="polite">
        {update.isSuccess && appliedVersion !== undefined && (
          <p className="text-sm text-gain">✓ Applied — version {appliedVersion}.</p>
        )}
        {unavailable && <UnavailableNote code={unavailable} />}
        {err && !unavailable && (
          <p role="alert" className="text-sm text-loss">
            ✗ {errorMessage} ({errorCode})
          </p>
        )}
      </div>
    </>
  );
}

// ─── A reusable arm/clear toggle (covenant breach + reconcile divergence share the shape) ─────────
function InjectionToggle({
  query,
  onSet,
  isPending,
  error,
  armLabel,
  clearLabel,
  activeNote,
}: {
  query: UseQueryResult<OperatorInjectionState, Error>;
  onSet: (active: boolean) => void;
  isPending: boolean;
  error: unknown;
  armLabel: string;
  clearLabel: string;
  activeNote: string;
}): React.JSX.Element {
  const unavailable = unavailableOf(query.error) ?? unavailableOf(error);
  if (query.isLoading) return <Skeleton className="h-10 w-full" />;
  if (unavailable) return <UnavailableNote code={unavailable} />;

  const active = query.data?.active ?? false;
  const errorCode = error instanceof ApiClientError ? error.code : 'REQUEST_FAILED';
  const errorMessage = error instanceof ApiClientError ? error.message : 'The update failed.';

  return (
    <>
      <div className="flex items-center gap-3">
        <Button
          variant={active ? 'outline' : 'primary'}
          onClick={() => onSet(!active)}
          disabled={isPending}
        >
          {isPending ? 'Applying…' : active ? clearLabel : armLabel}
        </Button>
        <span
          className={cn('text-sm font-medium', active ? 'text-warn' : 'text-dim')}
          aria-label="injection-status"
        >
          {active ? 'ACTIVE' : 'cleared'}
        </span>
      </div>
      {active && (
        <p role="status" className="text-[11px] text-warn">
          {activeNote}
        </p>
      )}
      {error && !unavailableOf(error) && (
        <p role="alert" className="text-sm text-loss">
          ✗ {errorMessage} ({errorCode})
        </p>
      )}
    </>
  );
}

/**
 * The operator control panel surface (faithful-mode only). Reads the three injection states and
 * exposes the arm/clear controls. Each control degrades cleanly to a "faithful mode only" note on a
 * typed 503. Operator-role-gating lives in `app.tsx` (the surface is only routed for `isOperator`).
 */
export function OperatorPanel(): React.JSX.Element {
  const confirmation = useConfirmationSettings();
  const covenant = useCovenantBreach();
  const reconcile = useReconcileDivergence();
  const setCovenant = useSetCovenantBreach();
  const setReconcile = useSetReconcileDivergence();

  const confirmationUnavailable = unavailableOf(confirmation.error);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-lg font-semibold">Operator · production-like events</h1>
        <p className="text-sm text-muted-foreground">
          Inject the three faithful-mode events on demand (FR-32): confirmation latency / failure, a
          covenant breach, and a position↔pair reconciliation divergence. Operator-only.
        </p>
      </header>

      <Section
        title="Confirmation latency / failure"
        description="Tune the async-confirmation transport so the next flow shows the delayed-commit / compensated-failure behaviour (Story 9.1)."
      >
        {confirmation.isLoading && <Skeleton className="h-48 w-full" />}
        {confirmationUnavailable && <UnavailableNote code={confirmationUnavailable} />}
        {confirmation.data && <ConfirmationInjection view={confirmation.data} />}
      </Section>

      <Section
        title="Covenant breach"
        description="Force a GENUINE BREACH on the Treasury covenant monitor (the real computation path), then clear it."
      >
        <InjectionToggle
          query={covenant}
          onSet={(active) => setCovenant.mutate({ active })}
          isPending={setCovenant.isPending}
          error={setCovenant.error}
          armLabel="Force covenant breach"
          clearLabel="Clear covenant breach"
          activeNote="A BREACH covenant row is showing on the Treasury Dashboard until cleared."
        />
      </Section>

      <Section
        title="Reconcile divergence"
        description="Arm a real position↔pair divergence the NEXT reconciliation reports-and-corrects (journaled, Story 8.5), then clear it."
      >
        <InjectionToggle
          query={reconcile}
          onSet={(active) => setReconcile.mutate({ active })}
          isPending={setReconcile.isPending}
          error={setReconcile.error}
          armLabel="Arm reconcile divergence"
          clearLabel="Clear reconcile divergence"
          activeNote="The next reconciliation run will report-and-correct an injected divergence."
        />
      </Section>
    </div>
  );
}
