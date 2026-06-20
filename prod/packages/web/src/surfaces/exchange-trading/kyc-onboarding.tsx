// Faithful-mode KYC/AML onboarding control (Story 9.2, FR-29). A small, reuse-only affordance on the
// Exchange terminal that makes the default-deny + KYC gate DEMONSTRABLE: it shows the current address's
// onboarding/eligibility state and lets the operator Onboard / Revoke it, so a revoked address is then
// refused (and an onboarded one authorized) on subscribe / position-open. It operates on the app's
// current SESSION identity address (Story 9.3 — replacing the baked-in `VITE_SUBSCRIBER_ADDRESS`) and is
// shown only for an operator identity (the operator-tools role gate). On a non-faithful deployment the
// endpoint returns a typed 503 and the control degrades to an honest "faithful-mode only" note — no new
// design system, no fabricated state.
import { ApiClientError } from '../../lib/api-client.js';
import { cn } from '../../lib/cn.js';
import { useOnboardingState, useSetOnboarding } from '../../lib/queries.js';
import { Button } from '../../components/ui/button.js';

const PANEL = 'rounded-lg border border-border bg-panel';

/** Whether an error is the faithful-only 503 (the control then shows the honest unavailable note). */
function isUnavailable(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'FAITHFUL_ONBOARDING_UNAVAILABLE';
}

/**
 * The onboarding control. `address` is the current session identity (Story 9.3); an empty address
 * renders nothing (no identity to gate). Reads live onboarding state and exposes Onboard/Revoke.
 */
export function KycOnboardingControl({ address }: { address: string }): React.JSX.Element | null {
  const state = useOnboardingState(address);
  const setOnboarding = useSetOnboarding();

  if (address.length === 0) return null;

  // The faithful-only 503: degrade to an honest note (the gate lives only in ENGINE_MODE=faithful).
  if (state.isError && isUnavailable(state.error)) {
    return (
      <section className={cn(PANEL, 'p-3 text-xs text-dim')} aria-label="KYC onboarding">
        <p>
          KYC/AML onboarding is available in <span className="font-medium">faithful</span> mode
          only.
        </p>
      </section>
    );
  }

  const onboarded = state.data?.onboarded ?? false;
  const busy = setOnboarding.isPending || state.isLoading;
  const mutationError =
    setOnboarding.error instanceof ApiClientError ? setOnboarding.error.code : null;

  const apply = (action: 'onboard' | 'revoke'): void => {
    setOnboarding.mutate({ address, action });
  };

  return (
    <section className={cn(PANEL, 'flex flex-col gap-2 p-3')} aria-label="KYC onboarding">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">KYC / AML onboarding</h3>
        <span
          role="status"
          aria-label={`Onboarding: ${onboarded ? 'onboarded' : 'not onboarded'}`}
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
            onboarded ? 'border-gain text-gain' : 'border-warn text-warn',
          )}
        >
          {onboarded ? 'Onboarded' : 'Not onboarded'}
        </span>
      </div>
      <p className="font-numeric text-xs text-dim" title={address}>
        {address}
      </p>
      <p className="text-xs text-dim">
        {onboarded
          ? 'Eligible — subscribe / open is authorized by the default-deny + KYC gate.'
          : 'Default-denied — subscribe / open is refused until onboarding issues an eligibility claim.'}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || onboarded}
          onClick={() => apply('onboard')}
        >
          Onboard
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !onboarded}
          onClick={() => apply('revoke')}
        >
          Revoke
        </Button>
      </div>
      {mutationError && (
        <p role="alert" className="text-xs text-loss">
          Onboarding change failed — {mutationError}.
        </p>
      )}
    </section>
  );
}
