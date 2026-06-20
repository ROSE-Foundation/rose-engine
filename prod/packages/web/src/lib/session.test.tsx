// @vitest-environment jsdom
import '../test/setup.js';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_IDENTITIES,
  SessionProvider,
  isAddressFormat,
  shortAddress,
  useSession,
  type Identity,
} from './session.js';

const ALICE = DEMO_IDENTITIES[0]!;
const OLIVIA = DEMO_IDENTITIES.find((i) => i.role === 'operator')!;
const STORAGE_KEY = 'rose.session.identity';

/** A probe that surfaces the session state + buttons that drive sign-in/out/switch. */
function Probe(): React.JSX.Element {
  const { identity, isOperator, signIn, signOut, switchIdentity } = useSession();
  return (
    <div>
      <p data-testid="who">{identity ? `${identity.label}|${identity.address}` : 'signed-out'}</p>
      <p data-testid="operator">{String(isOperator)}</p>
      <button type="button" onClick={() => signIn(ALICE)}>
        in-alice
      </button>
      <button type="button" onClick={() => switchIdentity(OLIVIA.address)}>
        switch-olivia
      </button>
      <button type="button" onClick={signOut}>
        out
      </button>
    </div>
  );
}

function renderProbe(initialIdentity?: Identity | null): void {
  render(
    <SessionProvider initialIdentity={initialIdentity}>
      <Probe />
    </SessionProvider>,
  );
}

describe('session helpers', () => {
  it('validates EVM address format (0x + 40 hex)', () => {
    expect(isAddressFormat(ALICE.address)).toBe(true);
    expect(isAddressFormat('0x1234')).toBe(false);
    expect(isAddressFormat('not-an-address')).toBe(false);
  });

  it('truncates an address to the chip form', () => {
    expect(shortAddress(ALICE.address)).toBe('0xaaaa…aaaa');
  });
});

describe('SessionProvider (Story 9.3, FR-30)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('starts signed out (fail-closed — never a default identity)', () => {
    renderProbe();
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('operator')).toHaveTextContent('false');
  });

  it('signs in, switches identity, and signs out — persisting to localStorage', async () => {
    renderProbe();

    await userEvent.click(screen.getByRole('button', { name: 'in-alice' }));
    expect(screen.getByTestId('who')).toHaveTextContent(ALICE.address);
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(ALICE.address);

    await userEvent.click(screen.getByRole('button', { name: 'switch-olivia' }));
    expect(screen.getByTestId('who')).toHaveTextContent(OLIVIA.address);
    expect(screen.getByTestId('operator')).toHaveTextContent('true');

    await userEvent.click(screen.getByRole('button', { name: 'out' }));
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('rehydrates the persisted identity on mount', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ALICE));
    renderProbe();
    expect(screen.getByTestId('who')).toHaveTextContent(ALICE.address);
  });

  it('ignores malformed persisted state (fail-closed to signed-out)', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    renderProbe();
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
  });
});
