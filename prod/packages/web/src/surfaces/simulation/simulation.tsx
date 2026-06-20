import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ApiClientError } from '../../lib/api-client.js';
import { cn } from '../../lib/cn.js';
import type { SimulationSettingsView } from '../../lib/contract-types.js';
import { useSimulationSettings, useUpdateSimulationSettings } from '../../lib/queries.js';

const PANEL = 'rounded-lg border border-border bg-card';

// The demo pairs run at leverage 3× (§15 oracle integrity): an amplitude whose 3× swing reaches the
// unit interval pushes the mark into the DIVERGENT state (|L·r| ≥ 1). Surfaced (not blocked) as an
// informational hint so the divergence behaviour can be demonstrated on purpose.
const DEMO_LEVERAGE = 3;

/** Format a raw fraction as a percentage for readability (0.07 → "7%"); the raw fraction is submitted. */
function asPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

/**
 * The editable settings form (Story: Simulation tab). Reads the current view, lets the operator tune
 * the replay-feed amplitude (a fractional price swing) + cycle period, and Applies the patch via
 * `PUT /simulation/settings`. While the write is pending the Apply button is disabled; on success a
 * brief "Applied — version N" confirmation shows; a typed 400 (out-of-range, names the field) / 503
 * (non-paper) surfaces its boundary message. A DIVERGENT hint shows when amplitude × 3 ≥ 1 — NOT
 * blocked, so the divergence behaviour can be demonstrated. amplitude/periodSeconds are plain numbers.
 */
function SimulationSettingsForm({ view }: { view: SimulationSettingsView }): React.JSX.Element {
  const { bounds } = view;
  const [amplitude, setAmplitude] = useState(view.amplitude);
  const [periodSeconds, setPeriodSeconds] = useState(view.periodSeconds);
  const update = useUpdateSimulationSettings();

  const divergent = amplitude * DEMO_LEVERAGE >= 1;
  const err = update.error;
  const unavailable = err instanceof ApiClientError && err.status === 503;
  const errorCode = err instanceof ApiClientError ? err.code : 'REQUEST_FAILED';
  const errorMessage = err instanceof ApiClientError ? err.message : 'The update failed.';
  // The freshly-applied version (the mutation result), shown as the confirmation.
  const appliedVersion = update.data?.version;

  function onApply(): void {
    update.mutate({ amplitude, periodSeconds });
  }

  return (
    <section className={cn(PANEL, 'p-4')}>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-base font-semibold">Replay-feed parameters</h2>
        <p className="text-xs text-dim">
          These shape the paper-mode price feed that drives the live marks + P&amp;L across the
          terminal. Changes take effect immediately — no redeploy.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-5">
        {/* Amplitude — a fractional price swing around each pair's anchor (0 = flat feed). */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="sim-amplitude" className="text-sm font-medium">
              Amplitude
            </label>
            <span className="font-numeric text-sm tabular-nums text-dim">
              {amplitude} <span className="text-[11px]">({asPercent(amplitude)})</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="sim-amplitude"
              type="range"
              className="min-w-0 flex-1"
              min={bounds.amplitudeMin}
              max={bounds.amplitudeMax}
              step={0.01}
              value={amplitude}
              aria-label="Amplitude"
              onChange={(e) => setAmplitude(Number(e.target.value))}
            />
            <input
              type="number"
              className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right font-numeric tabular-nums"
              min={bounds.amplitudeMin}
              max={bounds.amplitudeMax}
              step={0.01}
              value={amplitude}
              aria-label="Amplitude value"
              onChange={(e) => setAmplitude(Number(e.target.value))}
            />
          </div>
          <p className="text-[11px] text-dim">
            The fractional price swing around each pair&apos;s anchor (range {bounds.amplitudeMin}–
            {bounds.amplitudeMax}). 0 is a flat feed.
          </p>
          {divergent && (
            <p
              role="status"
              className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn"
            >
              At this amplitude the 3× pairs will show a DIVERGENT mark (flagged, not trusted — §15
              oracle integrity).
            </p>
          )}
        </div>

        {/* Period — the full oscillation cycle in seconds. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="sim-period" className="text-sm font-medium">
              Cycle period (seconds)
            </label>
            <span className="font-numeric text-sm tabular-nums text-dim">{periodSeconds}s</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="sim-period"
              type="range"
              className="min-w-0 flex-1"
              min={bounds.periodSecondsMin}
              max={bounds.periodSecondsMax}
              step={1}
              value={periodSeconds}
              aria-label="Cycle period"
              onChange={(e) => setPeriodSeconds(Number(e.target.value))}
            />
            <input
              type="number"
              className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right font-numeric tabular-nums"
              min={bounds.periodSecondsMin}
              max={bounds.periodSecondsMax}
              step={1}
              value={periodSeconds}
              aria-label="Cycle period value"
              onChange={(e) => setPeriodSeconds(Number(e.target.value))}
            />
          </div>
          <p className="text-[11px] text-dim">
            The full oscillation cycle (range {bounds.periodSecondsMin}–{bounds.periodSecondsMax}s).
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" onClick={onApply} disabled={update.isPending}>
          {update.isPending ? 'Applying…' : 'Apply'}
        </Button>
        <span className="text-xs text-dim">Current version {view.version}</span>
      </div>

      <div aria-live="polite" className="mt-3">
        {update.isSuccess && appliedVersion !== undefined && (
          <p className="text-sm text-gain">✓ Applied — version {appliedVersion}.</p>
        )}
        {unavailable && (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            Simulation settings are not available on this deployment (paper mode only) — {errorCode}
            .
          </p>
        )}
        {err && !unavailable && (
          <p role="alert" className="text-sm text-loss">
            ✗ {errorMessage} ({errorCode})
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Simulation surface (paper-mode only): a settings screen that READS and tunes the LIVE replay-feed
 * parameters (oscillation amplitude + cycle period) that drive the demo's price dynamics. On a
 * non-paper deployment the read refuses with a typed 503 `SIMULATION_SETTINGS_UNAVAILABLE` and the
 * surface degrades to a clean "not available on this deployment" state. Loading/error live here in the
 * container; the editable form is rendered only once the current settings are loaded. No new design
 * system — reuses the existing Button + panel styles.
 */
export function SimulationSurface(): React.JSX.Element {
  const query = useSimulationSettings();
  const err = query.error;
  const unavailable = err instanceof ApiClientError && err.status === 503;
  const code = err instanceof ApiClientError ? err.code : 'REQUEST_FAILED';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-lg font-semibold">Simulation · live replay feed</h1>
        <p className="text-sm text-muted-foreground">
          Tune the paper-mode price feed that drives the live marks + P&amp;L. Changes apply
          immediately — no redeploy.
        </p>
      </header>

      {query.isLoading && <Skeleton className="h-64 w-full" />}

      {unavailable && (
        <section className={cn(PANEL, 'p-4')}>
          <p className="text-sm text-muted-foreground">
            Simulation settings are not available on this deployment (paper mode only).
          </p>
          <p className="mt-1 text-xs text-dim">{code}</p>
        </section>
      )}

      {err && !unavailable && (
        <div role="alert" className="rounded-md border border-loss p-4 text-loss">
          <p>Failed to load simulation settings — {code}.</p>
          <button type="button" className="mt-2 underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </div>
      )}

      {query.data && <SimulationSettingsForm view={query.data} />}
    </div>
  );
}
