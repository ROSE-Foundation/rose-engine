// Stories 8.3/8.6 — the position open/close + reconcile HTTP contract proven IN-PROCESS via Fastify
// `inject` against a FAKE `PositionService` (the boundary stays decoupled from the chain/DB; the real
// auto-confirm loop is proven in `paper-position-service.test.ts`). Asserts: the pending
// `OpenPositionView`/`ClosePositionView` shapes with money as a smallest-units STRING (NFR-2); the
// headline §11.4 guardrail refusal → 409 `SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED` carrying the
// named rule (UX-DR5); a malformed body → 400 (Zod); a missing service → 503 (refuse-if-absent). NO
// DB, NO chain, NO secret.
import {
  SolvencyGuardrailError,
  type ClosePositionInput,
  type ClosePositionView,
  type OpenPositionInput,
  type OpenPositionView,
  type PositionService,
} from '@rose/positions';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RoseDb } from '@rose/ledger';
import { buildApp } from './app.js';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIR_ID = '22222222-2222-4222-8222-222222222222';
const POSITION_ID = '33333333-3333-4333-8333-333333333333';
const COUNTERPARTY_POSITION_ID = '44444444-4444-4444-8444-444444444444';

// The app never touches `db` in these tests (the fake service answers), so a bare stub satisfies the type.
const DB_STUB = {} as RoseDb;

function openView(over: Partial<OpenPositionView> = {}): OpenPositionView {
  return {
    id: 'open-1',
    coupledPairId: PAIR_ID,
    owner: ALICE,
    side: 'LONG',
    amount: 100_000_000n,
    paymentAsset: 'EUR',
    status: 'pending',
    txHash: '0xfeed',
    journalEntryId: null,
    position: null,
    ...over,
  };
}

function closeView(over: Partial<ClosePositionView> = {}): ClosePositionView {
  return {
    id: 'close-1',
    positionId: POSITION_ID,
    coupledPairId: PAIR_ID,
    owner: ALICE,
    amount: 100_000_000n,
    paymentAsset: 'EUR',
    status: 'pending',
    txHash: '0xbeef',
    journalEntryId: null,
    position: null,
    ...over,
  };
}

function fakeService(behavior: {
  onOpen?: (input: OpenPositionInput) => OpenPositionView | Promise<OpenPositionView>;
  onClose?: (input: ClosePositionInput) => ClosePositionView | Promise<ClosePositionView>;
  onGetOpen?: (id: string) => OpenPositionView | null;
  onGetClose?: (id: string) => ClosePositionView | null;
}): PositionService {
  return {
    async openPosition(input) {
      return behavior.onOpen ? behavior.onOpen(input) : openView();
    },
    async confirmOpen() {
      return null;
    },
    async getOpenPosition(id) {
      return behavior.onGetOpen ? behavior.onGetOpen(id) : null;
    },
    async closePosition(input) {
      return behavior.onClose ? behavior.onClose(input) : closeView();
    },
    async confirmClose() {
      return null;
    },
    async getClosePosition(id) {
      return behavior.onGetClose ? behavior.onGetClose(id) : null;
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const OPEN_BODY = {
  coupledPairId: PAIR_ID,
  owner: ALICE,
  side: 'LONG' as const,
  amount: '100000000',
  paymentAsset: 'EUR',
  idempotencyKey: 'open-1',
};

const CLOSE_BODY = {
  positionId: POSITION_ID,
  paymentAsset: 'EUR',
  idempotencyKey: 'close-1',
};

describe('POST /positions/open', () => {
  it('returns 200 with the pending OpenPositionView; amount is a smallest-units string (NFR-2)', async () => {
    let captured: OpenPositionInput | undefined;
    app = await buildApp({
      db: DB_STUB,
      positionService: fakeService({
        onOpen: (input) => {
          captured = input;
          return openView();
        },
      }),
    });
    const res = await app.inject({ method: 'POST', url: '/positions/open', payload: OPEN_BODY });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.amount).toBe('100000000');
    expect(typeof body.amount).toBe('string');
    expect(body.position).toBeNull(); // no optimistic success — no position until the commit point
    expect(res.payload).not.toContain('"amount":100000000'); // never a JS number
    // The route maps the body → service input: amount becomes a bigint, side passes through.
    expect(captured?.amount).toBe(100_000_000n);
    expect(captured?.side).toBe('LONG');
    expect(captured?.coupledPairId).toBe(PAIR_ID);
  });

  it('returns 400 (Zod) for a malformed body — a non-integer amount (NFR-2)', async () => {
    app = await buildApp({ db: DB_STUB, positionService: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: '/positions/open',
      payload: { ...OPEN_BODY, amount: '100.5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 (Zod) for an invalid side', async () => {
    app = await buildApp({ db: DB_STUB, positionService: fakeService({}) });
    const res = await app.inject({
      method: 'POST',
      url: '/positions/open',
      payload: { ...OPEN_BODY, side: 'UP' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 POSITION_SERVICE_UNAVAILABLE when no service is composed (refuse-if-absent)', async () => {
    app = await buildApp({ db: DB_STUB }); // no positionService
    const res = await app.inject({ method: 'POST', url: '/positions/open', payload: OPEN_BODY });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('POSITION_SERVICE_UNAVAILABLE');
  });
});

describe('POST /positions/close', () => {
  it('returns 200 with the pending ClosePositionView (amount is a string, NFR-2)', async () => {
    app = await buildApp({ db: DB_STUB, positionService: fakeService({}) });
    const res = await app.inject({ method: 'POST', url: '/positions/close', payload: CLOSE_BODY });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.positionId).toBe(POSITION_ID);
    expect(typeof body.amount).toBe('string');
  });

  it('refuses the §11.4 D1 single-side close → 409 SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED, named rule (UX-DR5)', async () => {
    app = await buildApp({
      db: DB_STUB,
      positionService: fakeService({
        onClose: () => {
          throw new SolvencyGuardrailError({
            positionId: POSITION_ID,
            coupledPairId: PAIR_ID,
            side: 'LONG',
            counterpartyOwner: BOB,
            counterpartyPositionId: COUNTERPARTY_POSITION_ID,
          });
        },
      }),
    });
    const res = await app.inject({ method: 'POST', url: '/positions/close', payload: CLOSE_BODY });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SOLVENCY_GUARDRAIL_SINGLE_SIDE_CLOSE_REFUSED');
    // The refusal NAMES the §11.4 guardrail rule so the surface can name it to the operator.
    expect(res.json().error.message).toContain('§11.4 solvency guardrail');
  });

  it('returns 503 when no service is composed', async () => {
    app = await buildApp({ db: DB_STUB });
    const res = await app.inject({ method: 'POST', url: '/positions/close', payload: CLOSE_BODY });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('POSITION_SERVICE_UNAVAILABLE');
  });
});

describe('GET /positions/open/:id and /positions/close/:id', () => {
  it('returns 200 (confirmed) and 404 when absent', async () => {
    app = await buildApp({
      db: DB_STUB,
      positionService: fakeService({
        onGetOpen: (id) =>
          id === 'open-1' ? openView({ status: 'confirmed', journalEntryId: 'je-1' }) : null,
        onGetClose: (id) =>
          id === 'close-1' ? closeView({ status: 'confirmed', journalEntryId: 'je-2' }) : null,
      }),
    });
    const open = await app.inject({ method: 'GET', url: '/positions/open/open-1' });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({
      id: 'open-1',
      status: 'confirmed',
      journalEntryId: 'je-1',
    });

    const close = await app.inject({ method: 'GET', url: '/positions/close/close-1' });
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({ id: 'close-1', status: 'confirmed' });

    const missing = await app.inject({ method: 'GET', url: '/positions/open/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 503 when no service is composed', async () => {
    app = await buildApp({ db: DB_STUB });
    const res = await app.inject({ method: 'GET', url: '/positions/open/open-1' });
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /positions/reconcile (read-only gating)', () => {
  it('returns 503 when no service is composed (paper-only operator route)', async () => {
    app = await buildApp({ db: DB_STUB });
    const res = await app.inject({ method: 'POST', url: '/positions/reconcile' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('POSITION_SERVICE_UNAVAILABLE');
  });
});

describe('OpenAPI — the position write/reconcile paths are derived from the Zod schemas', () => {
  it('lists the open/close/reconcile paths with a string amount', async () => {
    app = await buildApp({ db: DB_STUB, positionService: fakeService({}) });
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/positions/open',
        '/positions/close',
        '/positions/open/{id}',
        '/positions/close/{id}',
        '/positions/reconcile',
      ]),
    );
    const openSchema =
      doc.paths['/positions/open'].post.responses['200'].content['application/json'].schema;
    expect(openSchema.properties.amount.type).toBe('string');
  });
});
