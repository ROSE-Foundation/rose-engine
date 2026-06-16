// @vitest-environment jsdom
import '../../test/setup.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../../lib/api-client.js';
import type { SubscribeRequest } from '../../lib/contract-types.js';
import { ApiClientProvider } from '../../lib/queries.js';
import {
  activePair,
  confirmedSubscription,
  pendingSubscription,
  subscriberNote,
} from '../../test/fixtures.js';
import { SubscriberSurface } from './subscriber.js';

const ADDRESS = `0x${'a'.repeat(40)}`;

function baseClient(): Partial<ApiClient> {
  return {
    getRoseNote: () => Promise.resolve(subscriberNote()),
    getCoupledPair: () => Promise.resolve(activePair()),
    getGroupView: () => Promise.reject(new Error('unused')),
  };
}

function wrap(client: Partial<ApiClient>, ui: ReactNode): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={client as ApiClient}>{ui}</ApiClientProvider>
    </QueryClientProvider>
  );
}

describe('SubscriberSurface (AC-2, AC-3, AC-4, AC-5)', () => {
  it('shows the empty state when the Subscriber holds no Rose Notes', () => {
    render(
      wrap(
        baseClient(),
        <SubscriberSurface
          eligibility={{ eligible: true }}
          subscriberAddress={ADDRESS}
          noteIds={[]}
        />,
      ),
    );
    expect(screen.getByText(/you hold no rose notes yet/i)).toBeInTheDocument();
  });

  it('opens a position, shows the embedded live pair, and drives subscribe → pending → confirmed', async () => {
    const getSubscription = vi.fn(() => Promise.resolve(confirmedSubscription()));
    const subscribe = vi.fn<
      (
        roseNoteId: string,
        body: SubscribeRequest,
      ) => Promise<ReturnType<typeof pendingSubscription>>
    >(() => Promise.resolve(pendingSubscription()));
    const client: Partial<ApiClient> = { ...baseClient(), subscribe, getSubscription };
    render(
      wrap(
        client,
        <SubscriberSurface
          eligibility={{ eligible: true }}
          subscriberAddress={ADDRESS}
          noteIds={['note-1']}
        />,
      ),
    );
    // Positions → Note detail.
    await userEvent.click(screen.getByRole('button', { name: /note-1/i }));
    // The embedded live pair renders (reuses the Coupled-Pair atom).
    expect(await screen.findByText(/coupled pair · BTC/i)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    // Subscribe → Review→Confirm.
    await userEvent.click(screen.getByRole('button', { name: /^subscribe$/i }));
    expect(screen.getByText(/paired .* mint/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));

    // The write goes through the status endpoint — confirmed only via the poll (no optimistic success).
    expect(await screen.findByText(/confirmed/i)).toBeInTheDocument();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(getSubscription).toHaveBeenCalled();
    // NFR-2: the amount crossed as the smallest-units string.
    expect(subscribe.mock.calls[0]![1]).toMatchObject({ amount: expect.stringMatching(/^\d+$/) });
  });

  it('surfaces a typed 403 eligibility refusal on confirm, naming the rule (no silent success)', async () => {
    const subscribe = vi.fn(() =>
      Promise.reject(new ApiClientError('AUTHORIZATION_DENIED', 'Not eligible.', 403)),
    );
    const client: Partial<ApiClient> = {
      ...baseClient(),
      subscribe,
      getSubscription: () => Promise.resolve(pendingSubscription()),
    };
    render(
      wrap(
        client,
        <SubscriberSurface
          eligibility={{ eligible: true }}
          subscriberAddress={ADDRESS}
          noteIds={['note-1']}
        />,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /note-1/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^subscribe$/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm subscription/i }));
    expect(await screen.findByText(/AUTHORIZATION_DENIED/)).toBeInTheDocument();
    expect(screen.queryByText(/✓.*confirmed/i)).not.toBeInTheDocument();
  });

  it('hides the subscribe path with an explicit reason for an ineligible Subscriber (AC-4)', async () => {
    render(
      wrap(
        baseClient(),
        <SubscriberSurface
          eligibility={{ eligible: false }}
          subscriberAddress={ADDRESS}
          noteIds={['note-1']}
        />,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /note-1/i }));
    await screen.findByText(/coupled pair · BTC/i);
    expect(screen.queryByRole('button', { name: /^subscribe$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/eligibility claim not found/i)).toBeInTheDocument();
  });
});
