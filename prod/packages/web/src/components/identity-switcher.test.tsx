// @vitest-environment jsdom
import '../test/setup.js';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_IDENTITIES, SessionProvider, type Identity } from '../lib/session.js';
import { IdentitySwitcher } from './identity-switcher.js';

const ALICE = DEMO_IDENTITIES[0]!;
const BOB = DEMO_IDENTITIES[1]!;

function renderSwitcher(initialIdentity?: Identity | null): void {
  render(
    <SessionProvider initialIdentity={initialIdentity}>
      <IdentitySwitcher />
    </SessionProvider>,
  );
}

describe('IdentitySwitcher (Story 9.3, FR-30)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('shows a "Sign in" affordance when signed out', () => {
    renderSwitcher();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('renders the current-identity chip (label + truncated address)', () => {
    renderSwitcher(ALICE);
    expect(screen.getByText(`Signed in as ${ALICE.label}`)).toBeInTheDocument();
    expect(screen.getByText('(0xaaaa…aaaa)')).toBeInTheDocument();
  });

  it('switches the active identity from the menu', async () => {
    renderSwitcher(ALICE);
    await userEvent.click(screen.getByRole('button', { name: /Signed in as/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: new RegExp(BOB.label) }));
    expect(screen.getByText(`Signed in as ${BOB.label}`)).toBeInTheDocument();
  });

  it('signs in a custom fresh participant by EVM address', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const custom = `0x${'d'.repeat(40)}`;
    await userEvent.type(screen.getByLabelText('EVM address'), custom);
    await userEvent.click(screen.getByRole('button', { name: /Sign in as custom/ }));
    expect(screen.getByText('(0xdddd…dddd)')).toBeInTheDocument();
  });

  it('signs out from the menu', async () => {
    renderSwitcher(ALICE);
    await userEvent.click(screen.getByRole('button', { name: /Signed in as/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });
});
