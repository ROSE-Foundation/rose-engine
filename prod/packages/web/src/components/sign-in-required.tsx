// The fail-closed "sign in first" gate (Story 9.3, FR-30, AC3). Rendered IN PLACE OF a gated surface
// (Exchange, Subscriber) — or the operator-only Simulation — when there is no/insufficient session.
// It NEVER acts as a default address: no write endpoint is called, no baked-in identity is assumed. It
// reuses the session context to offer inline sign-in buttons so the participant can act immediately.
import { shortAddress, useSession, type Identity } from '../lib/session.js';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';

const PANEL = 'rounded-lg border border-border bg-card';

/**
 * `operatorOnly` ⇒ the surface needs an operator identity (offers only the operator identities to sign
 * in as, and a clear "operator only" message). Otherwise any signed-in identity unlocks the surface.
 */
export function SignInRequired({
  surface,
  operatorOnly = false,
}: {
  surface: string;
  operatorOnly?: boolean;
}): React.JSX.Element {
  const { identities, identity, signIn } = useSession();
  const offered: readonly Identity[] = operatorOnly
    ? identities.filter((i) => i.role === 'operator')
    : identities;

  const message = operatorOnly
    ? identity
      ? `${surface} is an operator surface. Sign in as an operator to continue.`
      : `Sign in as an operator to use ${surface}.`
    : `Sign in first to use ${surface} — the demo never acts as a default user.`;

  return (
    <section
      className={cn(PANEL, 'mx-auto flex max-w-md flex-col gap-3 p-5')}
      aria-label="Sign in required"
    >
      <h2 className="font-display text-base font-semibold">Sign in required</h2>
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
      <div className="flex flex-col gap-2">
        {offered.map((i) => (
          <Button
            key={i.address}
            variant="outline"
            className="w-full justify-start"
            onClick={() => signIn(i)}
          >
            <span className="flex flex-col items-start">
              <span className="font-medium">Sign in as {i.label}</span>
              <span className="font-numeric text-[11px] text-dim">{shortAddress(i.address)}</span>
            </span>
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-dim">
        Or use the identity switcher in the header to enter a custom address.
      </p>
    </section>
  );
}
