import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { ApiClient } from './api-client.js';
import type {
  ClosePositionRequest,
  ClosePositionView,
  CoupledPairResponse,
  GroupViewResponse,
  OnboardingRequest,
  OnboardingState,
  OpenPositionRequest,
  OpenPositionView,
  PositionReconciliationReport,
  PositionsResponse,
  RedeemRequest,
  RedemptionResponse,
  RoseNoteResponse,
  SimulationSettingsUpdate,
  SimulationSettingsView,
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

// ─── Position open/close + operator reconcile (Stories 8.3/8.5/8.6, FR-25/FR-27) ────────────────

/**
 * Open-position mutation (FR-25, UX-DR6) — the Exchange-terminal Open fires this. It returns the
 * `pending` flow handle (no optimistic success); the caller polls `useOpenPositionFlow` until the
 * on-chain commit point flips it to `confirmed`. A 409/503 surfaces as a typed `ApiClientError`.
 */
export function useOpenPosition(): UseMutationResult<OpenPositionView, Error, OpenPositionRequest> {
  const client = useApiClient();
  return useMutation({ mutationFn: (body) => client.openPosition(body) });
}

/**
 * Close-position mutation (FR-25, Story 8.6) — fired per position row. A D1 single-side close is
 * refused with a typed 409 `SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` the surface NAMES (UX-DR5).
 */
export function useClosePosition(): UseMutationResult<
  ClosePositionView,
  Error,
  ClosePositionRequest
> {
  const client = useApiClient();
  return useMutation({ mutationFn: (body) => client.closePosition(body) });
}

/**
 * Poll a position-open flow (pending → confirmed). Once it reads `confirmed`, the live positions
 * listing is invalidated so the new position appears with its mark/P&L. Stops polling once resolved.
 */
export function useOpenPositionFlow(id: string): UseQueryResult<OpenPositionView, Error> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['position-open-flow', id],
    queryFn: async () => {
      const view = await client.getOpenPositionFlow(id);
      if (view.status === 'confirmed') {
        await queryClient.invalidateQueries({ queryKey: ['positions'] });
      }
      return view;
    },
    enabled: id.length > 0,
    refetchInterval: (query) => pollWhilePending(query.state.data?.status),
  });
}

/**
 * Poll a position-close flow (pending → confirmed). Once confirmed, the live positions listing is
 * invalidated so the closed position drops out / re-reads its lifecycle. Stops polling once resolved.
 */
export function useClosePositionFlow(id: string): UseQueryResult<ClosePositionView, Error> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['position-close-flow', id],
    queryFn: async () => {
      const view = await client.getClosePositionFlow(id);
      if (view.status === 'confirmed') {
        await queryClient.invalidateQueries({ queryKey: ['positions'] });
      }
      return view;
    },
    enabled: id.length > 0,
    refetchInterval: (query) => pollWhilePending(query.state.data?.status),
  });
}

/** Operator position↔pair reconciliation (FR-27) — fired on demand from the operator panel. */
export function useReconcilePositions(): UseMutationResult<
  PositionReconciliationReport,
  Error,
  void
> {
  const client = useApiClient();
  return useMutation({ mutationFn: () => client.reconcilePositions() });
}

// ─── Simulation settings (paper-mode replay-feed parameters) ─────────────────────────────────────

/** Live paper-mode replay-feed parameters (amplitude + cycle period + bounds + version). A non-paper
 * deployment surfaces a typed 503 `SIMULATION_SETTINGS_UNAVAILABLE` the Simulation screen NAMES. */
export function useSimulationSettings(): UseQueryResult<SimulationSettingsView, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['simulation-settings'],
    queryFn: () => client.getSimulationSettings(),
  });
}

/**
 * Tune the replay-feed parameters (any subset). On success the settings AND the live positions are
 * invalidated so the terminal's marks/P&L re-read against the rebuilt price series. A 400
 * (out-of-range) / 503 (non-paper) surfaces as a typed `ApiClientError` the screen NAMES (UX-DR5).
 */
export function useUpdateSimulationSettings(): UseMutationResult<
  SimulationSettingsView,
  Error,
  SimulationSettingsUpdate
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch) => client.updateSimulationSettings(patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['simulation-settings'] }),
        queryClient.invalidateQueries({ queryKey: ['positions'] }),
      ]);
    },
  });
}

// ─── Faithful KYC/AML onboarding (Story 9.2, FR-29) ──────────────────────────────────────────────

/**
 * Live KYC/AML onboarding state for an address (faithful mode). A non-faithful deployment surfaces a
 * typed 503 `FAITHFUL_ONBOARDING_UNAVAILABLE` the control NAMES (shows a "faithful-mode only" note).
 * Disabled when no address is wired (e.g. an empty `VITE_SUBSCRIBER_ADDRESS`).
 */
export function useOnboardingState(address: string): UseQueryResult<OnboardingState, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['onboarding', address],
    queryFn: () => client.getOnboardingState(address),
    enabled: address.length > 0,
    retry: false,
  });
}

/**
 * Onboard / revoke an address in the faithful-mode mock KYC/AML registry. On success the address's
 * onboarding state AND the live positions (eligibility-dependent) are invalidated. A 400/503 surfaces
 * as a typed `ApiClientError` the control NAMES (UX-DR5).
 */
export function useSetOnboarding(): UseMutationResult<OnboardingState, Error, OnboardingRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => client.setOnboarding(body),
    onSuccess: async (state) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['onboarding', state.address] }),
        queryClient.invalidateQueries({ queryKey: ['positions'] }),
      ]);
    },
  });
}
