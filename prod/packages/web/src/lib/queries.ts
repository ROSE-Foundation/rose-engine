import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { ApiClient } from './api-client.js';
import type {
  CoupledPairResponse,
  GroupViewResponse,
  PositionsResponse,
  RedeemRequest,
  RedemptionResponse,
  RoseNoteResponse,
  SubscribeRequest,
  SubscriptionResponse,
} from './contract-types.js';

const ApiClientContext = createContext<ApiClient | null>(null);

/** Provides the injected `ApiClient` to the live-data hooks (tests inject a fixture-backed client). */
export const ApiClientProvider = ApiClientContext.Provider;

function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient must be used within an ApiClientProvider');
  return client;
}

/** The short live-data refresh window (drives the `LiveIndicator` freshness). */
export const REFRESH_WINDOW_MS = 5000;

/** Live consolidated group view (FR-9). Polls within the refresh window. */
export function useGroupView(): UseQueryResult<GroupViewResponse, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['group-view'],
    queryFn: () => client.getGroupView(),
    refetchInterval: REFRESH_WINDOW_MS,
  });
}

/** Live coupled-pair state (FR-6) for the given pair id. */
export function useCoupledPair(id: string): UseQueryResult<CoupledPairResponse, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['coupled-pair', id],
    queryFn: () => client.getCoupledPair(id),
    refetchInterval: REFRESH_WINDOW_MS,
    enabled: id.length > 0,
  });
}

/** Live per-user positions + marks/P&L for the Exchange terminal (FR-26). Polls the refresh window. */
export function usePositions(
  owner: string,
  opts?: { referenceAsset?: string },
): UseQueryResult<PositionsResponse, Error> {
  const client = useApiClient();
  const referenceAsset = opts?.referenceAsset;
  return useQuery({
    queryKey: ['positions', owner, referenceAsset ?? null],
    queryFn: () =>
      client.getPositions(owner, referenceAsset !== undefined ? { referenceAsset } : undefined),
    refetchInterval: REFRESH_WINDOW_MS,
    enabled: owner.length > 0,
  });
}

/** The subscriber's Rose Note position handle (FR-11). */
export function useRoseNote(id: string): UseQueryResult<RoseNoteResponse, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['rose-note', id],
    queryFn: () => client.getRoseNote(id),
    refetchInterval: REFRESH_WINDOW_MS,
    enabled: id.length > 0,
  });
}

/** Subscribe mutation (FR-11, UX-DR6) — the write the Review→Confirm panel fires. */
export function useSubscribe(): UseMutationResult<
  SubscriptionResponse,
  Error,
  { roseNoteId: string; body: SubscribeRequest }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: ({ roseNoteId, body }) => client.subscribe(roseNoteId, body),
  });
}

/** Redeem mutation (FR-11, UX-DR6) — the inverse of subscribe. */
export function useRedeem(): UseMutationResult<
  RedemptionResponse,
  Error,
  { roseNoteId: string; body: RedeemRequest }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: ({ roseNoteId, body }) => client.redeem(roseNoteId, body),
  });
}

// Poll the status endpoint ONLY while the handle is `pending` — the pessimistic confirm driver
// (UX-DR6, NFR-9): keep refetching until the on-chain commit point flips it to confirmed/failed.
function pollWhilePending(status: 'pending' | 'confirmed' | 'failed' | undefined): number | false {
  return status === 'pending' ? REFRESH_WINDOW_MS : false;
}

/** Poll a subscription status (pending → confirmed). Stops polling once resolved. */
export function useSubscription(id: string): UseQueryResult<SubscriptionResponse, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['subscription', id],
    queryFn: () => client.getSubscription(id),
    enabled: id.length > 0,
    refetchInterval: (query) => pollWhilePending(query.state.data?.status),
  });
}

/** Poll a redemption status (pending → confirmed). Stops polling once resolved. */
export function useRedemption(id: string): UseQueryResult<RedemptionResponse, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['redemption', id],
    queryFn: () => client.getRedemption(id),
    enabled: id.length > 0,
    refetchInterval: (query) => pollWhilePending(query.state.data?.status),
  });
}
