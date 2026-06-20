import type {
  ClosePositionRequest,
  ClosePositionView,
  CoupledPairResponse,
  EngineModeInfo,
  FaithfulConfirmationSettingsUpdate,
  FaithfulConfirmationSettingsView,
  GroupViewResponse,
  OnboardingRequest,
  OnboardingState,
  OpenPositionRequest,
  OpenPositionView,
  OperatorInjectionState,
  OperatorInjectionUpdate,
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

/**
 * A typed error carrying the boundary's machine `code` (UX-DR5) so a surface can NAME the refusing
 * rule to the operator instead of showing a generic failure.
 */
export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The surface the front-end consumes (paper/local `@rose/api`): the operator READS (Story 6.5) plus
 * the Subscriber WRITES + status reads (Story 6.6 — subscribe/redeem via Review→Confirm + pending).
 */
export interface ApiClient {
  /**
   * Report the running engine mode + an honest real-vs-mocked summary (Story 9.6, FR-33). Always
   * available (never 503-gated) — read by the always-visible global mode banner.
   */
  getEngineMode(): Promise<EngineModeInfo>;
  getGroupView(): Promise<GroupViewResponse>;
  getCoupledPair(id: string): Promise<CoupledPairResponse>;
  getRoseNote(id: string): Promise<RoseNoteResponse>;
  /** Subscribe to a Rose Note (paired mint) — the `amount` is a smallest-units STRING (NFR-2). */
  subscribe(roseNoteId: string, body: SubscribeRequest): Promise<SubscriptionResponse>;
  /** Redeem a Rose Note (paired burn) — the `amount` is a smallest-units STRING (NFR-2). */
  redeem(roseNoteId: string, body: RedeemRequest): Promise<RedemptionResponse>;
  /** Read a subscription status — `pending` until the on-chain commit point, then `confirmed`. */
  getSubscription(id: string): Promise<SubscriptionResponse>;
  /** Read a redemption status — `pending` until the on-chain commit point, then `confirmed`. */
  getRedemption(id: string): Promise<RedemptionResponse>;
  /** List a user's positions with live marks + P&L (Story 8.4, FR-26). */
  getPositions(owner: string, opts?: { referenceAsset?: string }): Promise<PositionsResponse>;
  /**
   * Open a directional position (paired mint over subscribe/mint, Story 8.3). The flow returns
   * `pending` on the POST and a follow-up `getOpenPositionFlow` flips it to `confirmed` (UX-DR6).
   */
  openPosition(body: OpenPositionRequest): Promise<OpenPositionView>;
  /**
   * Close a position (paired burn, Stories 8.3/8.6). A D1 single-side close is refused with a typed
   * 409 `SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` (§11.4) the surface NAMES (UX-DR5).
   */
  closePosition(body: ClosePositionRequest): Promise<ClosePositionView>;
  /** Read a position-open flow status — `pending` until the on-chain commit point, then `confirmed`. */
  getOpenPositionFlow(id: string): Promise<OpenPositionView>;
  /** Read a position-close flow status — `pending` until the on-chain commit point, then `confirmed`. */
  getClosePositionFlow(id: string): Promise<ClosePositionView>;
  /** Operator position↔pair reconciliation report (Story 8.5, FR-27; report-only). */
  reconcilePositions(): Promise<PositionReconciliationReport>;
  /**
   * Read the paper-mode replay-feed simulation parameters (amplitude + cycle period + bounds + version).
   * A non-paper deployment refuses with a typed 503 `SIMULATION_SETTINGS_UNAVAILABLE`.
   */
  getSimulationSettings(): Promise<SimulationSettingsView>;
  /**
   * Tune the paper-mode replay-feed parameters (any subset). Out-of-range / non-finite values refuse
   * with a typed 400 `SimulationSettingsError`; a non-paper deployment refuses with a 503.
   */
  updateSimulationSettings(patch: SimulationSettingsUpdate): Promise<SimulationSettingsView>;
  /**
   * Read an address's faithful-mode KYC/AML onboarding state. A non-faithful deployment refuses with a
   * typed 503 `FAITHFUL_ONBOARDING_UNAVAILABLE` the surface NAMES (the control shows a faithful-only note).
   */
  getOnboardingState(address: string): Promise<OnboardingState>;
  /**
   * Onboard or revoke an address in the faithful-mode mock KYC/AML registry. A malformed address ⇒ 400;
   * a non-faithful deployment ⇒ 503.
   */
  setOnboarding(body: OnboardingRequest): Promise<OnboardingState>;
  // ─── Operator control panel (Story 9.5, FR-32) — faithful-mode injections ─────────────────────
  /**
   * Read the faithful async-confirmation settings the operator panel tunes (latency + failure
   * injection). A non-faithful deployment refuses with a typed 503 `OPERATOR_CONFIRMATION_UNAVAILABLE`.
   */
  getConfirmationSettings(): Promise<FaithfulConfirmationSettingsView>;
  /**
   * Inject a confirmation latency / failure-rate / "fail next" one-shot (any subset). Out-of-range ⇒
   * a typed 400 `FaithfulConfirmationSettingsError`; a non-faithful deployment ⇒ 503.
   */
  updateConfirmationSettings(
    patch: FaithfulConfirmationSettingsUpdate,
  ): Promise<FaithfulConfirmationSettingsView>;
  /** Read the covenant-breach injection state. Non-faithful ⇒ 503 `OPERATOR_COVENANT_UNAVAILABLE`. */
  getCovenantBreach(): Promise<OperatorInjectionState>;
  /** Force / clear a genuine covenant BREACH on the group-view monitor. Non-faithful ⇒ 503. */
  setCovenantBreach(body: OperatorInjectionUpdate): Promise<OperatorInjectionState>;
  /** Read the reconcile-divergence injection state. Non-faithful ⇒ 503 `OPERATOR_RECONCILE_UNAVAILABLE`. */
  getReconcileDivergence(): Promise<OperatorInjectionState>;
  /** Arm / clear a position↔pair reconciliation divergence on the next reconcile. Non-faithful ⇒ 503. */
  setReconcileDivergence(body: OperatorInjectionUpdate): Promise<OperatorInjectionState>;
}

/** The structured error envelope the boundary returns (`{ error: { code, message } }`). */
interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/**
 * Build a `fetch`-based client against the typed REST boundary. `baseUrl` comes from
 * `VITE_API_BASE_URL` with a local default — NO secret is baked in. `fetchFn` is injectable so
 * tests exercise the client with NO network. A non-2xx response is parsed into an `ApiClientError`
 * carrying the boundary's machine `code`.
 */
export function createApiClient({
  baseUrl,
  fetchFn = globalThis.fetch,
}: {
  baseUrl: string;
  fetchFn?: typeof fetch;
}): ApiClient {
  /** Parse a non-2xx response into a typed `ApiClientError` carrying the boundary's machine `code`. */
  async function toError(res: Response): Promise<ApiClientError> {
    let code = 'REQUEST_FAILED';
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as ErrorEnvelope;
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the generic code/message.
    }
    return new ApiClientError(code, message, res.status);
  }

  async function get<T>(path: string): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  // POST the body verbatim — the `amount` stays a smallest-units STRING (NFR-2), no float coercion.
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  // PUT the body verbatim — used for the simulation settings patch (plain numbers, NOT money).
  async function put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  const enc = encodeURIComponent;

  return {
    getEngineMode: () => get<EngineModeInfo>('/mode'),
    getGroupView: () => get<GroupViewResponse>('/group-view'),
    getCoupledPair: (id: string) => get<CoupledPairResponse>(`/coupled-pairs/${enc(id)}`),
    getRoseNote: (id: string) => get<RoseNoteResponse>(`/rose-notes/${enc(id)}`),
    subscribe: (roseNoteId: string, body: SubscribeRequest) =>
      post<SubscriptionResponse>(`/rose-notes/${enc(roseNoteId)}/subscriptions`, body),
    redeem: (roseNoteId: string, body: RedeemRequest) =>
      post<RedemptionResponse>(`/rose-notes/${enc(roseNoteId)}/redemptions`, body),
    getSubscription: (id: string) => get<SubscriptionResponse>(`/subscriptions/${enc(id)}`),
    getRedemption: (id: string) => get<RedemptionResponse>(`/redemptions/${enc(id)}`),
    getPositions: (owner: string, opts?: { referenceAsset?: string }) => {
      const params = new URLSearchParams({ owner });
      if (opts?.referenceAsset) params.set('referenceAsset', opts.referenceAsset);
      return get<PositionsResponse>(`/positions?${params.toString()}`);
    },
    openPosition: (body: OpenPositionRequest) => post<OpenPositionView>('/positions/open', body),
    closePosition: (body: ClosePositionRequest) =>
      post<ClosePositionView>('/positions/close', body),
    getOpenPositionFlow: (id: string) => get<OpenPositionView>(`/positions/open/${enc(id)}`),
    getClosePositionFlow: (id: string) => get<ClosePositionView>(`/positions/close/${enc(id)}`),
    // The reconcile route takes NO body; POST an empty object (the boundary ignores it).
    reconcilePositions: () => post<PositionReconciliationReport>('/positions/reconcile', {}),
    getSimulationSettings: () => get<SimulationSettingsView>('/simulation/settings'),
    updateSimulationSettings: (patch: SimulationSettingsUpdate) =>
      put<SimulationSettingsView>('/simulation/settings', patch),
    getOnboardingState: (address: string) =>
      get<OnboardingState>(`/faithful/onboarding/${enc(address)}`),
    setOnboarding: (body: OnboardingRequest) => post<OnboardingState>('/faithful/onboarding', body),
    getConfirmationSettings: () => get<FaithfulConfirmationSettingsView>('/operator/confirmation'),
    updateConfirmationSettings: (patch: FaithfulConfirmationSettingsUpdate) =>
      put<FaithfulConfirmationSettingsView>('/operator/confirmation', patch),
    getCovenantBreach: () => get<OperatorInjectionState>('/operator/covenant-breach'),
    setCovenantBreach: (body: OperatorInjectionUpdate) =>
      put<OperatorInjectionState>('/operator/covenant-breach', body),
    getReconcileDivergence: () => get<OperatorInjectionState>('/operator/reconcile-divergence'),
    setReconcileDivergence: (body: OperatorInjectionUpdate) =>
      put<OperatorInjectionState>('/operator/reconcile-divergence', body),
  };
}

/** The runtime base URL (env-driven, local default — no secret). */
export function resolveApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
}
