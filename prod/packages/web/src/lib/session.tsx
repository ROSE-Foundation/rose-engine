// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MOCK SESSION / IDENTITY LAYER (Story 9.3, FR-30) — CLEARLY-LABELLED DEMO, NOT REAL AUTH.
//
// This replaces the single baked-in `VITE_SUBSCRIBER_ADDRESS` with a selectable session identity so
// distinct participants act in the demo, each with their own per-address positions/eligibility (the
// backend is already per-owner). It is a MOCK session persisted to `localStorage` — there is NO
// password, NO signature, NO real session/ONCHAINID auth (that is deferred, addendum §J FR-30). The
// identity's EVM address is what drives `owner`/`subscriberAddress` everywhere; isolation is enforced
// server-side per address (positions.ts `canonicalOwner`), never in this client.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** A mock-session role: a plain subscriber, or an operator who sees the operator surfaces/tools. */
export type IdentityRole = 'subscriber' | 'operator';

/** The current mock-session identity: an EVM address + a human label + a role. NO credentials. */
export interface Identity {
  /** The EVM address that drives `owner`/`subscriberAddress` (server canonicalises to EIP-55). */
  readonly address: string;
  /** A human-readable display label, e.g. "Alice — LONG holder". */
  readonly label: string;
  /** Gates the operator-only surfaces/tools (Simulation, reconciliation panel, KYC control). */
  readonly role: IdentityRole;
}

// The selectable demo identities. Alice (LONG) + Bob (SHORT) are the two seeded demo holders (see
// `prod/packages/api/src/seed-demo.ts`: PAPER_ELIGIBLE_SUBSCRIBER / _2); Olivia is the operator.
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xcccccccccccccccccccccccccccccccccccccccc';
const OLIVIA_OPERATOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** The built-in selectable demo identities (a custom fresh-participant address may also be entered). */
export const DEMO_IDENTITIES: readonly Identity[] = [
  { address: ALICE, label: 'Alice — LONG holder', role: 'subscriber' },
  { address: BOB, label: 'Bob — SHORT holder', role: 'subscriber' },
  { address: OLIVIA_OPERATOR, label: 'Olivia — Operator', role: 'operator' },
];

/** The `localStorage` key the mock session is persisted under (non-secret). */
const STORAGE_KEY = 'rose.session.identity';

/** EVM-address FORMAT check (`0x` + 40 hex). Full EIP-55 checksum is verified server-side (keccak). */
export function isAddressFormat(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** Truncates an address to the chip form `0xaaaa…aaaa` (first 6 + last 4). */
export function shortAddress(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The mock-session context surface: the current identity + the sign-in / sign-out / switch controls. */
export interface SessionContextValue {
  /** The current identity, or `null` when signed out (fail-closed — never a default address). */
  readonly identity: Identity | null;
  /** The selectable built-in demo identities. */
  readonly identities: readonly Identity[];
  /** Whether the current identity is an operator (gates the operator surfaces/tools). */
  readonly isOperator: boolean;
  /** Sign in as the given identity (a demo identity or a custom fresh participant). */
  signIn(identity: Identity): void;
  /** Sign out — clears the identity (gated surfaces/actions then fail closed). */
  signOut(): void;
  /** Switch to a known demo identity by address (no-op if the address is unknown). */
  switchIdentity(address: string): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Reads + validates the persisted mock identity (SSR-safe; tolerant of malformed storage). */
function readPersistedIdentity(): Identity | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'address' in parsed &&
      'label' in parsed &&
      'role' in parsed
    ) {
      const { address, label, role } = parsed as Record<string, unknown>;
      if (
        typeof address === 'string' &&
        isAddressFormat(address) &&
        typeof label === 'string' &&
        (role === 'subscriber' || role === 'operator')
      ) {
        return { address, label, role };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The mock-session provider. Holds the current identity (persisted to `localStorage`) and exposes
 * sign-in / sign-out / switch. `initialIdentity` is an optional test/seed override; otherwise the
 * persisted identity (or `null` — signed out) is used.
 */
export function SessionProvider({
  children,
  initialIdentity,
}: {
  children: React.ReactNode;
  initialIdentity?: Identity | null;
}): React.JSX.Element {
  const [identity, setIdentity] = useState<Identity | null>(
    () => initialIdentity ?? readPersistedIdentity(),
  );

  // Persist every identity change (and clear on sign-out). Non-secret; mock session only.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (identity === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    }
  }, [identity]);

  const signIn = useCallback((next: Identity): void => {
    setIdentity(next);
  }, []);

  const signOut = useCallback((): void => {
    setIdentity(null);
  }, []);

  const switchIdentity = useCallback((address: string): void => {
    const match = DEMO_IDENTITIES.find((i) => i.address.toLowerCase() === address.toLowerCase());
    if (match) setIdentity(match);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      identity,
      identities: DEMO_IDENTITIES,
      isOperator: identity?.role === 'operator',
      signIn,
      signOut,
      switchIdentity,
    }),
    [identity, signIn, signOut, switchIdentity],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Hook to read the mock session. Throws if used outside a `SessionProvider`. */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
