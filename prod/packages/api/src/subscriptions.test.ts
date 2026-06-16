// Story 6.2 — the subscription HTTP contract proven IN-PROCESS via Fastify `inject` with a FAKE
// `SubscriptionService` (the boundary stays decoupled from the chain; the real loop is proven in
// `@rose/rose-note`). Asserts: the pending → confirmed `SubscriptionSchema` shape with money as a
// smallest-units STRING (NFR-2), eligibility refusal → 403 with the named reason (UX-DR5), a
// malformed body → 400 (Zod), an idempotency/lifecycle conflict → 409, and a missing service → 503
// (refuse-if-absent). NO DB, NO chain, NO secret.
import {
  IneligibleSubscriberError,
  SubscriptionIdempotencyConflictError,
  type SubscribeInput,
  type SubscriptionService,
  type SubscriptionView,
} from '@rose/rose-note';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { RoseDb } from '@rose/ledger';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const PAIR_ID = '22222222-2222-4222-8222-222222222222';

// The app never touches `db` in these tests (the fake service answers), so a bare stub satisfies the type.
const DB_STUB = {} as RoseDb;

function pendingView(over: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    id: 'sub-1',
    roseNoteId: NOTE_ID,
    coupledPairId: PAIR_ID,
    subscriber: ALICE,
    amount: 10_000n,
    paymentAsset: 'EUR',
    status: 'pending',
    txHash: '0xfeed',
    journalEntryId: null,
    ...over,
  };
}

/** A configurable fake service: records the last subscribe input and returns/throws as told. */
function fakeService(behavior: {
  onSubscribe?: (input: SubscribeInput) => SubscriptionView | Promise<SubscriptionView>;
  onGet?: (id: string) => SubscriptionView | null;
}): SubscriptionService {
  return {
    async subscribe(input) {
      if (behavior.onSubscribe) return behavior.onSubscribe(input);
      return pendingView();
    },
    async confirm() {
      return null;
    },
    async getSubscription(id) {
      return behavior.onGet ? behavior.onGet(id) : null;
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const VALID_BODY = {
  subscriber: ALICE,
  amount: '10000',
  paymentAsset: 'EUR',
  idempotencyKey: 'sub-1',
};

describe('POST /rose-notes/:id/subscriptions', () => {
  it('returns 201 with the pending SubscriptionSchema; amount is a smallest-units string (NFR-2)', async () => {
    let captured: SubscribeInput | undefined;
    app = await buildApp({
      db: DB_STUB,
      subscriptions: fakeService({
        onSubscribe: (input) => {
          captured = input;
          return pendingView();
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.amount).toBe('10000'); // STRING over the wire (NFR-2)
    expect(typeof body.amount).toBe('string');
    expect(body.journalEntryId).toBeNull();
    expect(res.payload).not.toContain('"amount":10000'); // never a JS number
    // The route maps the body → service input: amount becomes a bigint, the note id comes from the path.
    expect(captured?.amount).toBe(10_000n);
    expect(captured?.roseNoteId).toBe(NOTE_ID);
  });

  it('surfaces an eligibility refusal as 403 SUBSCRIBER_NOT_ELIGIBLE with the named reason (UX-DR5)', async () => {
    app = await buildApp({
      db: DB_STUB,
      subscriptions: fakeService({
        onSubscribe: () => {
          throw new IneligibleSubscriberError(ALICE, 'no valid ONCHAINID claim');
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIBER_NOT_ELIGIBLE');
    expect(res.json().error.message).toContain('ONCHAINID');
  });

  it('returns 409 for a lifecycle conflict (pair not active)', async () => {
    app = await buildApp({
      db: DB_STUB,
      subscriptions: fakeService({
        onSubscribe: () => {
          const e = new Error('pair not active');
          e.name = 'SubscriptionPairNotActiveError';
          throw e;
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 (Zod) for a malformed body — a non-integer amount (NFR-2)', async () => {
    app = await buildApp({ db: DB_STUB, subscriptions: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: { ...VALID_BODY, amount: '100.5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 (Zod) for a non-positive amount ("0") — rejected at the boundary, not deferred', async () => {
    app = await buildApp({ db: DB_STUB, subscriptions: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: { ...VALID_BODY, amount: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 for a reused idempotency key with a different request', async () => {
    app = await buildApp({
      db: DB_STUB,
      subscriptions: fakeService({
        onSubscribe: () => {
          throw new SubscriptionIdempotencyConflictError('sub-1');
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SubscriptionIdempotencyConflictError');
  });

  it('returns 400 (Zod) for a malformed subscriber address', async () => {
    app = await buildApp({ db: DB_STUB, subscriptions: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: { ...VALID_BODY, subscriber: 'not-an-address' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 SUBSCRIPTION_SERVICE_UNAVAILABLE when no service is composed (refuse-if-absent)', async () => {
    app = await buildApp({ db: DB_STUB }); // no `subscriptions`
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/subscriptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SUBSCRIPTION_SERVICE_UNAVAILABLE');
  });
});

describe('GET /subscriptions/:id', () => {
  it('returns 200 with the subscription (pending then confirmed) and 404 when absent', async () => {
    app = await buildApp({
      db: DB_STUB,
      subscriptions: fakeService({
        onGet: (id) =>
          id === 'sub-1' ? pendingView({ status: 'confirmed', journalEntryId: 'je-1' }) : null,
      }),
    });
    const ok = await app.inject({ method: 'GET', url: '/subscriptions/sub-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: 'sub-1',
      status: 'confirmed',
      amount: '10000',
      journalEntryId: 'je-1',
    });

    const missing = await app.inject({ method: 'GET', url: '/subscriptions/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 503 when no service is composed', async () => {
    app = await buildApp({ db: DB_STUB });
    const res = await app.inject({ method: 'GET', url: '/subscriptions/sub-1' });
    expect(res.statusCode).toBe(503);
  });
});

describe('OpenAPI — the subscription paths are derived from the Zod schemas', () => {
  it('lists POST /rose-notes/{id}/subscriptions and GET /subscriptions/{id} with a string amount', async () => {
    app = await buildApp({ db: DB_STUB, subscriptions: fakeService({}) });
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/rose-notes/{id}/subscriptions', '/subscriptions/{id}']),
    );
    const okSchema =
      doc.paths['/subscriptions/{id}'].get.responses['200'].content['application/json'].schema;
    expect(okSchema.properties.amount.type).toBe('string');
  });
});
