// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Money } from '../../lib/contract-types.js';
import { ConfirmActionPanel } from './confirm-action-panel.js';

const amount: Money = { asset: 'EUR', scale: 2, smallestUnits: '100000', decimal: '1000.00' };
const pair = { referenceAsset: 'BTC', state: 'ACTIVE' as const };

describe('ConfirmActionPanel (Review→Confirm + pending, UX-DR6)', () => {
  it('Review states the amount (from the decimal string), asset, pair and on-chain consequence', () => {
    render(
      <ConfirmActionPanel
        action="subscribe"
        amount={amount}
        paymentAsset="EUR"
        pair={pair}
        status="idle"
        onConfirm={vi.fn()}
      />,
    );
    // The amount is rendered from the decimal string (never a float).
    expect(screen.getByText('1000.00')).toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    // The on-chain consequence is stated for a subscribe (paired mint).
    expect(screen.getByText(/paired .* mint/i)).toBeInTheDocument();
  });

  it('Confirm fires the mutation and goes pending — NO optimistic success', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmActionPanel
        action="subscribe"
        amount={amount}
        paymentAsset="EUR"
        pair={pair}
        status="idle"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Pending, awaiting the on-chain commit point — no success text shown.
    expect(screen.getByText(/awaiting sepolia confirmation/i)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed/i)).not.toBeInTheDocument();
  });

  it('shows success only once the polled status is confirmed', () => {
    render(
      <ConfirmActionPanel
        action="subscribe"
        amount={amount}
        paymentAsset="EUR"
        pair={pair}
        status="confirmed"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/confirmed/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting sepolia/i)).not.toBeInTheDocument();
  });

  it('names the refusing rule on a typed failure (never a silent success)', () => {
    render(
      <ConfirmActionPanel
        action="subscribe"
        amount={amount}
        paymentAsset="EUR"
        pair={pair}
        status="failed"
        errorCode="AUTHORIZATION_DENIED"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/AUTHORIZATION_DENIED/)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed/i)).not.toBeInTheDocument();
  });

  it('Cancel from Review does not fire the mutation', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmActionPanel
        action="redeem"
        amount={amount}
        paymentAsset="EUR"
        pair={pair}
        status="idle"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    // A redeem states the burn-of-the-whole-package consequence.
    expect(screen.getByText(/burn/i)).toBeInTheDocument();
  });
});
