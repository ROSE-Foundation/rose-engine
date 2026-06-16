// Story 6.3 — the redemption HTTP contract proven IN-PROCESS via Fastify `inject` with a FAKE
// `RedemptionService` (the boundary stays decoupled from the chain; the real loop is proven in
// `@rose/rose-note`). The INVERSE mirror of the 6.2 subscription HTTP test. Asserts: the pending →
// confirmed `RedemptionSchema` shape with money as a smallest-units STRING (NFR-2), authorization
// DENY → 403 / REFUSE → 422 (UX-DR5), a lifecycle/idempotency conflict → 409, a malformed body → 400
// (Zod), and a missing service → 503 (refuse-if-absent). NO DB, NO chain, NO secret.
import {
  RedemptionIdempotencyConflictError,
  RedemptionPairNotActiveError,
  type RedeemInput,
  type RedemptionService,
  type RedemptionView,
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

function pendingView(over: Partial<RedemptionView> = {}): RedemptionView {
  return {
    id: 'red-1',
    roseNoteId: NOTE_ID,
    coupledPairId: PAIR_ID,
    redeemer: ALICE,
    amount: 10_000n,
    paymentAsset: 'EUR',
    status: 'pending',
    txHash: '0xfeed',
    journalEntryId: null,
    ...over,
  };
}

/** A configurable fake service: records the last redeem input and returns/throws as told. */
function fakeService(behavior: {
  onRedeem?: (input: RedeemInput) => RedemptionView | Promise<RedemptionView>;
  onGet?: (id: string) => RedemptionView | null;
}): RedemptionService {
  return {
    async redeem(input) {
      if (behavior.onRedeem) return behavior.onRedeem(input);
      return pendingView();
    },
    async confirm() {
      return null;
    },
    async getRedemption(id) {
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
  redeemer: ALICE,
  amount: '10000',
  paymentAsset: 'EUR',
  idempotencyKey: 'red-1',
};

describe('POST /rose-notes/:id/redemptions', () => {
  it('returns 201 with the pending RedemptionSchema; amount is a smallest-units string (NFR-2)', async () => {
    let captured: RedeemInput | undefined;
    app = await buildApp({
      db: DB_STUB,
      redemptions: fakeService({
        onRedeem: (input) => {
          captured = input;
          return pendingView();
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.amount).toBe('10000'); // STRING over the wire (NFR-2)
    expect(typeof body.amount).toBe('string');
    expect(body.journalEntryId).toBeNull();
    expect(res.payload).not.toContain('"amount":10000'); // never a JS number
    expect(captured?.amount).toBe(10_000n);
    expect(captured?.roseNoteId).toBe(NOTE_ID);
    expect(captured?.redeemer).toBe(ALICE);
  });

  it('surfaces a capital-flow authorization DENY as 403 (UX-DR5)', async () => {
    app = await buildApp({
      db: DB_STUB,
      redemptions: fakeService({
        onRedeem: () => {
          const e = Object.assign(new Error('Burn not authorized (DENY): default-deny'), {
            name: 'BurnAuthorizationError',
            effect: 'DENY',
            reason: 'default-deny',
          });
          throw e;
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('surfaces a capital-flow authorization REFUSE as 422 (UX-DR5)', async () => {
    app = await buildApp({
      db: DB_STUB,
      redemptions: fakeService({
        onRedeem: () => {
          const e = Object.assign(new Error('Burn not authorized (REFUSE): model-A bright line'), {
            name: 'BurnAuthorizationError',
            effect: 'REFUSE',
            reason: 'model-A bright line',
          });
          throw e;
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AUTHORIZATION_REFUSED');
  });

  it('returns 409 for a lifecycle conflict (pair not active)', async () => {
    app = await buildApp({
      db: DB_STUB,
      redemptions: fakeService({
        onRedeem: () => {
          throw new RedemptionPairNotActiveError(PAIR_ID, 'PENDING');
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RedemptionPairNotActiveError');
  });

  it('returns 409 for a reused idempotency key with a different request', async () => {
    app = await buildApp({
      db: DB_STUB,
      redemptions: fakeService({
        onRedeem: () => {
          throw new RedemptionIdempotencyConflictError('red-1');
        },
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RedemptionIdempotencyConflictError');
  });

  it('returns 400 (Zod) for a malformed body — a non-integer amount (NFR-2)', async () => {
    app = await buildApp({ db: DB_STUB, redemptions: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: { ...VALID_BODY, amount: '100.5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 (Zod) for a non-positive amount ("0") — rejected at the boundary', async () => {
    app = await buildApp({ db: DB_STUB, redemptions: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: { ...VALID_BODY, amount: '0' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 (Zod) for a malformed redeemer address', async () => {
    app = await buildApp({ db: DB_STUB, redemptions: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: { ...VALID_BODY, redeemer: 'not-an-address' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 REDEMPTION_SERVICE_UNAVAILABLE when no service is composed (refuse-if-absent)', async () => {
    app = await buildApp({ db: DB_STUB }); // no `redemptions`
    const res = await app.inject({
      method: 'POST',
      url: `/rose-notes/${NOTE_ID}/redemptions`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('REDEMPTION_SERVICE_UNAVAILABLE');
  });
});

describe('GET /redemptions/:id', () => {
  it('returns 200 with the redemption (pending then confirmed) and 404 when absent', async () => {
    app = await buildApp({
      db: DB_STUB,
      redemptions: fakeService({
        onGet: (id) =>
          id === 'red-1' ? pendingView({ status: 'confirmed', journalEntryId: 'je-1' }) : null,
      }),
    });
    const ok = await app.inject({ method: 'GET', url: '/redemptions/red-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: 'red-1',
      status: 'confirmed',
      amount: '10000',
      journalEntryId: 'je-1',
    });

    const missing = await app.inject({ method: 'GET', url: '/redemptions/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 503 when no service is composed', async () => {
    app = await buildApp({ db: DB_STUB });
    const res = await app.inject({ method: 'GET', url: '/redemptions/red-1' });
    expect(res.statusCode).toBe(503);
  });
});

describe('OpenAPI — the redemption paths are derived from the Zod schemas', () => {
  it('lists POST /rose-notes/{id}/redemptions and GET /redemptions/{id} with a string amount', async () => {
    app = await buildApp({ db: DB_STUB, redemptions: fakeService({}) });
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/rose-notes/{id}/redemptions', '/redemptions/{id}']),
    );
    const okSchema =
      doc.paths['/redemptions/{id}'].get.responses['200'].content['application/json'].schema;
    expect(okSchema.properties.amount.type).toBe('string');
  });
});
