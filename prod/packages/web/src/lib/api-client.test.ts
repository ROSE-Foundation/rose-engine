// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from './api-client.js';
import type { GroupViewResponse } from './contract-types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const emptyGroupView: GroupViewResponse = {
  generatedAt: '2026-06-16T12:00:00.000Z',
  source: 'ledger-only',
  entities: [],
  consolidated: [],
  coupledPairs: [],
  covenants: [],
  netExposure: [],
  coupledCoinBook: [],
  chainComparison: { source: 'ledger-only', divergences: [], anyDivergence: false },
  notes: [],
};

describe('createApiClient', () => {
  it('returns the typed body on a 200 and calls the boundary path with the base URL', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(emptyGroupView));
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    const view = await client.getGroupView();
    expect(view.source).toBe('ledger-only');
    expect(fetchFn).toHaveBeenCalledWith('http://api.local/group-view', expect.anything());
  });

  it('parses the structured error envelope into an ApiClientError carrying the machine code', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 'AUTHORIZATION_DENIED', message: 'Refused.' } }, 403),
    );
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    await expect(client.getCoupledPair('abc')).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'AUTHORIZATION_DENIED',
      status: 403,
    });
  });

  it('falls back to a generic code when the error body is not JSON', async () => {
    const fetchFn = vi.fn(
      async () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    const err = await client.getGroupView().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('REQUEST_FAILED');
  });

  it('subscribe POSTs the smallest-units string amount unchanged and returns the typed body (201)', async () => {
    const pending = {
      id: 'idem-1',
      roseNoteId: 'note-1',
      coupledPairId: 'pair-1',
      subscriber: '0x' + 'a'.repeat(40),
      amount: '100000',
      paymentAsset: 'EUR',
      status: 'pending' as const,
      txHash: null,
      journalEntryId: null,
    };
    const fetchFn = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(pending, 201),
    );
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    const res = await client.subscribe('note-1', {
      subscriber: '0x' + 'a'.repeat(40),
      amount: '100000',
      paymentAsset: 'EUR',
      idempotencyKey: 'idem-1',
    });
    expect(res.status).toBe('pending');
    expect(res.amount).toBe('100000');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://api.local/rose-notes/note-1/subscriptions');
    expect(init?.method).toBe('POST');
    // NFR-2: the amount is forwarded as the smallest-units STRING — no float coercion.
    expect(String(init?.body)).toContain('"amount":"100000"');
  });

  it('surfaces a 403 eligibility refusal from subscribe as a typed ApiClientError (named rule)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 'AUTHORIZATION_DENIED', message: 'Not eligible.' } }, 403),
    );
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    await expect(
      client.subscribe('note-1', {
        subscriber: '0x' + 'b'.repeat(40),
        amount: '1',
        paymentAsset: 'EUR',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ name: 'ApiClientError', code: 'AUTHORIZATION_DENIED', status: 403 });
  });

  it('surfaces a 422 REFUSE refusal from redeem as a typed ApiClientError', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 'NotDeltaNeutralError', message: 'Refused.' } }, 422),
    );
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    await expect(
      client.redeem('note-1', {
        redeemer: '0x' + 'c'.repeat(40),
        amount: '5',
        paymentAsset: 'EUR',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ name: 'ApiClientError', code: 'NotDeltaNeutralError', status: 422 });
  });

  it('surfaces a 503 refuse-if-absent when the write service is not composed', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'SUBSCRIPTION_SERVICE_UNAVAILABLE', message: 'Not wired.' } },
        503,
      ),
    );
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    await expect(
      client.subscribe('note-1', {
        subscriber: '0x' + 'd'.repeat(40),
        amount: '1',
        paymentAsset: 'EUR',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_SERVICE_UNAVAILABLE', status: 503 });
  });

  it('reads a subscription status (pending until the commit point)', async () => {
    const body = {
      id: 'idem-1',
      roseNoteId: 'note-1',
      coupledPairId: 'pair-1',
      subscriber: '0x' + 'a'.repeat(40),
      amount: '100000',
      paymentAsset: 'EUR',
      status: 'pending' as const,
      txHash: '0xdeadbeef',
      journalEntryId: null,
    };
    const fetchFn = vi.fn(async () => jsonResponse(body));
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    const res = await client.getSubscription('idem-1');
    expect(res.status).toBe('pending');
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.local/subscriptions/idem-1',
      expect.anything(),
    );
  });

  it('reads a rose note (the subscriber position handle)', async () => {
    const note = {
      id: 'note-1',
      coupledPairId: 'pair-1',
      createdAt: '2026-06-16T10:00:00.000Z',
      updatedAt: '2026-06-16T12:00:00.000Z',
    };
    const fetchFn = vi.fn(async () => jsonResponse(note));
    const client = createApiClient({ baseUrl: 'http://api.local', fetchFn });
    const res = await client.getRoseNote('note-1');
    expect(res.coupledPairId).toBe('pair-1');
    expect(fetchFn).toHaveBeenCalledWith('http://api.local/rose-notes/note-1', expect.anything());
  });
});
