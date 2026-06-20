// The always-visible mock-session identity chip + switcher (Story 9.3, FR-30). When signed in it shows
// "Signed in as {label} ({0xaaaa…})" with a menu to switch demo identities, sign in a custom fresh
// participant, or sign out. When signed out it shows a "Sign in" affordance. Reuses the existing Button
// — no new design system. This is a CLEARLY-LABELLED mock session (no real auth; see session.tsx).
import { useState } from 'react';
import { isAddressFormat, shortAddress, useSession, type Identity } from '../lib/session.js';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';

const PANEL = 'rounded-lg border border-border bg-card shadow-lg';

/** The drop-down body: pick a demo identity, enter a custom address, or sign out. */
function IdentityMenu({
  identities,
  current,
  onPick,
  onCustom,
  onSignOut,
}: {
  identities: readonly Identity[];
  current: Identity | null;
  onPick: (identity: Identity) => void;
  onCustom: (address: string, label: string) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const trimmed = address.trim();
  const valid = isAddressFormat(trimmed);

  return (
    <div
      className={cn(PANEL, 'absolute right-0 top-full z-20 mt-2 w-72 p-3')}
      role="menu"
      aria-label="Switch identity"
    >
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-dim">
        Demo identities
      </p>
      <ul className="flex flex-col gap-1">
        {identities.map((i) => {
          const active = current?.address.toLowerCase() === i.address.toLowerCase();
          return (
            <li key={i.address}>
              <button
                type="button"
                role="menuitem"
                onClick={() => onPick(i)}
                aria-current={active}
                className={cn(
                  'flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-elevated',
                  active && 'bg-elevated',
                )}
              >
                <span className="font-medium">
                  {i.label}
                  {i.role === 'operator' && (
                    <span className="ml-1 rounded-sm border border-gold/40 px-1 text-[10px] uppercase text-gold">
                      operator
                    </span>
                  )}
                </span>
                <span className="font-numeric text-[11px] text-dim">{shortAddress(i.address)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dim">
          Custom participant
        </p>
        <label className="sr-only" htmlFor="custom-identity-label">
          Display label
        </label>
        <input
          id="custom-identity-label"
          className="mb-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <label className="sr-only" htmlFor="custom-identity-address">
          EVM address
        </label>
        <input
          id="custom-identity-address"
          className="w-full rounded-md border border-border bg-background px-2 py-1 font-numeric text-sm"
          placeholder="0x… (EVM address)"
          value={address}
          aria-invalid={trimmed.length > 0 && !valid}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          disabled={!valid}
          onClick={() => onCustom(trimmed, label.trim())}
        >
          Sign in as custom
        </Button>
        {trimmed.length > 0 && !valid && (
          <p role="alert" className="mt-1 text-[11px] text-loss">
            Enter a valid EVM address (0x + 40 hex).
          </p>
        )}
      </div>

      {current && (
        <div className="mt-3 border-t border-border pt-3">
          <Button size="sm" variant="ghost" className="w-full" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
}

/** The header identity chip + switcher. Always visible — the current identity is never hidden. */
export function IdentitySwitcher(): React.JSX.Element {
  const { identity, identities, signIn, signOut } = useSession();
  const [open, setOpen] = useState(false);

  const pick = (next: Identity): void => {
    signIn(next);
    setOpen(false);
  };
  const custom = (address: string, label: string): void => {
    signIn({
      address,
      label: label.length > 0 ? label : shortAddress(address),
      role: 'subscriber',
    });
    setOpen(false);
  };
  const out = (): void => {
    signOut();
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-elevated',
        )}
      >
        {identity ? (
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                identity.role === 'operator' ? 'bg-gold' : 'bg-gain',
              )}
            />
            <span className="font-medium">Signed in as {identity.label}</span>
            <span className="font-numeric text-[11px] text-dim">
              ({shortAddress(identity.address)})
            </span>
          </span>
        ) : (
          <span className="text-dim">Sign in</span>
        )}
        <span aria-hidden className="text-dim">
          ▾
        </span>
      </button>
      {open && (
        <IdentityMenu
          identities={identities}
          current={identity}
          onPick={pick}
          onCustom={custom}
          onSignOut={out}
        />
      )}
    </div>
  );
}
