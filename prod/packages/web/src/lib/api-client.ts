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

  const enc = encodeURIComponent;

  return {
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
  };
}

/** The runtime base URL (env-driven, local default — no secret). */
export function resolveApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
}
